import { afterAll, describe, expect, test } from "bun:test";
import { Effect, FileSystem, Layer, Path } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { DbError } from "@ax/lib/errors";
import { makeTestSurrealClient } from "@ax/lib/testing/surreal";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    AGENT_EVENT_SEQ_INDEX,
    AGENT_EVENT_SEQ_REPAIR_HINT,
    agentEventIndexDoctorCheck,
    agentEventIndexMarkerPath,
    buildAgentEventSeqRebuildStatement,
    buildSessionDedupSelect,
    clearIndexUnhealthyMarker,
    extractAgentSessionId,
    isAgentEventSeqDuplicateError,
    makeAgentEventSeqRebuild,
    planSessionDedup,
    readIndexUnhealthyMarker,
    withAgentEventSeqHeal,
    writeIndexUnhealthyMarker,
    type AgentEventSeqHealHooks,
} from "./agent-event-index-heal.ts";

// Realistic SurrealDB duplicate-index error message (shape observed across
// versions; the index name is the stable token we key on).
const DUP_MSG =
    "Database index `agent_event_session_seq` already contains " +
    "['agent_session:⟨codex_019abc-def⟩', 4210], with record `agent_event:xyz`";

const dupErr = () => new DbError({ operation: "query", message: DUP_MSG });
const otherDbErr = () => new DbError({ operation: "query", message: "some unrelated failure" });

/** Two duplicate rows at seq 1, so a dedupe drops exactly one by primary id. */
const DEDUP_ROWS = [[[{ id: "agent_event:a", seq: 1 }, { id: "agent_event:b", seq: 1 }]]];

/** A test client whose SELECT returns duplicate rows, REBUILD + INFO succeed. */
function healClient(opts: { rebuildFails?: boolean } = {}) {
    return makeTestSurrealClient({
        denyWrites: false,
        routes: [
            { match: "SELECT id, seq FROM agent_event", rows: DEDUP_ROWS[0] },
            {
                match: "REBUILD INDEX",
                rows: opts.rebuildFails
                    ? Effect.fail(new DbError({ operation: "query", message: "rebuild boom" }))
                    : [[]],
            },
            // INFO FOR INDEX -> no `building` object => ready immediately.
            { match: "INFO FOR INDEX", rows: [[{}]] },
        ],
        fallback: [[]],
    });
}

const rebuildCount = (captured: string[]) => captured.filter((s) => s.includes("REBUILD INDEX")).length;

describe("isAgentEventSeqDuplicateError", () => {
    test("matches a DbError naming the index", () => {
        expect(isAgentEventSeqDuplicateError(dupErr())).toBe(true);
    });
    test("rejects an unrelated DbError", () => {
        expect(isAgentEventSeqDuplicateError(otherDbErr())).toBe(false);
    });
    test("rejects a non-DbError", () => {
        expect(isAgentEventSeqDuplicateError(new Error(DUP_MSG))).toBe(false);
    });
});

describe("extractAgentSessionId", () => {
    test("pulls the agent_session id from the message", () => {
        expect(extractAgentSessionId(DUP_MSG)).toBe("codex_019abc-def");
    });
    test("null when absent", () => {
        expect(extractAgentSessionId("no id here")).toBeNull();
    });
});

describe("pure planners", () => {
    test("planSessionDedup keeps first per seq, drops the rest", () => {
        const drop = planSessionDedup([
            { id: "agent_event:a", seq: 1 },
            { id: "agent_event:b", seq: 1 },
            { id: "agent_event:c", seq: 2 },
        ]);
        expect(drop).toEqual(["agent_event:b"]);
    });

    test("buildSessionDedupSelect targets the session by full-table predicate", () => {
        const sql = buildSessionDedupSelect("codex_019abc-def");
        expect(sql).toContain("SELECT id, seq FROM agent_event");
        expect(sql).toContain("agent_session = agent_session:`codex_019abc-def`");
    });

    test("buildAgentEventSeqRebuildStatement is non-blocking CONCURRENTLY", () => {
        const sql = buildAgentEventSeqRebuildStatement();
        expect(sql).toContain(`REBUILD INDEX IF EXISTS ${AGENT_EVENT_SEQ_INDEX} ON agent_event`);
        expect(sql).toContain("CONCURRENTLY");
    });
});

// A file-ingest effect that fails with a dup `failTimes` times, then succeeds.
function makeWork(failTimes: number) {
    let attempts = 0;
    const work = Effect.suspend(() => {
        attempts += 1;
        return attempts <= failTimes ? Effect.fail(dupErr()) : Effect.succeed("ok" as const);
    });
    return { work, attempts: () => attempts };
}

const runHeal = <A>(
    work: Effect.Effect<A, DbError>,
    hooks: Omit<AgentEventSeqHealHooks, "db" | "rebuild">,
    tc = healClient(),
) =>
    Effect.gen(function* () {
        const rebuild = yield* makeAgentEventSeqRebuild(tc.client);
        return yield* withAgentEventSeqHeal(work, { db: tc.client, rebuild, ...hooks });
    });

