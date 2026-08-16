import { afterEach, describe, expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { FixturePlatform, publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { withCacheWrite, type CacheWriteService } from "@ax/lib/duckdb/seam";
import { withIngestLock } from "@ax/lib/ingest-lock";
import { DUCKDB_SCHEMA_SQL } from "@ax/schema/duckdb-ddl";
import { HOOK_FIRE_SPOOL_FILE, type HookFireSpoolEnvelope, type HookFireSpoolRow } from "../hooks/spool.ts";
import { drainHookFireSpool, hookFireSpoolStage } from "./hook-fire-spool.ts";

// `requireFts: true` because the drain cases publish through
// `publishCacheFixture`, which builds the FTS indexes for EVERY fixture - so
// this suite needs an FTS-capable libduckdb even though it never searches.
// Without the declaration the suite skips silently on a non-FTS dylib instead
// of failing once, actionably (scripts/check-ci-duckdb.test.ts enforces it).
const { dylibPath, dtest, tempDir } = await duckdbTestSetup("hook fire spool drain", {
    requireFts: true,
});
const roots: string[] = [];

afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const row = (id: string): HookFireSpoolRow => ({
    id,
    ts: "2026-08-15T10:00:00.000Z",
    kind: "hook_fire",
    session: "session:s1",
    file: null,
    file_path: "src/a.ts",
    harness: "claude",
    ok: true,
    latency_ms: 7,
    event: "read",
    inject: true,
    reason: "high_signal",
    prior_sessions_considered: 1,
    task_excerpt: "read a file",
    top_prior_sessions: ["session:s0"],
    injected_titles: ["Earlier fix"],
});

const envelope = (value: HookFireSpoolRow): string =>
    JSON.stringify({ v: 1, row: value } satisfies HookFireSpoolEnvelope);

describe("hook-fire-spool ingest stage", () => {
    dtest(
        "skips a torn tail and upserts a complete line on every drain",
        async () => {
            const spoolDir = await mkdtemp(join(tmpdir(), "ax-hook-drain-"));
            roots.push(spoolDir);
            await mkdir(spoolDir, { recursive: true });
            await writeFile(join(spoolDir, HOOK_FIRE_SPOOL_FILE), `${envelope(row("stable-row"))}\n{"v":1,"row":`);

            let first: Awaited<ReturnType<typeof drainResult>> | undefined;
            let second: Awaited<ReturnType<typeof drainResult>> | undefined;
            let count = -1;
            let stored: Readonly<Record<string, unknown>> | undefined;

            await runWithPlatform(
                publishCacheFixture(tempDir("ax-hook-drain-db-"), dylibPath, (write) =>
                    Effect.gen(function* () {
                        first = yield* drainHookFireSpool(write, { spoolDir }).pipe(Effect.provide(FixturePlatform));
                        second = yield* drainHookFireSpool(write, { spoolDir }).pipe(Effect.provide(FixturePlatform));
                        const counts = yield* write.raw("SELECT count(*) AS total FROM hook_fire");
                        count = Number(counts.rows[0]?.total ?? -1);
                        stored = (yield* write.raw("SELECT * FROM hook_fire WHERE id = ?", ["stable-row"])).rows[0];
                    }),
                ),
            );

            expect(first).toEqual({ files: 1, rows: 1, malformed: 1 });
            expect(second).toEqual({ files: 1, rows: 1, malformed: 1 });
            expect(count).toBe(1);
            expect(stored).toMatchObject({
                id: "stable-row",
                session: "s1",
                top_prior_sessions: '["session:s0"]',
                injected_titles: '["Earlier fix"]',
            });
        },
        60_000,
    );

    dtest("declares the write-aware ingest stage", () => {
        expect(hookFireSpoolStage.meta.key).toBe("hook-fire-spool");
        expect(hookFireSpoolStage.meta.tags).toEqual(["ingest"]);
    });

    dtest(
        "replays all rows after a process dies during a partial drain",
        async () => {
            const root = await mkdtemp(join(tmpdir(), "ax-hook-drain-crash-"));
            roots.push(root);
            const spoolDir = join(root, "spool");
            await mkdir(spoolDir, { recursive: true });
            await writeFile(
                join(spoolDir, HOOK_FIRE_SPOOL_FILE),
                `${envelope(row("first"))}\n${envelope(row("second"))}\n`,
            );
            const livePath = join(root, "live.duckdb");
            const lockPath = join(root, "ingest.lock");
            const snapshot = join(root, "snapshot.duckdb");
            const crashMarker = join(root, "first-write-complete");
            const drainUrl = new URL("./hook-fire-spool.ts", import.meta.url).href;
            const code = `
            import { Effect, Layer } from "effect";
            import { BunFileSystem, BunPath } from "@effect/platform-bun";
            import { withCacheWrite } from "@ax/lib/duckdb/seam";
            import { withIngestLock } from "@ax/lib/ingest-lock";
            import { DUCKDB_SCHEMA_SQL } from "@ax/schema/duckdb-ddl";
            import { drainHookFireSpool } from ${JSON.stringify(drainUrl)};
            const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);
            const work = withCacheWrite({
                livePath: ${JSON.stringify(livePath)},
                lockPath: ${JSON.stringify(lockPath)},
                snapshotPath: ${JSON.stringify(snapshot)},
                schemaSql: DUCKDB_SCHEMA_SQL,
                assetPath: ${JSON.stringify(dylibPath)},
            }, (write) => {
                let writes = 0;
                const crashWrite = {
                    ...write,
                    put: (...args) => write.put(...args).pipe(Effect.tap(() => Effect.promise(async () => {
                        writes += 1;
                        if (writes === 1) {
                            await Bun.write(${JSON.stringify(crashMarker)}, "first write completed");
                            process.kill(process.pid, "SIGKILL");
                        }
                    }))),
                };
                return drainHookFireSpool(crashWrite, { spoolDir: ${JSON.stringify(spoolDir)} });
            });
            await Effect.runPromise(withIngestLock({
                lockPath: ${JSON.stringify(lockPath)},
                command: "hook-drain-crash-test",
                staleMs: 60_000,
                onBusy: () => Effect.die("unexpected busy lock"),
            }, work).pipe(Effect.provide(platform)));
        `;
            const child = Bun.spawnSync(["bun", "-e", code], {
                cwd: new URL("../..", import.meta.url).pathname,
                stdout: "pipe",
                stderr: "pipe",
            });
            expect(child.exitCode).not.toBe(0);
            if (!(await Bun.file(crashMarker).exists())) {
                throw new Error(`the crash child failed before its first write:\n${child.stderr.toString()}`);
            }
            expect(await Bun.file(crashMarker).text()).toBe("first write completed");

            let stored: ReadonlyArray<Readonly<Record<string, unknown>>> = [];
            await runWithPlatform(
                withIngestLock(
                    {
                        lockPath,
                        command: "hook-drain-replay-test",
                        staleMs: 60_000,
                        onBusy: () => Effect.die("dead child lock was not recovered"),
                    },
                    withCacheWrite(
                        {
                            livePath,
                            lockPath,
                            snapshotPath: snapshot,
                            schemaSql: DUCKDB_SCHEMA_SQL,
                            ...(dylibPath === null ? {} : { assetPath: dylibPath }),
                        },
                        (write) =>
                            Effect.gen(function* () {
                                yield* drainHookFireSpool(write, { spoolDir });
                                stored = (yield* write.raw(
                                    "SELECT id, count(*) AS copies FROM hook_fire GROUP BY id ORDER BY id",
                                )).rows;
                            }),
                    ),
                ),
            );

            expect(stored).toEqual([
                { id: "first", copies: 1n },
                { id: "second", copies: 1n },
            ]);
        },
        60_000,
    );
});

const drainResult = (write: CacheWriteService, spoolDir: string) =>
    Effect.runPromise(drainHookFireSpool(write, { spoolDir }).pipe(Effect.provide(FixturePlatform)));
