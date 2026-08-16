/**
 * `ax skills` command family, invoking every subcommand this chunk ported
 * plus its already-cache-routed siblings, with no SurrealDB reachable.
 *
 * TWO shapes, for the same reason retro-family-no-surreal.test.ts uses two:
 *
 * (A) `search` / `recent` / `taste` / `pairs` / `recovery` - ported by THIS
 *     commit, but `skillsRuntime`'s manifest still routes them through
 *     `"db"` (the RUNTIME_BY_COMMAND flip is a separate, deferred chunk,
 *     Ruling R34). `withDb` provides `LegacySurrealAppLayer`, whose
 *     `SurrealClientLive` is `Layer.effect` and awaits a real
 *     `db.connect()` with a 5s timeout AT LAYER CONSTRUCTION - so a spawned
 *     CLI against a dead port would time out on ROUTING before the ported
 *     code ever ran, proving nothing about this chunk's change. These call
 *     the exported command functions directly, with a real CacheRead
 *     (published DuckDB fixture) and the exact throwing `SurrealClient`
 *     sentinel `cli/index.ts`'s `withCache`/`withoutDb` provide in
 *     production - any access still fails loudly, by name.
 *
 * (B) `tag` / `by-role` / `roles` (skill-scoped) - already routed `"cache"`
 *     in the manifest before this chunk, so the spawned-CLI dead-port shape
 *     (recall-no-surreal.test.ts) genuinely discriminates for them: it
 *     spawns the real entrypoint with `AX_DB_URL` on a port nothing
 *     listens on.
 *
 * `stats` / `unused` / `bloat` / `loaded` / `weighted` / `classify` are not
 * exercised here: their data layer lives in `dashboard/skills-weighted.ts`,
 * `queries/skill-bloat.ts`, `queries/skill-loaded.ts`, `queries/skill-stats.ts`,
 * `queries/unused-skills.ts` - other chunks' scope, not touched by this one.
 */
import { describe, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { CacheReadLayer, type CacheWriteService } from "@ax/lib/duckdb/seam";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { cmdPairs, cmdRecent, cmdRecovery, cmdSearch, cmdTaste } from "./commands/skills.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("ax skills family (no surreal)", {
    requireFts: true,
});

const T = (iso: string): Date => new Date(iso);

/** The exact sentinel `withCache`/`withoutDb` provide in cli/index.ts: any
 *  property access throws immediately and by name. */
const throwingSurrealClient = (): SurrealClientShape =>
    new Proxy({} as SurrealClientShape, {
        get(_target, prop) {
            throw new Error(`SurrealClient.${String(prop)} accessed on the no-DB test layer`);
        },
    });

const buildLayer = async (
    corpus: (write: CacheWriteService) => Effect.Effect<unknown, unknown, never>,
    label: string,
) => {
    const fixture = await runWithPlatform(publishCacheFixture(tempDir(`${label}-`), dylibPath, corpus));
    const layer = Layer.mergeAll(
        CacheReadLayer({ snapshotPath: fixture.snapshotPath, ...(dylibPath === null ? {} : { assetPath: dylibPath }) }),
        Layer.succeed(SurrealClient, throwingSurrealClient()),
        Layer.merge(BunFileSystem.layer, BunPath.layer),
    );
    return layer;
};

const run = <A, E, R>(eff: Effect.Effect<A, E, R>, layer: Layer.Layer<R>): Promise<A> =>
    Effect.runPromise(eff.pipe(Effect.provide(layer), Effect.scoped));

const capture = async (fn: () => Promise<void>): Promise<string[]> => {
    const logged: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => { logged.push(msg); };
    try {
        await fn();
    } finally {
        console.log = origLog;
    }
    return logged;
};

const CORPUS = (w: CacheWriteService) =>
    Effect.gen(function* () {
        yield* w.putMany("skill", [
            { id: "skill-composto", name: "composto", scope: "user", dir_path: "/skills/composto", description: "token-efficient investigation", content_hash: "h1" },
            { id: "skill-tdd", name: "tdd", scope: "user", dir_path: "/skills/tdd", description: "test-driven development", content_hash: "h2" },
        ]);
        yield* w.put("session", { id: "session-a", source: "claude", project: "ax", cwd: "/w/ax" });
        yield* w.put("turn", { id: "turn-1", session: "session-a", seq: 1, ts: T("2026-08-15T10:00:00.000Z"), role: "assistant", has_tool_use: true, has_error: false });
        yield* w.put("invoked", { id: "inv-1", in_id: "turn-1", out_id: "skill-composto", ts: T("2026-08-15T10:00:00.000Z"), session: "session-a", turn_has_error: false, was_corrected: false });
        yield* w.put("skill_paired", { id: "pair-1", in_id: "skill-composto", out_id: "skill-tdd", count: 3, last_seen: T("2026-08-15T10:00:00.000Z") });
        yield* w.put("recovered_by", { id: "rec-1", in_id: "turn-1", out_id: "skill-composto", ts: T("2026-08-15T10:00:00.000Z") });
    });

