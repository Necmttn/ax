import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
    buildRunEvidenceEventStatement,
    buildRunEvidenceRefStatement,
    buildRunEvidenceStatements,
    RUN_EVIDENCE_BACKINGS,
    RUN_EVIDENCE_KINDS,
    RUN_EVIDENCE_PRIVACY_LEVELS,
    RUN_EVIDENCE_REF_KINDS,
    RunEvidenceBacking,
    RunEvidenceKind,
    runEvidenceEventRecordKey,
    runEvidenceRefRecordKey,
    type RunEvidenceEventWrite,
    type RunEvidenceRefWrite,
} from "./run-evidence.ts";

const baseEvent: RunEvidenceEventWrite = {
    sessionId: "sess-1",
    ts: "2026-06-21T10:00:00.000Z",
    provider: "claude",
    kind: "tool_observation",
    backing: "tool_backed",
    sourceTable: "tool_call",
    sourceId: "tc-abc",
};

describe("run-evidence enums", () => {
    test("closed sets carry the converged taxonomy", () => {
        expect(RUN_EVIDENCE_KINDS).toContain("verification");
        expect(RUN_EVIDENCE_KINDS).toContain("derived_summary");
        expect(RUN_EVIDENCE_BACKINGS).toEqual([
            "model_claim",
            "tool_backed",
            "verifier_backed",
            "policy_backed",
            "derived",
            "unknown",
        ]);
        expect(RUN_EVIDENCE_REF_KINDS).toContain("external_event");
        expect(RUN_EVIDENCE_PRIVACY_LEVELS[0]).toBe("ref_only");
    });

    test("Schema unions validate members and reject strangers", () => {
        expect(Schema.decodeUnknownSync(RunEvidenceKind)("verification")).toBe("verification");
        expect(Schema.decodeUnknownSync(RunEvidenceBacking)("tool_backed")).toBe("tool_backed");
        expect(() => Schema.decodeUnknownSync(RunEvidenceBacking)("trusted")).toThrow();
    });
});

describe("run-evidence record keys", () => {
    test("event key is deterministic from (session, source)", () => {
        const a = runEvidenceEventRecordKey({ sessionId: "sess-1", sourceTable: "tool_call", sourceId: "tc-abc" });
        const b = runEvidenceEventRecordKey({ sessionId: "sess-1", sourceTable: "tool_call", sourceId: "tc-abc" });
        expect(a).toBe(b);
        expect(a).toStartWith("sess_1__");
    });

    test("different source rows yield different keys", () => {
        const a = runEvidenceEventRecordKey({ sessionId: "sess-1", sourceTable: "tool_call", sourceId: "tc-abc" });
        const b = runEvidenceEventRecordKey({ sessionId: "sess-1", sourceTable: "turn", sourceId: "tc-abc" });
        expect(a).not.toBe(b);
    });

    test("ref key is deterministic and target-sensitive", () => {
        const a = runEvidenceRefRecordKey({ eventKey: "ev1", refKind: "file", targetTable: "file", targetId: "f1" });
        const b = runEvidenceRefRecordKey({ eventKey: "ev1", refKind: "file", targetTable: "file", targetId: "f1" });
        const c = runEvidenceRefRecordKey({ eventKey: "ev1", refKind: "file", targetTable: "file", targetId: "f2" });
        expect(a).toBe(b);
        expect(a).not.toBe(c);
    });
});

