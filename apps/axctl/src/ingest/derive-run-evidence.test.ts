import { describe, expect, test } from "bun:test";
import {
    buildLineage,
    buildRunEvidenceEvents,
    buildRunEvidenceRefs,
    pickEarliestPerSession,
    RUN_EVIDENCE_DERIVED_KINDS,
    runEvidenceStage,
    type RunEvidenceSourceRows,
} from "./derive-run-evidence.ts";
import { runEvidenceEventRecordKey } from "@ax/lib/shared/run-evidence";

const sessionProvider = new Map<string, string>([
    ["sess-claude", "claude"],
    ["sess-codex", "codex"],
]);

const empty: RunEvidenceSourceRows = {
    toolCalls: [],
    commandOutcomes: [],
    compactions: [],
    planSnapshots: [],
    fileEvidence: [],
    edited: [],
    objectives: [],
    policyDecisions: [],
    repoStates: [],
    turnEditCalls: new Map(),
    lineage: new Map(),
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
        // summary + attrs are keyed on the check FAMILY (test), not the raw kind.
        expect(e.summary).toBe("test: ok");
        expect((e.attrs as { family?: string }).family).toBe("test");
    });

    test("non-check command_outcome (a plain success) is NOT a verification (#578 review)", () => {
        // A successful Read/ls produces a command_outcome kind=success; it must
        // not become verifier_backed evidence.
        const events = buildRunEvidenceEvents({
            ...empty,
            commandOutcomes: [{ id: "co2", session: "sess-claude", ts: "2026-06-21T10:02:00.000Z", kind: "success", status: "ok", commandNorm: "ls -la" }],
        });
        expect(events).toHaveLength(0);
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
            commandOutcomes: [{ id: "co1", session: "sess-claude", ts: "2026-06-21T10:01:00.000Z", status: "error", commandNorm: "bun test" }],
            compactions: [{ id: "cmp1", session: "sess-claude", ts: "2026-06-21T10:02:00.000Z" }],
            planSnapshots: [{ id: "ps1", session: "sess-claude", ts: "2026-06-21T10:03:00.000Z" }],
        });
        expect(events.map((e) => e.backing).sort()).toEqual(["derived", "tool_backed", "tool_backed", "verifier_backed"]);
    });
});

describe("buildRunEvidenceRefs - file refs off tool_observation events", () => {
    test("read/search edge -> file ref anchored to the tool_call's event, path hashed", () => {
        const [ref] = buildRunEvidenceRefs({
            ...empty,
            fileEvidence: [{ toolCall: "tc1", file: "repo__src_a_ts", session: "sess-claude", ts: "2026-06-21T10:05:00.000Z", pathSeen: "/repo/src/a.ts", access: "read" }],
        });
        expect(ref.refKind).toBe("file");
        expect(ref.targetTable).toBe("file");
        expect(ref.targetId).toBe("repo__src_a_ts");
        expect(ref.privacyLevel).toBe("ref_only");
        // path is hashed, never stored raw.
        expect(ref.pathHash).toBeTruthy();
        expect(ref.pathHash).not.toContain("/repo/");
        // anchored to the tool_call's tool_observation event.
        expect(ref.eventKey).toBe(runEvidenceEventRecordKey({ sessionId: "sess-claude", sourceTable: "tool_call", sourceId: "tc1" }));
        expect(ref.attrs).toEqual({ access: "read" });
    });

    test("edges with no session / tool_call / file are dropped", () => {
        const refs = buildRunEvidenceRefs({
            ...empty,
            fileEvidence: [
                { toolCall: "tc1", file: "f1", session: null, ts: "t", access: "read" },
                { toolCall: null, file: "f1", session: "s", ts: "t", access: "read" },
                { toolCall: "tc1", file: null, session: "s", ts: "t", access: "search" },
            ],
        });
        expect(refs).toHaveLength(0);
    });

    test("ref event key matches the event key for the same tool_call (ref links a real event)", () => {
        const rows: RunEvidenceSourceRows = {
            ...empty,
            toolCalls: [{ id: "tc1", session: "sess-claude", ts: "2026-06-21T10:05:00.000Z", name: "Read" }],
            fileEvidence: [{ toolCall: "tc1", file: "f1", session: "sess-claude", ts: "2026-06-21T10:05:00.000Z", access: "read" }],
        };
        const [event] = buildRunEvidenceEvents(rows);
        const [ref] = buildRunEvidenceRefs(rows);
        const eventKey = runEvidenceEventRecordKey({ sessionId: event.sessionId, sourceTable: event.sourceTable, sourceId: event.sourceId });
        expect(ref.eventKey).toBe(eventKey);
    });
});