describe("ax skills family - ported subcommands, direct-call against the cache with SurrealClient never reachable", () => {
    dtest("search matches by name substring, not Surreal", async () => {
        const layer = await buildLayer(CORPUS, "ax-skills-search");
        const logged = await capture(() => run(cmdSearch({ query: "compos", limit: 10 }), layer));
        expect(logged.join("\n")).toContain("composto");
    }, 60_000);

    dtest("recent reads invoked joined to skill + session from the cache, not Surreal", async () => {
        const layer = await buildLayer(CORPUS, "ax-skills-recent");
        const logged = await capture(() => run(cmdRecent({ limit: 10 }), layer));
        expect(logged.join("\n")).toContain("composto");
    }, 60_000);

    dtest("taste enumerates the full skill catalog (zero-score rows included), not Surreal", async () => {
        const layer = await buildLayer(CORPUS, "ax-skills-taste");
        const logged = await capture(() => run(cmdTaste({ limit: 10, includeTools: false }), layer));
        const out = logged.join("\n");
        expect(out).toContain("composto");
        // tdd has no invocations/proposals - issue #47's zero-score inclusion.
        expect(out).toContain("tdd");
    }, 60_000);

    dtest("pairs reads skill_paired joined to skill, not Surreal", async () => {
        const layer = await buildLayer(CORPUS, "ax-skills-pairs");
        const logged = await capture(() => run(cmdPairs({ name: "composto", limit: 10 }), layer));
        expect(logged.join("\n")).toContain("tdd");
    }, 60_000);

    dtest("recovery reads recovered_by joined to skill, not Surreal", async () => {
        const layer = await buildLayer(CORPUS, "ax-skills-recovery");
        const logged = await capture(() => run(cmdRecovery({ limit: 10 }), layer));
        expect(logged.join("\n")).toContain("composto");
    }, 60_000);
});

// ---------------------------------------------------------------------------
// Already cache-routed subcommands: the spawned-CLI dead-port shape
// genuinely discriminates for these (manifest already says "cache").
// ---------------------------------------------------------------------------

const CLI = new URL("./index.ts", import.meta.url).pathname;
const DEAD_DB_URL = "ws://127.0.0.1:1/rpc";

interface CliRun {
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
}

const runCli = (args: ReadonlyArray<string>, snapshotPath: string, sidecarPath: string): CliRun => {
    const child = Bun.spawnSync(["bun", CLI, ...args], {
        env: {
            ...process.env,
            // The dylib `duckdbTestSetup` resolved is NOT necessarily in
            // `process.env` - CI builds it as an artifact and hands back a path.
            // Spreading `process.env` alone therefore passes locally (the dev
            // shell exports AX_DUCKDB_DYLIB) and fails in CI with
            // `CacheUnavailableError: no libduckdb available`. Forward it
            // explicitly, exactly as recall/sessions-show/ingest-no-surreal do.
            ...(dylibPath === null ? {} : { AX_DUCKDB_DYLIB: dylibPath }),
            AX_DUCKDB_SNAPSHOT: snapshotPath,
            AX_SIDECAR_PATH: sidecarPath,
            AX_DB_URL: DEAD_DB_URL,
            AX_PROGRESS: "off",
            NO_COLOR: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
    });
    return {
        exitCode: child.exitCode,
        stdout: child.stdout.toString(),
        stderr: child.stderr.toString(),
    };
};

describe("ax skills family - already-cache-routed subcommands, spawned CLI against a dead SurrealDB port", () => {
    dtest("tag writes a plays_role edge to the sidecar, not Surreal", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-skills-tag-"), dylibPath, CORPUS));
        const sidecarPath = `${tempDir("ax-skills-tag-sidecar-")}/judgment.sqlite`;
        const run = runCli(["skills", "tag", "composto", "verification"], fixture.snapshotPath, sidecarPath);
        expect(run.stderr).not.toContain("SurrealClient");
        expect(run.exitCode, `${run.stderr}\n${run.stdout}`).toBe(0);
        expect(run.stdout).toContain("verification");
    }, 60_000);

    dtest("by-role reads plays_role from the sidecar joined to cache usage, not Surreal", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-skills-byrole-"), dylibPath, CORPUS));
        const sidecarPath = `${tempDir("ax-skills-byrole-sidecar-")}/judgment.sqlite`;
        const tagRun = runCli(["skills", "tag", "composto", "verification"], fixture.snapshotPath, sidecarPath);
        expect(tagRun.exitCode, `${tagRun.stderr}\n${tagRun.stdout}`).toBe(0);

        const run = runCli(["skills", "by-role", "verification", "--json"], fixture.snapshotPath, sidecarPath);
        expect(run.stderr).not.toContain("SurrealClient");
        expect(run.exitCode, `${run.stderr}\n${run.stdout}`).toBe(0);
        expect(run.stdout).toContain("composto");
    }, 60_000);

    dtest("roles (skill-scoped) reads plays_role from the sidecar, not Surreal", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-skills-roles-"), dylibPath, CORPUS));
        const sidecarPath = `${tempDir("ax-skills-roles-sidecar-")}/judgment.sqlite`;
        const tagRun = runCli(["skills", "tag", "composto", "verification"], fixture.snapshotPath, sidecarPath);
        expect(tagRun.exitCode, `${tagRun.stderr}\n${tagRun.stdout}`).toBe(0);

        const run = runCli(["skills", "roles", "composto", "--json"], fixture.snapshotPath, sidecarPath);
        expect(run.stderr).not.toContain("SurrealClient");
        expect(run.exitCode, `${run.stderr}\n${run.stdout}`).toBe(0);
        expect(run.stdout).toContain("verification");
    }, 60_000);
});