describe("withAgentEventSeqHeal ladder", () => {
    test("step 1: dedupe by primary id heals without a rebuild", async () => {
        const tc = healClient();
        const { work } = makeWork(1); // fails once, then the dedupe+retry succeeds
        const dedupes: Array<{ id: string; removed: number }> = [];
        const healed: string[] = [];

        const out = await Effect.runPromise(
            runHeal(
                work,
                {
                    onDedupe: (id, removed) => Effect.sync(() => dedupes.push({ id, removed })),
                    onHealed: () => Effect.sync(() => healed.push("healed")),
                },
                tc,
            ),
        );

        expect(out).toBe("ok");
        // Deduped this session by PRIMARY id (real observable at the seam).
        expect(tc.captured.some((s) => s.startsWith("DELETE agent_event:b"))).toBe(true);
        expect(dedupes).toEqual([{ id: "codex_019abc-def", removed: 1 }]);
        // Cheapest rung only - no rebuild.
        expect(rebuildCount(tc.captured)).toBe(0);
        expect(healed).toEqual(["healed"]);
    });

    test("step 2: escalates to a CONCURRENTLY rebuild when dedupe is insufficient", async () => {
        const tc = healClient();
        const { work } = makeWork(2); // dedupe retry still collides -> rebuild -> retry ok
        const rebuilt: string[] = [];
        const healed: string[] = [];

        const out = await Effect.runPromise(
            runHeal(
                work,
                {
                    onRebuild: () => Effect.sync(() => rebuilt.push("rebuilt")),
                    onHealed: () => Effect.sync(() => healed.push("healed")),
                },
                tc,
            ),
        );

        expect(out).toBe("ok");
        expect(tc.captured.some((s) => s.includes("REBUILD INDEX") && s.includes("CONCURRENTLY"))).toBe(true);
        expect(tc.captured.some((s) => s.includes("INFO FOR INDEX"))).toBe(true); // polled readiness
        expect(rebuilt).toEqual(["rebuilt"]);
        expect(healed).toEqual(["healed"]);
    });

    test("step 3: exhausted after rebuild -> onExhausted + rethrow", async () => {
        const tc = healClient();
        const exhausted: (string | null)[] = [];

        const exit = await Effect.runPromiseExit(
            runHeal(
                Effect.fail(dupErr()), // always collides
                { onExhausted: (id) => Effect.sync(() => exhausted.push(id)) },
                tc,
            ),
        );

        expect(exit._tag).toBe("Failure");
        expect(exhausted).toEqual(["codex_019abc-def"]);
        expect(rebuildCount(tc.captured)).toBe(1); // rebuild was tried once
    });

    test("a FAILED rebuild is observable: routes to onExhausted + rethrow", async () => {
        const tc = healClient({ rebuildFails: true });
        const exhausted: (string | null)[] = [];

        const exit = await Effect.runPromiseExit(
            runHeal(
                makeWork(2).work, // survives dedupe, needs the rebuild
                { onExhausted: (id) => Effect.sync(() => exhausted.push(id)) },
                tc,
            ),
        );

        expect(exit._tag).toBe("Failure");
        expect(exhausted).toEqual(["codex_019abc-def"]);
    });

    test("non-matching error passes through untouched (no dedupe, no rebuild)", async () => {
        const tc = healClient();
        const exit = await Effect.runPromiseExit(runHeal(Effect.fail(otherDbErr()), {}, tc));
        expect(exit._tag).toBe("Failure");
        expect(tc.captured).toHaveLength(0);
    });

    test("shared memoized rebuild fires at most once across concurrent files", async () => {
        const tc = healClient();
        const program = Effect.gen(function* () {
            const rebuild = yield* makeAgentEventSeqRebuild(tc.client);
            // Two files, each needs the rebuild (fails twice). They share ONE
            // in-flight rebuild via Effect.cached.
            return yield* Effect.all(
                [
                    withAgentEventSeqHeal(makeWork(2).work, { db: tc.client, rebuild }),
                    withAgentEventSeqHeal(makeWork(2).work, { db: tc.client, rebuild }),
                ],
                { concurrency: 2 },
            );
        });

        const outs = await Effect.runPromise(program);
        expect(outs).toEqual(["ok", "ok"]);
        // The whole point: NOT one rebuild per file.
        expect(rebuildCount(tc.captured)).toBe(1);
    });
});

describe("unhealthy marker + doctor surface", () => {
    const dir = join(tmpdir(), `ax-heal-test-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    test("write / read / clear round-trip", async () => {
        const path = agentEventIndexMarkerPath(dir);
        expect(path).toContain("agent-event-index");

        await Effect.runPromise(
            writeIndexUnhealthyMarker(dir, "codex_019abc-def", DUP_MSG).pipe(provideFs()),
        );
        const marker = await Effect.runPromise(readIndexUnhealthyMarker(dir).pipe(provideFs()));
        expect(marker?.session_id).toBe("codex_019abc-def");

        await Effect.runPromise(clearIndexUnhealthyMarker(dir).pipe(provideFs()));
        const gone = await Effect.runPromise(readIndexUnhealthyMarker(dir).pipe(provideFs()));
        expect(gone).toBeNull();
    });

    test("a missing marker reads as absent/healthy (null)", async () => {
        const marker = await Effect.runPromise(
            readIndexUnhealthyMarker(join(dir, "does-not-exist-subdir")).pipe(provideFs()),
        );
        expect(marker).toBeNull();
    });

    test("doctor check warns when a marker is present, ok when absent", () => {
        const warn = agentEventIndexDoctorCheck({ session_id: "s", message: DUP_MSG, at: "now" });
        expect(warn.ok).toBe(false);
        expect(warn.detail).toContain("repair-agent-event-index.ts");
        expect(agentEventIndexDoctorCheck(null).ok).toBe(true);
    });

    test("repair hint names the global repair script", () => {
        expect(AGENT_EVENT_SEQ_REPAIR_HINT).toContain("repair-agent-event-index.ts");
    });
});

// The fs helpers need @effect/platform Bun layers. Local helper keeps the
// tests DB-free (fs leaf only).
const BunFsLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);
function provideFs() {
    return <A, E>(eff: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
        eff.pipe(Effect.provide(BunFsLayer));
}