describe("buildRunEvidenceRefs - edited (write) refs via turn->event bridge", () => {
    test("edge anchors to the turn's single edit tool_call; access=write, tool carried", () => {
        const [ref] = buildRunEvidenceRefs({
            ...empty,
            edited: [{ turn: "turn1", file: "repo__a_ts", session: "sess-claude", ts: "2026-06-21T10:07:00.000Z", pathSeen: "/repo/a.ts", tool: "Write" }],
            turnEditCalls: new Map([["turn1", ["tcWrite"]]]),
        });
        expect(ref.refKind).toBe("file");
        expect(ref.targetId).toBe("repo__a_ts");
        expect(ref.eventKey).toBe(runEvidenceEventRecordKey({ sessionId: "sess-claude", sourceTable: "tool_call", sourceId: "tcWrite" }));
        expect(ref.pathHash).toBeTruthy();
        expect(ref.pathHash).not.toContain("/repo/");
        expect(ref.attrs).toEqual({ access: "write", tool: "Write" });
    });

    test("ambiguous turn (>1 edit tool_call) is skipped, not mis-attributed", () => {
        const refs = buildRunEvidenceRefs({
            ...empty,
            edited: [{ turn: "turn1", file: "f1", session: "s", ts: "t", tool: "Edit" }],
            turnEditCalls: new Map([["turn1", ["tcA", "tcB"]]]),
        });
        expect(refs).toHaveLength(0);
    });

    test("turn with no matching edit tool_call is skipped", () => {
        const refs = buildRunEvidenceRefs({
            ...empty,
            edited: [{ turn: "turnX", file: "f1", session: "s", ts: "t", tool: "Edit" }],
            turnEditCalls: new Map(),
        });
        expect(refs).toHaveLength(0);
    });
});

