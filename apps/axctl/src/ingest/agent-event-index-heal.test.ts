import { afterAll, describe, expect, test } from "bun:test";
import { Effect, FileSystem, Layer, Path } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { DbError } from "@ax/lib/errors";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    AGENT_EVENT_SEQ_REPAIR_HINT,
    agentEventIndexDoctorCheck,
    agentEventIndexMarkerPath,
    clearIndexUnhealthyMarker,
    extractAgentSessionId,
    isAgentEventSeqDuplicateError,
    planSessionDedup,
    readIndexUnhealthyMarker,
    writeIndexUnhealthyMarker,
} from "./agent-event-index-heal.ts";

const DUP_MSG =
    "Database index `agent_event_session_seq` already contains " +
    "['agent_session:⟨codex_019abc-def⟩', 4210], with record `agent_event:xyz`";
const dupErr = () => new DbError({ operation: "query", message: DUP_MSG });
const otherDbErr = () => new DbError({ operation: "query", message: "some unrelated failure" });

describe("isAgentEventSeqDuplicateError", () => {
    test("matches a DbError naming the index", () => {
        expect(isAgentEventSeqDuplicateError(dupErr())).toBe(true);
    });
    test("rejects an unrelated DbError", () => {
        expect(isAgentEventSeqDuplicateError(otherDbErr())).toBe(false);
    });
    test("matches any error that carries the duplicate-index message", () => {
        expect(isAgentEventSeqDuplicateError(new Error(DUP_MSG))).toBe(true);
    });
});

describe("extractAgentSessionId", () => {
    test("pulls the agent_session id from the message", () => {
        expect(extractAgentSessionId(DUP_MSG)).toBe("codex_019abc-def");
    });
    test("returns null when the message has no session id", () => {
        expect(extractAgentSessionId("no id here")).toBeNull();
    });
});

describe("planSessionDedup", () => {
    test("keeps the first row for each sequence and drops later rows", () => {
        expect(planSessionDedup([
            { id: "agent_event:a", seq: 1 },
            { id: "agent_event:b", seq: 1 },
            { id: "agent_event:c", seq: 2 },
        ])).toEqual(["agent_event:b"]);
    });
});

describe("unhealthy marker and doctor surface", () => {
    const dir = join(tmpdir(), `ax-heal-test-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    test("write, read, and clear complete a round trip", async () => {
        expect(agentEventIndexMarkerPath(dir)).toContain("agent-event-index");
        await Effect.runPromise(
            writeIndexUnhealthyMarker(dir, "codex_019abc-def", DUP_MSG).pipe(provideFs()),
        );
        const marker = await Effect.runPromise(readIndexUnhealthyMarker(dir).pipe(provideFs()));
        expect(marker?.session_id).toBe("codex_019abc-def");
        await Effect.runPromise(clearIndexUnhealthyMarker(dir).pipe(provideFs()));
        expect(await Effect.runPromise(readIndexUnhealthyMarker(dir).pipe(provideFs()))).toBeNull();
    });

    test("a missing marker is healthy", async () => {
        const marker = await Effect.runPromise(
            readIndexUnhealthyMarker(join(dir, "does-not-exist-subdir")).pipe(provideFs()),
        );
        expect(marker).toBeNull();
    });

    test("doctor check warns for a marker and accepts no marker", () => {
        const warn = agentEventIndexDoctorCheck({ session_id: "s", message: DUP_MSG, at: "now" });
        expect(warn.ok).toBe(false);
        expect(warn.detail).toContain("ax ingest --reset");
        expect(agentEventIndexDoctorCheck(null).ok).toBe(true);
    });

    test("repair hint explains the DuckDB rebuild path", () => {
        expect(AGENT_EVENT_SEQ_REPAIR_HINT).toContain("DuckDB schema");
    });
});

const BunFsLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);
function provideFs() {
    return <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
        effect.pipe(Effect.provide(BunFsLayer));
}