describe("buildRunEvidenceEventStatement", () => {
    test("emits an idempotent UPSERT...MERGE with session link + required fields", () => {
        const sql = buildRunEvidenceEventStatement(baseEvent);
        expect(sql).toStartWith("UPSERT run_evidence_event:`");
        expect(sql).toContain("MERGE {");
        expect(sql).toContain("session: session:`sess-1`");
        expect(sql).toContain('provider: "claude"');
        expect(sql).toContain('kind: "tool_observation"');
        expect(sql).toContain('backing: "tool_backed"');
        expect(sql).toContain('source_table: "tool_call"');
        expect(sql).toContain('source_id: "tc-abc"');
        expect(sql).toEndWith("};");
    });

    test("same input produces byte-identical SQL (rebuildable)", () => {
        expect(buildRunEvidenceEventStatement(baseEvent)).toBe(buildRunEvidenceEventStatement(baseEvent));
    });

    test("absent optionals encode as NONE; present hot refs become record links", () => {
        const sql = buildRunEvidenceEventStatement(baseEvent);
        expect(sql).toContain("root_session: NONE");
        expect(sql).toContain("parent_session: NONE");
        expect(sql).toContain("summary: NONE");
        // Hot refs are ALWAYS emitted (NONE when absent) so a MERGE re-derive
        // clears a ref that disappeared between runs - no stale links.
        expect(sql).toContain("tool_call: NONE");

        const withRefs = buildRunEvidenceEventStatement({
            ...baseEvent,
            toolCallKey: "tc-abc",
            fileKey: "repo__src_x_ts",
            rootSessionId: "root-1",
        });
        expect(withRefs).toContain("tool_call: tool_call:`tc-abc`");
        expect(withRefs).toContain("file: file:`repo__src_x_ts`");
        expect(withRefs).toContain("root_session: session:`root-1`");
    });

    test("observed_at is omitted unless provided (default-once semantics)", () => {
        expect(buildRunEvidenceEventStatement(baseEvent)).not.toContain("observed_at:");
        const stamped = buildRunEvidenceEventStatement({ ...baseEvent, observedAt: "2026-06-21T11:00:00.000Z" });
        expect(stamped).toContain('observed_at: d"2026-06-21T11:00:00.000Z"');
    });

    test("attrs object is JSON-encoded into the attrs string column", () => {
        const sql = buildRunEvidenceEventStatement({ ...baseEvent, attrs: { exit: 0, cmd: "bun test" } });
        expect(sql).toContain('attrs: "{\\"exit\\":0,\\"cmd\\":\\"bun test\\"}"');
        // Empty object collapses to NONE (no noise rows).
        expect(buildRunEvidenceEventStatement({ ...baseEvent, attrs: {} })).toContain("attrs: NONE");
    });
});

describe("buildRunEvidenceRefStatement", () => {
    const baseRef: RunEvidenceRefWrite = {
        eventKey: "ev-1",
        sessionId: "sess-1",
        ts: "2026-06-21T10:00:00.000Z",
        refKind: "file",
        targetTable: "file",
        targetId: "f1",
        pathHash: "abc123",
    };

    test("links to its event + session and defaults privacy to ref_only", () => {
        const sql = buildRunEvidenceRefStatement(baseRef);
        expect(sql).toStartWith("UPSERT run_evidence_ref:`");
        expect(sql).toContain("event: run_evidence_event:`ev-1`");
        expect(sql).toContain("session: session:`sess-1`");
        expect(sql).toContain('ref_kind: "file"');
        expect(sql).toContain('path_hash: "abc123"');
        expect(sql).toContain('privacy_level: "ref_only"');
        expect(sql).toContain("uri_hash: NONE");
    });

    test("explicit privacy level is honored", () => {
        const sql = buildRunEvidenceRefStatement({ ...baseRef, privacyLevel: "hashed" });
        expect(sql).toContain('privacy_level: "hashed"');
    });
});

describe("buildRunEvidenceStatements", () => {
    test("emits events before refs", () => {
        const stmts = buildRunEvidenceStatements({
            events: [baseEvent],
            refs: [{ eventKey: "ev-1", sessionId: "sess-1", ts: baseEvent.ts, refKind: "record" }],
        });
        expect(stmts).toHaveLength(2);
        expect(stmts[0]).toContain("run_evidence_event:");
        expect(stmts[1]).toContain("run_evidence_ref:");
    });
});
