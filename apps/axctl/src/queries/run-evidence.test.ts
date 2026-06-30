import { describe, expect, test } from "bun:test";
import {
    RUN_EVIDENCE_COVERED_KINDS,
    renderRunEvidence,
    type RunEvidenceResult,
} from "./run-evidence.ts";

const populated: RunEvidenceResult = {
    session_id: "abc-123",
    generated_at: "2026-06-30T00:00:00.000Z",
    total: 53,
    by_kind: [
        { key: "tool_observation", count: 42 },
        { key: "verification", count: 8 },
        { key: "task_state", count: 2 },
        { key: "boundary", count: 1 },
        { key: "objective", count: 0 },
        { key: "claim", count: 0 },
    ],
    by_backing: [
        { key: "model_claim", count: 0 },
        { key: "tool_backed", count: 44 },
        { key: "verifier_backed", count: 8 },
        { key: "policy_backed", count: 0 },
        { key: "derived", count: 1 },
        { key: "unknown", count: 0 },
    ],
    timeline: [
        { ts: "2026-06-21T10:30:00.000Z", kind: "boundary", backing: "derived", source_table: "compaction", summary: "compaction (summarize, auto)" },
        { ts: "2026-06-21T10:06:00.000Z", kind: "verification", backing: "verifier_backed", source_table: "command_outcome", summary: "success: ok" },
        { ts: "2026-06-21T10:05:00.000Z", kind: "tool_observation", backing: "tool_backed", source_table: "tool_call", summary: "Bash" },
    ],
    ref_total: 17,
    by_ref_kind: [{ key: "file", count: 17 }],
    covered_kinds: [...RUN_EVIDENCE_COVERED_KINDS],
    timeline_limit: 50,
};

describe("renderRunEvidence", () => {
    test("headline shows session + total", () => {
        const out = renderRunEvidence(populated);
        expect(out).toContain("run evidence: session abc-123  [53 events]");
    });

    test("non-zero kinds/backings are listed; zeros are dropped from the inline summary", () => {
        const out = renderRunEvidence(populated);
        expect(out).toContain("tool_observation 42");
        expect(out).toContain("verifier_backed 8");
        expect(out).not.toContain("objective 0");
        expect(out).not.toContain("policy_backed 0");
    });

    test("model_claim=0 is called out explicitly (claim-vs-backed honesty)", () => {
        const out = renderRunEvidence(populated);
        expect(out).toContain("model_claim 0 - unverified model claims are not mined yet");
    });

    test("timeline rows render hh:mm + kind + backing + summary, newest first", () => {
        const out = renderRunEvidence(populated);
        const boundaryIdx = out.indexOf("10:30");
        const toolIdx = out.indexOf("10:05");
        expect(boundaryIdx).toBeGreaterThan(-1);
        expect(toolIdx).toBeGreaterThan(boundaryIdx); // newest (10:30) printed before 10:05
        expect(out).toContain("Bash");
    });

    test("covered-kinds capability line + deferred-kinds note are present", () => {
        const out = renderRunEvidence(populated);
        expect(out).toContain("covered kinds: tool_observation, verification, boundary, task_state");
        expect(out).toContain("not yet derived");
    });

    test("refs line shows total + by ref_kind when present", () => {
        const out = renderRunEvidence(populated);
        expect(out).toContain("refs:        17 (file 17)");
    });

    test("refs line is omitted when there are no refs", () => {
        const out = renderRunEvidence({ ...populated, ref_total: 0, by_ref_kind: [] });
        expect(out).not.toContain("refs:");
    });

    test("empty session prints a helpful no-evidence message", () => {
        const out = renderRunEvidence({
            ...populated,
            total: 0,
            by_kind: [],
            by_backing: [],
            timeline: [],
        });
        expect(out).toContain("[0 events]");
        expect(out).toContain("no run-evidence events for this session yet");
        expect(out).not.toContain("timeline");
    });
});