describe("buildRunEvidenceEvents - slice 6 kinds", () => {
    test("objective: task user turn -> objective/derived, hot-links the turn", () => {
        const [e] = buildRunEvidenceEvents({
            ...empty,
            objectives: [{ id: "tu1", session: "sess-claude", ts: "2026-06-21T10:00:00.000Z", seq: 1, textExcerpt: "Add omp support" }],
        });
        expect(e.kind).toBe("objective");
        expect(e.backing).toBe("derived");
        expect(e.sourceTable).toBe("turn");
        expect(e.turnKey).toBe("tu1");
        expect(e.summary).toBe("Add omp support");
    });

    test("policy_decision: hook effect -> policy_backed, no excerpts in attrs", () => {
        const [e] = buildRunEvidenceEvents({
            ...empty,
            policyDecisions: [{ id: "h1", session: "sess-claude", toolCall: "tc1", ts: "2026-06-21T10:01:00.000Z", hookName: "enforce-worktree", effect: "blocked", providerStatus: "blocking_error" }],
        });
        expect(e.kind).toBe("policy_decision");
        expect(e.backing).toBe("policy_backed");
        expect(e.hookInvocationKey).toBe("h1");
        expect(e.toolCallKey).toBe("tc1");
        expect(e.summary).toBe("enforce-worktree: blocked");
        expect(e.attrs).toEqual({ effect: "blocked", hook_name: "enforce-worktree", provider_status: "blocking_error" });
    });

    test("repo_state: checkout -> derived, summary has repo@branch·sha7, no dirty", () => {
        const [e] = buildRunEvidenceEvents({
            ...empty,
            repoStates: [{ session: "sess-claude", checkout: "co1", ts: "2026-06-21T10:00:00.000Z", branch: "feat/x", headSha: "a1b2c3d4e5", repository: "Necmttn/ax" }],
        });
        expect(e.kind).toBe("repo_state");
        expect(e.backing).toBe("derived");
        expect(e.checkoutKey).toBe("co1");
        expect(e.summary).toBe("Necmttn/ax @ feat/x · a1b2c3d");
        expect(e.summary).not.toContain("dirty");
    });

    test("derived_summary: compaction summary -> distinct event (compaction_summary table)", () => {
        const events = buildRunEvidenceEvents({
            ...empty,
            compactions: [{ id: "cmp1", session: "sess-claude", ts: "2026-06-21T10:30:00.000Z", strategy: "summarize", summary: "Goal: ship X" }],
        });
        // boundary + derived_summary off the same compaction, distinct source_tables.
        const boundary = events.find((e) => e.kind === "boundary");
        const summary = events.find((e) => e.kind === "derived_summary");
        expect(boundary?.sourceTable).toBe("compaction");
        expect(summary?.sourceTable).toBe("compaction_summary");
        expect(summary?.summary).toBe("Goal: ship X");
        // distinct keys (different source_table) so no collision.
        expect(runEvidenceEventRecordKey({ sessionId: "sess-claude", sourceTable: "compaction", sourceId: "cmp1" }))
            .not.toBe(runEvidenceEventRecordKey({ sessionId: "sess-claude", sourceTable: "compaction_summary", sourceId: "cmp1" }));
    });

    test("compaction with no summary emits boundary only", () => {
        const events = buildRunEvidenceEvents({
            ...empty,
            compactions: [{ id: "cmp2", session: "sess-claude", ts: "2026-06-21T10:30:00.000Z", strategy: "summarize" }],
        });
        expect(events.filter((e) => e.kind === "derived_summary")).toHaveLength(0);
        expect(events.filter((e) => e.kind === "boundary")).toHaveLength(1);
    });

    test("lineage from spawned stamps parent + root on a subagent's events", () => {
        const [e] = buildRunEvidenceEvents({
            ...empty,
            toolCalls: [{ id: "tc1", session: "child", ts: "2026-06-21T10:00:00.000Z", name: "Read" }],
            sessionProvider: new Map([["child", "claude"]]),
            lineage: new Map([["child", { parent: "mid", root: "top" }]]),
        });
        expect(e.parentSessionId).toBe("mid");
        expect(e.rootSessionId).toBe("top");
    });
});

describe("pickEarliestPerSession", () => {
    test("keeps the lowest-seq turn per session", () => {
        const picked = pickEarliestPerSession([
            { id: "b", session: "s1", ts: "t", seq: 5, textExcerpt: "later" },
            { id: "a", session: "s1", ts: "t", seq: 1, textExcerpt: "first" },
            { id: "c", session: "s2", ts: "t", seq: 2, textExcerpt: "other" },
        ]);
        expect(picked.find((r) => r.session === "s1")?.id).toBe("a");
        expect(picked).toHaveLength(2);
    });
});

describe("buildLineage", () => {
    test("walks parent links to the root; top-level sessions absent", () => {
        const lin = buildLineage([
            { parent: "top", child: "mid" },
            { parent: "mid", child: "leaf" },
        ]);
        expect(lin.get("leaf")).toEqual({ parent: "mid", root: "top" });
        expect(lin.get("mid")).toEqual({ parent: "top", root: "top" });
        expect(lin.has("top")).toBe(false);
    });

    test("cycle is guarded (no infinite loop)", () => {
        const lin = buildLineage([
            { parent: "a", child: "b" },
            { parent: "b", child: "a" },
        ]);
        expect(lin.get("a")?.parent).toBe("b");
        expect(lin.get("b")?.parent).toBe("a");
    });
});

describe("runEvidenceStage wiring", () => {
    test("declares the canonical key/deps/tags", () => {
        expect(runEvidenceStage.meta.key).toBe("run-evidence");
        expect(runEvidenceStage.meta.deps).toEqual(["claude", "codex", "pi", "omp", "opencode", "cursor", "outcomes", "git", "spawned"]);
        expect(runEvidenceStage.meta.tags).toEqual(["derive"]);
    });

    test("covered-kinds capability set is the eight derived kinds", () => {
        expect(RUN_EVIDENCE_DERIVED_KINDS).toEqual([
            "tool_observation", "verification", "boundary", "task_state",
            "objective", "policy_decision", "repo_state", "derived_summary",
        ]);
    });
});
