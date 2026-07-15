import { afterAll, describe, expect, test } from "bun:test";
import { Effect, FileSystem, Layer, Path } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { DbError } from "@ax/lib/errors";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    AGENT_EVENT_SEQ_INDEX,
    AGENT_EVENT_SEQ_REPAIR_HINT,
    agentEventIndexDoctorCheck,
    agentEventIndexMarkerPath,
    buildAgentEventSeqRepairStatements,
    clearIndexUnhealthyMarker,
    extractAgentSessionId,
    isAgentEventSeqDuplicateError,
    readIndexUnhealthyMarker,
    withAgentEventSeqHeal,
    writeIndexUnhealthyMarker,
    type AgentEventSeqHealState,
} from "./agent-event-index-heal.ts";

// Realistic SurrealDB duplicate-index error message (shape observed across
// versions; the index name is the stable token we key on).
const DUP_MSG =
    "Database index `agent_event_session_seq` already contains " +
    "['agent_session:⟨codex_019abc-def⟩', 4210], with record `agent_event:xyz`";

const dupErr = () => new DbError({ operation: "query", message: DUP_MSG });
const otherDbErr = () => new DbError({ operation: "query", message: "some unrelated failure" });

// Fake client: captures issued SQL, drives success/failure per attempt.
function makeDb(issued: string[], fail: () => DbError | null) {
    return {
        query: (sql: string) =>
            Effect.suspend(() => {
                issued.push(sql);
                const err = fail();
                return err ? Effect.fail(err) : Effect.succeed([[]]);
            }),
    } as unknown as Parameters<typeof withAgentEventSeqHeal>[1]["db"];
}

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

describe("buildAgentEventSeqRepairStatements", () => {
    test("emits the REBUILD for the seq index (ghost-index fix)", () => {
        const stmts = buildAgentEventSeqRepairStatements();
        expect(stmts).toHaveLength(1);
        expect(stmts[0]).toContain("REBUILD INDEX");
        expect(stmts[0]).toContain(AGENT_EVENT_SEQ_INDEX);
        expect(stmts[0]).toContain("ON agent_event");
    });
});

describe("withAgentEventSeqHeal", () => {
    test("on duplicate-index failure: rebuilds once, retries, succeeds", async () => {
        const issued: string[] = [];
        const db = makeDb(issued, () => null); // db.query (the REBUILD) succeeds
        const state: AgentEventSeqHealState = { repaired: false };

        let attempts = 0;
        const healed: string[] = [];
        const work = Effect.suspend(() => {
            attempts += 1;
            return attempts === 1 ? Effect.fail(dupErr()) : Effect.succeed("ok");
        });

        const out = await Effect.runPromise(
            withAgentEventSeqHeal(work, {
                db,
                state,
                onHealed: () => Effect.sync(() => healed.push("healed")),
            }),
        );

        expect(out).toBe("ok");
        expect(attempts).toBe(2); // failed once, retried once
        expect(state.repaired).toBe(true);
        expect(issued.some((s) => s.includes("REBUILD INDEX"))).toBe(true);
        expect(healed).toEqual(["healed"]);
    });

    test("rebuilds at most once across files (state guard)", async () => {
        const issued: string[] = [];
        const db = makeDb(issued, () => null);
        const state: AgentEventSeqHealState = { repaired: true }; // already repaired this stage

        let attempts = 0;
        const work = Effect.suspend(() => {
            attempts += 1;
            return attempts === 1 ? Effect.fail(dupErr()) : Effect.succeed("ok");
        });

        const out = await Effect.runPromise(withAgentEventSeqHeal(work, { db, state }));
        expect(out).toBe("ok");
        expect(issued.some((s) => s.includes("REBUILD INDEX"))).toBe(false); // no second rebuild
    });

    test("second failure after repair: calls onExhausted and rethrows", async () => {
        const issued: string[] = [];
        const db = makeDb(issued, () => null);
        const state: AgentEventSeqHealState = { repaired: false };
        const exhausted: (string | null)[] = [];

        const work = Effect.fail(dupErr()); // always fails

        const exit = await Effect.runPromiseExit(
            withAgentEventSeqHeal(work, {
                db,
                state,
                onExhausted: (id) => Effect.sync(() => exhausted.push(id)),
            }),
        );
        expect(exit._tag).toBe("Failure");
        expect(exhausted).toEqual(["codex_019abc-def"]);
    });

    test("non-matching error passes through untouched (no rebuild)", async () => {
        const issued: string[] = [];
        const db = makeDb(issued, () => null);
        const state: AgentEventSeqHealState = { repaired: false };

        const exit = await Effect.runPromiseExit(
            withAgentEventSeqHeal(Effect.fail(otherDbErr()), { db, state }),
        );
        expect(exit._tag).toBe("Failure");
        expect(issued).toHaveLength(0); // never attempted a rebuild
        expect(state.repaired).toBe(false);
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

    test("doctor check warns when a marker is present, ok when absent", () => {
        const warn = agentEventIndexDoctorCheck({ session_id: "s", message: DUP_MSG, at: "now" });
        expect(warn.ok).toBe(false);
        expect(warn.detail).toContain("REBUILD INDEX");
        expect(agentEventIndexDoctorCheck(null).ok).toBe(true);
    });

    test("repair hint names the manual REBUILD", () => {
        expect(AGENT_EVENT_SEQ_REPAIR_HINT).toContain("REBUILD INDEX");
    });
});

// The fs helpers need @effect/platform Bun layers. Local helper keeps the
// tests DB-free (fs leaf only).
const BunFsLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);
function provideFs() {
    return <A, E>(eff: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
        eff.pipe(Effect.provide(BunFsLayer));
}
