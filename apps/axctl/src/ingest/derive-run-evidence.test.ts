import { describe, expect, test } from "bun:test";
import {
    buildRunEvidenceEvents,
    RUN_EVIDENCE_DERIVED_KINDS,
    runEvidenceStage,
    type RunEvidenceSourceRows,
} from "./derive-run-evidence.ts";

const sessionProvider = new Map<string, string>([
    ["sess-claude", "claude"],
    ["sess-codex", "codex"],
]);

const empty: RunEvidenceSourceRows = {
    toolCalls: [],
    commandOutcomes: [],
    compactions: [],
    planSnapshots: [],
    sessionProvider,
};

describe("buildRunEvidenceEvents - source -> (kind, backing) mapping", () => {
    test("tool_call -> tool_observation / tool_backed, provider from session", () => {
        const [e] = buildRunEvidenceEvents({
            ...empty,
            toolCalls: [{ id: "tc1", session: "sess-claude", ts: "2026-06-21T10:00:00.000Z", name: "Bash", hasError: false, commandNorm: "rg foo" }],
        });
        expect(e.kind).toBe("tool_observation");
        expect(e.backing).toBe("tool_backed");
        expect(e.provider).toBe("claude");
        expect(e.sourceTable).toBe("tool_call");
        expect(e.sourceId).toBe("tc1");
        expect(e.toolCallKey).toBe("tc1");
        expect(e.summary).toBe("Bash");
    });

    test("command_outcome -> verification / verifier_backed, links its tool_call", () => {
        const [e] = buildRunEvidenceEvents({
            ...empty,
            commandOutcomes: [{ id: "co1", session: "sess-codex", toolCall: "tc9", ts: "2026-06-21T10:01:00.000Z", kind: "success", status: "ok", commandNorm: "bun test" }],
        });
        expect(e.kind).toBe("verification");
        expect(e.backing).toBe("verifier_backed");
        expect(e.provider).toBe("codex");
        expect(e.commandOutcomeKey).toBe("co1");
        expect(e.toolCallKey).toBe("tc9");
        expect(e.summary).toBe("success: ok");
    });

    test("compaction -> boundary / derived (NOT tool_backed)", () => {
        const [e] = buildRunEvidenceEvents({
            ...empty,
            compactions: [{ id: "cmp1", session: "sess-claude", ts: "2026-06-21T10:02:00.000Z", trigger: "auto", strategy: "summarize", tokensBefore: 90000 }],
        });
        expect(e.kind).toBe("boundary");
        expect(e.backing).toBe("derived");
        expect(e.compactionKey).toBe("cmp1");
        expect(e.summary).toContain("summarize");
    });

    test("plan_snapshot -> task_state / tool_backed", () => {
        const [e] = buildRunEvidenceEvents({
            ...empty,
            planSnapshots: [{ id: "ps1", session: "sess-claude", ts: "2026-06-21T10:03:00.000Z", summary: "3 todos, 1 in progress" }],
        });
        expect(e.kind).toBe("task_state");
        expect(e.backing).toBe("tool_backed");
        expect(e.planSnapshotKey).toBe("ps1");
        expect(e.summary).toBe("3 todos, 1 in progress");
    });
});

describe("buildRunEvidenceEvents - invariants", () => {
    test("rows without a session are dropped (evidence must anchor to a run)", () => {
        const events = buildRunEvidenceEvents({
            ...empty,
            toolCalls: [{ id: "tc1", session: null, ts: "2026-06-21T10:00:00.000Z", name: "Read" }],
            compactions: [{ id: "cmp1", session: null, ts: "2026-06-21T10:00:00.000Z" }],
        });
        expect(events).toHaveLength(0);
    });

    test("unknown session falls back to provider 'unknown' (no crash)", () => {
        const [e] = buildRunEvidenceEvents({
            ...empty,
            toolCalls: [{ id: "tc1", session: "ghost", ts: "2026-06-21T10:00:00.000Z", name: "Read" }],
        });
        expect(e.provider).toBe("unknown");
    });

    test("backing is fixed per source - no class is shared across sources", () => {
        const events = buildRunEvidenceEvents({
            ...empty,
            toolCalls: [{ id: "tc1", session: "sess-claude", ts: "2026-06-21T10:00:00.000Z", name: "Bash" }],
            commandOutcomes: [{ id: "co1", session: "sess-claude", ts: "2026-06-21T10:01:00.000Z", status: "error" }],
            compactions: [{ id: "cmp1", session: "sess-claude", ts: "2026-06-21T10:02:00.000Z" }],
            planSnapshots: [{ id: "ps1", session: "sess-claude", ts: "2026-06-21T10:03:00.000Z" }],
        });
        expect(events.map((e) => e.backing).sort()).toEqual(["derived", "tool_backed", "tool_backed", "verifier_backed"]);
    });
});

describe("runEvidenceStage wiring", () => {
    test("declares the canonical key/deps/tags", () => {
        expect(runEvidenceStage.meta.key).toBe("run-evidence");
        expect(runEvidenceStage.meta.deps).toEqual(["claude", "codex", "pi", "omp", "opencode", "cursor", "outcomes"]);
        expect(runEvidenceStage.meta.tags).toEqual(["derive"]);
    });

    test("covered-kinds capability set is the four structural sources", () => {
        expect(RUN_EVIDENCE_DERIVED_KINDS).toEqual(["tool_observation", "verification", "boundary", "task_state"]);
    });
});
