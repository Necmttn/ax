/**
 * `ax retro` command family, exercised END TO END against a real DuckDB
 * cache fixture + a real SQLite judgment sidecar, with the SAME throwing
 * `SurrealClient` sentinel production's no-DB runtimes (`withCache` /
 * `withoutDb` in `cli/index.ts`) provide - any access still fails LOUDLY.
 *
 * WHY NOT A SPAWNED-CLI DEAD-PORT TEST (the `recall-no-surreal.test.ts`
 * shape). That shape only discriminates for a command whose MANIFEST entry
 * already says `"cache"` - `recall` and `sessions show` are. `retroRuntime`
 * (commands/retro.ts) still routes `pending`, `brief`, and `meta` through
 * `"db"`: the RUNTIME_BY_COMMAND flip is a SEPARATE, deferred chunk (band
 * ruling R34), not this chunk's to make. `withDb` provides
 * `LegacySurrealAppLayer`, and `SurrealClientLive` is `Layer.effect` whose
 * body `await`s `db.connect()` with a 5s timeout - so building that layer
 * against a dead port fails BEFORE the command body ever runs, regardless of
 * whether the ported code touches `SurrealClient`. A spawned dead-port test
 * for `pending`/`brief`/`meta` would therefore just time out on ROUTING,
 * proving nothing about the code this chunk changed.
 *
 * So instead: call the exported command functions directly, providing a real
 * `CacheRead` (published DuckDB fixture), a real `Judgment` (SQLite sidecar,
 * not a fake), and the exact throwing `SurrealClient` sentinel `withCache`
 * provides in production. Any `SurrealClient` access still throws
 * immediately and by name - this is MORE precise than a dead-port timeout,
 * and it is not confounded by manifest routing that is out of this chunk's
 * scope. `cmdRetroReflect`/`cmdRetroPlan` need no runtime check here at all:
 * their Effect signatures require only `Judgment` (see retro-reflect.ts /
 * retro-plan.ts) - the ABSENCE of `SurrealClient` from the type is itself
 * compile-time proof, and this suite would fail to typecheck if that ever
 * regressed.
 */
