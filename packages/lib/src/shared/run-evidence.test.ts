import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
    RUN_EVIDENCE_BACKINGS,
    RUN_EVIDENCE_KINDS,
    RUN_EVIDENCE_PRIVACY_LEVELS,
    RUN_EVIDENCE_REF_KINDS,
    RunEvidenceBacking,
    RunEvidenceKind,
    runEvidenceEventRecordKey,
    runEvidenceRefRecordKey,
} from "./run-evidence.ts";

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