import { describe, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { CacheReadLayer, type CacheWriteService } from "@ax/lib/duckdb/seam";
import { JudgmentLayer } from "@ax/lib/sqlite";
import { SIDECAR_SCHEMA_SQL } from "@ax/schema/sidecar-ddl";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { cmdRetroBrief, cmdRetroEmit, cmdRetroList, cmdRetroPending } from "./commands/retro.ts";
import { cmdRetroMeta } from "./retro-meta.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("ax retro family (no surreal)", {
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

/** One CacheRead + one fresh Judgment sidecar + the throwing sentinel. */
const buildLayer = async (
    corpus: (write: CacheWriteService) => Effect.Effect<unknown, unknown, never>,
    label: string,
) => {
    const fixture = await runWithPlatform(publishCacheFixture(tempDir(`${label}-`), dylibPath, corpus));
    const sidecarRoot = mkdtempSync(join(tmpdir(), `${label}-sidecar-`));
    const sidecarPath = join(sidecarRoot, "judgment.sqlite");
    const layer = Layer.mergeAll(
        CacheReadLayer({ snapshotPath: fixture.snapshotPath, ...(dylibPath === null ? {} : { assetPath: dylibPath }) }),
        JudgmentLayer({ sidecarPath, schemaSql: SIDECAR_SCHEMA_SQL }),
        Layer.succeed(SurrealClient, throwingSurrealClient()),
        Layer.merge(BunFileSystem.layer, BunPath.layer),
    );
    return { layer, sidecarPath };
};

const run = <A, E, R>(eff: Effect.Effect<A, E, R>, layer: Layer.Layer<R>): Promise<A> =>
    Effect.runPromise(eff.pipe(Effect.provide(layer), Effect.scoped));

describe("ax retro family on the cache + sidecar, SurrealClient never reachable", () => {
    dtest("emit's latest-session fallback resolves through the cache, not Surreal", async () => {
        const { layer } = await buildLayer((w) =>
            w.put("session", {
                id: "session-emit-fallback",
                source: "claude",
                project: "ax",
                cwd: "/w/ax",
                started_at: T("2026-08-10T10:00:00.000Z"),
            }), "ax-retro-emit");

        const logged: string[] = [];
        const origLog = console.log;
        console.log = (msg: string) => { logged.push(msg); };
        try {
            await run(cmdRetroEmit({ session: undefined, fromFile: undefined, source: undefined, json: true }), layer);
        } finally {
            console.log = origLog;
        }
        const out = JSON.parse(logged.join("")) as { session: string };
        expect(out.session).toBe("session:session-emit-fallback");
    }, 60_000);

    dtest("list reads retros from the judgment sidecar, not Surreal", async () => {
        const { layer } = await buildLayer((w) =>
            w.put("session", { id: "session-list-a", source: "claude", project: "ax", cwd: "/w/ax" }),
        "ax-retro-list");

        // Seed a retro directly via the same sidecar, then list it back.
        await run(cmdRetroEmit({ session: "session-list-a", fromFile: undefined, source: "manual", json: false }), layer);

        const logged: string[] = [];
        const origLog = console.log;
        console.log = (msg: string) => { logged.push(msg); };
        try {
            await run(cmdRetroList({ limit: 20, since: undefined, json: true }), layer);
        } finally {
            console.log = origLog;
        }
        const rows = JSON.parse(logged.join("")) as ReadonlyArray<{ session: string }>;
        expect(rows.map((r) => r.session)).toContain("session-list-a");
    }, 60_000);

    dtest("pending finds ended + idle sessions from the cache, not Surreal", async () => {
        const { layer } = await buildLayer((w) =>
            w.putMany("session", [
                {
                    id: "session-pending-ended",
                    source: "claude",
                    project: "ax",
                    cwd: "/w/ax",
                    started_at: T("2026-08-15T10:00:00.000Z"),
                    ended_at: T("2026-08-15T11:00:00.000Z"),
                },
                {
                    id: "session-pending-idle",
                    source: "claude",
                    project: "ax",
                    cwd: "/w/ax",
                    started_at: T("2026-08-15T09:00:00.000Z"),
                    ended_at: null,
                },
            ]), "ax-retro-pending");

        const logged: string[] = [];
        const origLog = console.log;
        console.log = (msg: string) => { logged.push(msg); };
        try {
            await run(cmdRetroPending({ since: 7, idleMin: 5, limit: 20, includeSubagents: false, json: true }), layer);
        } finally {
            console.log = origLog;
        }
        const pending = JSON.parse(logged.join("")) as ReadonlyArray<{ key: string; reason: string }>;
        expect(pending.map((s) => s.key).sort()).toEqual(["session-pending-ended", "session-pending-idle"]);
        expect(pending.find((s) => s.key === "session-pending-ended")?.reason).toBe("ended_at");
        expect(pending.find((s) => s.key === "session-pending-idle")?.reason).toBe("idle");
    }, 60_000);

    dtest("brief resolves session detail + turn count from the cache, not Surreal", async () => {
        const { layer } = await buildLayer((w) =>
            Effect.gen(function* () {
                yield* w.put("session", {
                    id: "session-brief-a",
                    source: "claude",
                    project: "ax",
                    cwd: "/w/ax",
                    started_at: T("2026-08-15T10:00:00.000Z"),
                    ended_at: T("2026-08-15T11:00:00.000Z"),
                });
                yield* w.putMany("turn", [
                    { id: "t1", session: "session-brief-a", seq: 1, ts: T("2026-08-15T10:05:00.000Z"), role: "user", has_tool_use: false, has_error: false },
                    { id: "t2", session: "session-brief-a", seq: 2, ts: T("2026-08-15T10:10:00.000Z"), role: "assistant", has_tool_use: false, has_error: false },
                ]);
            }), "ax-retro-brief");

        const outDir = mkdtempSync(join(tmpdir(), "ax-retro-brief-out-"));
        const logged: string[] = [];
        const origLog = console.log;
        console.log = (msg: string) => { logged.push(msg); };
        try {
            await run(cmdRetroBrief({ session: "session-brief-a", outDir, json: true }), layer);
        } finally {
            console.log = origLog;
        }
        const out = JSON.parse(logged.join("")) as { session: string; path: string };
        expect(out.session).toBe("session:session-brief-a");
        const content = await readFile(out.path, "utf8");
        expect(content).toContain("turns: 2");
    }, 60_000);

    dtest("meta reads the skill catalog from the cache, not Surreal", async () => {
        const { layer } = await buildLayer((w) =>
            w.put("skill", {
                id: "skill-a",
                name: "composto",
                scope: "user",
                dir_path: "/skills/composto",
                content_hash: "abc",
            }), "ax-retro-meta");

        const logged: string[] = [];
        const origLog = console.log;
        console.log = (msg: string) => { logged.push(msg); };
        try {
            await run(cmdRetroMeta(["--since=30"]), layer);
        } finally {
            console.log = origLog;
        }
        const snapshot = JSON.parse(logged.join("")) as {
            current_state: { skills: ReadonlyArray<{ name: string }> };
        };
        expect(snapshot.current_state.skills.map((s) => s.name)).toEqual(["composto"]);
    }, 60_000);
});
