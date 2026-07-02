/**
 * Mock fixtures for the studio build (VITE_STUDIO_MOCK=true).
 *
 * Three views get hand-crafted plausible data: Skills, Workflow, Improve.
 * Everything else returns empty-but-typed responses so the routes don't
 * crash; they just look empty.
 *
 * NOT used in the production `axctl serve` build. See api.ts for dispatch.
 */

import type {
    EpisodeTimelinePayload,
    GraphExplorerPayload,
    ImprovePayload,
    NextActionsPayload,
    ProjectPagePayload,
    RecallResponse,
    SessionChildrenResponse,
    SessionDetailPayload,
    SessionInspectPayload,
    SessionInsightsPayload,
    SessionListResponse,
    SessionListRow,
    SkillDetailPayload,
    SkillGraphPayload,
    SkillSourcePayload,
    SkillTriageEntry,
    SkillTriageNote,
    SkillTriageResponse,
    ToolFailureDetailPayload,
    ToolFailuresResponse,
    WorkflowResponse,
    WrappedProfile,
} from "@ax/lib/shared/dashboard-types";
import type { UsageRollupSchema } from "@ax/lib/shared/api-contract";
// Type-only import (erased at runtime, so no import cycle with api.ts, which
// dynamically imports THIS module): the studio-side shape for /api/cost/models.
import type { CostModelsResult } from "./api.ts";

const NOW = "2026-05-26T14:08:00.000Z";

// ---------------------------------------------------------------------------
// Skills - the headline mock view
// ---------------------------------------------------------------------------

const skillEntry = (
    name: string,
    scope: string,
    description: string,
    score: number,
    inv_30d: number,
    inv_7d: number,
    total: number,
    last_used: string | null,
    recommendation: SkillTriageEntry["recommendation"],
    recommendation_reason: string,
    decision: SkillTriageNote | null = null,
): SkillTriageEntry => ({
    name,
    scope,
    description,
    dir_path: `~/.claude/skills/${name}`,
    bytes: 4096,
    total_inv: total,
    inv_7d,
    inv_30d,
    last_used,
    last_project: "acme-app",
    corrections: 0,
    proposals: 0,
    commits_after: 0,
    taste_score: score,
    recommendation,
    recommendation_reason,
    decision,
});

const SKILLS: ReadonlyArray<SkillTriageEntry> = [
    skillEntry("commit", "user", "Write conventional commit messages with type, scope, and subject when the user wants to commit changes.", 8.5, 57, 9, 312, "2026-05-26T13:00:00Z", "keep", "57 hits/30d - core flow, never propose archiving"),
    skillEntry("tdd", "user", "Test-driven development with red-green-refactor loop.", 11.0, 3, 1, 28, "2026-05-24T10:14:00Z", "keep", "steady use across 4 projects · clean-run rate 0.91"),
    skillEntry("superpowers:systematic-debugging", "plugin:superpowers", "Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes.", 26.5, 6, 0, 6, "2026-05-09T14:22:00Z", "review", "6 hits/30d on acme-app · verify intent before keeping"),
    skillEntry("design-taste-frontend", "user", "Senior UI/UX engineer. Architect digital interfaces overriding default LLM biases. Enforces metric-based rules and balanced component architecture.", 26.5, 2, 0, 2, "2026-05-07T10:00:00Z", "keep", "steady use, 2 hits/30d on acme-app, high taste-score", { skill_name: "design-taste-frontend", decision: "keep", reason: null, decided_at: "2026-05-12T15:35:00Z" }),
    skillEntry("write-a-skill", "user", "Create new agent skills with proper structure, progressive disclosure, and bundled resources.", 23.0, 1, 0, 1, "2026-05-14T19:14:00Z", "review", "rare use (1 hit/30d on acme-app) · keep only if deliberate"),
    skillEntry("cve-audit", "user", "Audit this project for exposure to a published CVE, GHSA, or supply-chain advisory and propose remediation.", 22.5, 1, 0, 1, "2026-05-14T11:00:00Z", "review", "rare use (1 hit/30d) · niche but high-value"),
    skillEntry("codex:mcp__codex_apps__github_search", "codex-tool", "GitHub search via the Codex MCP toolchain.", 19.0, 0, 0, 19, "2026-04-12T00:00:00Z", "archive", "no hits in 30d (last used 45d ago)", { skill_name: "codex:mcp__codex_apps__github_search", decision: "archive", reason: null, decided_at: "2026-05-23T11:20:00Z" }),
    skillEntry("superpowers:writing-skills", "plugin:superpowers", "Use when creating new skills, editing existing skills, or verifying skills work before deployment.", 16.0, 1, 0, 1, "2026-05-08T16:00:00Z", "review", "rare use (1 hit/30d) · keep only if deliberate"),
    skillEntry("superpowers:dispatching-parallel-agents", "plugin:superpowers", "Use when facing 2+ independent tasks that can be worked on without shared state or sequential dependencies.", 15.5, 2, 0, 2, "2026-05-13T12:00:00Z", "review", "rare use (2 hits/30d on markdown) · keep only if deliberate"),
    skillEntry("codex:codex-cli-runtime", "plugin:codex", "Internal helper contract for calling the codex-companion runtime from Claude Code.", 12.5, 1, 0, 1, "2026-05-22T09:00:00Z", "archive", "1 hit/30d, score 12.5 - last meaningful use 4d ago", { skill_name: "codex:codex-cli-runtime", decision: "archive", reason: null, decided_at: "2026-05-25T09:00:00Z" }),
    skillEntry("simplify", "user", "Compress and simplify recent code changes without changing behavior.", 11.5, 5, 1, 89, "2026-05-26T08:00:00Z", "keep", "steady use, 5 hits/30d, high signal"),
    skillEntry("commit", "user", "alias variant", 0, 0, 0, 0, null, "review", "duplicate entry"),
    skillEntry("frontend-design", "plugin:superpowers", "Frontend design review and improvement workflow.", 9.5, 3, 0, 3, "2026-05-18T11:00:00Z", "review", "rare-medium use, evaluate"),
    skillEntry("triage", "user", "Triage issues through a state machine driven by triage roles.", 9.0, 2, 0, 14, "2026-05-21T16:00:00Z", "keep", "consistent across the last 60d"),
    skillEntry("ax:setup", "user", "Install and verify ax (the retro loop) on a new machine.", 8.5, 12, 4, 17, "2026-05-26T11:00:00Z", "keep", "new skill, used immediately on three machines"),
    skillEntry("ax:retro", "user", "Guided experiment-loop retrospective over the ax graph.", 8.0, 8, 2, 8, "2026-05-26T09:30:00Z", "keep", "8 retros in 30d - core to the loop"),
    skillEntry("plannotator-review", "user", "Open Plannotator review UI for current changes or PR.", 7.5, 4, 1, 22, "2026-05-25T17:00:00Z", "review", "moderate use - keep if part of flow"),
    skillEntry("codex:rescue", "command", "Delegate investigation, an explicit fix request, or follow-up rescue work to Codex.", 6.0, 12, 3, 89, "2026-05-25T20:00:00Z", "keep", "12 hits/30d, core escalation path"),
    skillEntry("gsd:plan-phase", "plugin:gsd", "Create detailed phase plan (PLAN.md) with verification loop.", 5.0, 2, 0, 18, "2026-05-15T14:00:00Z", "review", "rare use - keep only if GSD flow is active"),
    skillEntry("codex:codex-companion-polling", "plugin:codex", "Polling pattern for codex-companion async jobs.", 4.5, 1, 0, 9, "2026-05-19T22:00:00Z", "review", "rare use"),
    skillEntry("react-doctor", "user", "Diagnose and fix React codebase health issues.", 3.5, 0, 0, 7, "2026-04-30T00:00:00Z", "archive", "no hits in 30d"),
    skillEntry("dev-browser", "user", "Browser automation with persistent page state.", 3.0, 2, 1, 6, "2026-05-23T11:00:00Z", "review", "low signal - check if intentional"),
    skillEntry("verify", "user", "Verify that a code change actually does what it's supposed to.", 2.5, 1, 0, 5, "2026-05-13T13:00:00Z", "review", "rare use - verification flow only"),
    skillEntry("monitor-release", "user", "Production deployment monitor.", 2.0, 0, 0, 3, "2026-03-19T00:00:00Z", "archive", "no hits in 30d (last used 68d ago)"),
    skillEntry("composto", "user", "Token-efficient JS/TS code investigation.", 1.5, 0, 0, 2, "2026-04-22T00:00:00Z", "archive", "no hits in 30d"),
];

// ---------------------------------------------------------------------------
// Workflow - second-priority mock view
// ---------------------------------------------------------------------------

const WORKFLOW: WorkflowResponse = {
    generatedAt: NOW,
    weeksLookback: 8,
    topK: 5,
    skills: [
        { week: "2026-W21", counts: [{ label: "commit", count: 57 }, { label: "tdd", count: 12 }, { label: "ax:retro", count: 8 }, { label: "ax:setup", count: 12 }, { label: "simplify", count: 5 }] },
        { week: "2026-W20", counts: [{ label: "commit", count: 49 }, { label: "tdd", count: 9 }, { label: "ax:retro", count: 4 }, { label: "design-taste-frontend", count: 2 }, { label: "simplify", count: 4 }] },
        { week: "2026-W19", counts: [{ label: "commit", count: 38 }, { label: "tdd", count: 6 }, { label: "superpowers:systematic-debugging", count: 6 }, { label: "ax:retro", count: 2 }, { label: "simplify", count: 3 }] },
    ],
    tools: [
        { week: "2026-W21", counts: [{ label: "exec_command", count: 1124 }, { label: "write_stdin", count: 166 }, { label: "Edit", count: 89 }, { label: "Read", count: 442 }, { label: "Bash", count: 318 }] },
    ],
    sessionShape: [
        { week: "2026-W21", session_count: 47 },
        { week: "2026-W20", session_count: 35 },
        { week: "2026-W19", session_count: 28 },
    ],
    convergence: [
        { week: "2026-W21", jaccard: 0.71, topK: ["commit", "tdd", "ax:retro", "ax:setup", "simplify"], newcomers: ["ax:setup"], dropouts: ["design-taste-frontend"] },
        { week: "2026-W20", jaccard: 0.62, topK: ["commit", "tdd", "ax:retro", "design-taste-frontend", "simplify"], newcomers: ["ax:retro"], dropouts: ["superpowers:systematic-debugging"] },
    ],
    shapes: [
        { shape: "P→E→R→M", phases: ["plan", "execute", "review", "merge"], session_count: 34, example_session_ids: [] },
        { shape: "E→R→M",   phases: ["execute", "review", "merge"],        session_count: 7,  example_session_ids: [] },
        { shape: "P→E",     phases: ["plan", "execute"],                    session_count: 4,  example_session_ids: [] },
        { shape: "P",       phases: ["plan"],                                session_count: 2,  example_session_ids: [] },
    ],
    shapesTotal: 47,
    episodes: [
        { parent_session_id: "session:demo-1" as unknown as ProjectPagePayload["project"], project: "acme-app", started_at: "2026-05-26T09:14:00Z", child_count: 3, distinct_nicknames: 3 } as never,
        { parent_session_id: "session:demo-2" as unknown as ProjectPagePayload["project"], project: "ax",        started_at: "2026-05-25T22:01:00Z", child_count: 1, distinct_nicknames: 1 } as never,
        { parent_session_id: "session:demo-3" as unknown as ProjectPagePayload["project"], project: "acme-app", started_at: "2026-05-24T17:42:00Z", child_count: 2, distinct_nicknames: 2 } as never,
        { parent_session_id: "session:demo-4" as unknown as ProjectPagePayload["project"], project: "acme-app", started_at: "2026-05-22T11:08:00Z", child_count: 4, distinct_nicknames: 4 } as never,
    ],
    episode_shapes: [
        { shape: "P→E→R→M", phases: ["plan", "execute", "review", "merge"], episode_count: 18, example_parent_ids: [], avg_children: 2.4 },
        { shape: "E→R", phases: ["execute", "review"], episode_count: 7, example_parent_ids: [], avg_children: 1.8 },
    ],
    episode_shapes_total: 25,
    narrative: "47 sessions this week with 3 sub-agent episodes. 73% of sessions ran the canonical plan→execute→review→merge shape. New skill ax:setup entered the top-5; design-taste-frontend dropped out.",
};

// ---------------------------------------------------------------------------
// Improve - third-priority mock view
// ---------------------------------------------------------------------------

interface MockProposal {
    readonly dedupe_sig: string;
    readonly form: string;
    readonly title: string;
    readonly description: string;
    readonly frequency: number;
    readonly confidence: "high" | "low";
    readonly status: "open" | "accepted" | "rejected";
    readonly trigger: string;
    readonly behavior: string;
}

const PROPOSALS: ReadonlyArray<MockProposal> = [
    { dedupe_sig: "skill__4555aa4f87404b1",  form: "skill",    title: "Session closure quality guardrail", description: "Warn the agent before stop when session has no commit + plan still open.", frequency: 1072, confidence: "high", status: "open",     trigger: "session-end without commit + plan still open", behavior: "warn the agent before stop with the plan delta" },
    { dedupe_sig: "skill__508c34566d2f1d85", form: "skill",    title: "Post-feature verification checklist", description: "Scaffold a verify pass before reporting done.", frequency: 26, confidence: "high", status: "open", trigger: "feature commits without follow-up verify", behavior: "scaffold a verify pass before reporting done" },
    { dedupe_sig: "skill__f3f780d54bf97c9",  form: "skill",    title: "Ingest pipeline regression checklist", description: "Surface known regressions before commit.", frequency: 26, confidence: "high", status: "open", trigger: "edits to src/ingest/* without paired test edit", behavior: "surface known regressions before commit" },
    { dedupe_sig: "skill__292666ce747117ee", form: "skill",    title: "Schema change guardrail", description: "Run schema lint + one read/write smoke before edit.", frequency: 12, confidence: "high", status: "open", trigger: "edits to schema files + table definitions", behavior: "run schema lint + one read/write smoke" },
    { dedupe_sig: "guidance__e948791bc8fe2078", form: "guidance", title: "Block main-branch edits in multi-agent projects", description: "Hard refuse, suggest worktree.", frequency: 7, confidence: "low", status: "open", trigger: "edit to main branch while another agent holds a worktree", behavior: "hard refuse, suggest worktree" },
    { dedupe_sig: "skill__53cc564505d4c1f9", form: "skill",    title: "Graph query dogfood checklist", description: "Require an axctl recall smoke before commit.", frequency: 7, confidence: "high", status: "open", trigger: "new SurrealQL query in src/queries/", behavior: "require an axctl recall smoke before commit" },
];

const IMPROVE: ImprovePayload = {
    proposals: PROPOSALS.map((p) => ({
        dedupe_sig: p.dedupe_sig,
        form: p.form as never,
        title: p.title,
        description: p.description,
        frequency: p.frequency,
        confidence: p.confidence,
        status: p.status as never,
        trigger: p.trigger,
        behavior: p.behavior,
        evidence_count: Math.min(p.frequency, 12),
        cited_evidence: [],
        created_at: NOW,
        updated_at: NOW,
        artifact_path: null,
        experiment_id: null,
        locked_verdict: null,
        verdict_set_at: null,
        reject_reason: null,
    }) as never),
} as never;

// ---------------------------------------------------------------------------
// Next Actions - companion panel mock
// ---------------------------------------------------------------------------

const NEXT_ACTIONS: NextActionsPayload = {
    generatedAt: NOW,
    // Mirrors apps/axctl/src/dashboard/next-actions.ts builders: impact is an
    // integer KIND_WEIGHT (verdict 90, proposal 80, tool_failure 70) + bonus
    // (0..9); proposal/verdict cards have link: null, only tool_failure links
    // to /tools; sorted impact-descending.
    cards: [
        {
            id: "verdict:skill__508c34566d2f1d85",
            kind: "verdict",
            title: "Post-feature verification checklist - verdict due",
            evidence: "Experiment scaffolded 12d ago; 26 verification passes observed since",
            impact: 93,
            brief: "## Post-feature verification checklist\n\nThe experiment has been running for 12 days. Evidence suggests the skill is working as intended. Suggested verdict: adopted.",
            link: null,
            inline_action: {
                type: "verdict",
                sig: "skill__508c34566d2f1d85",
                skill: null,
                suggested_verdict: "adopted",
            },
        },
        {
            id: "proposal:skill__4555aa4f87404b1",
            kind: "proposal",
            title: "Session closure quality guardrail",
            evidence: "1072 sessions ended without commit while a plan was still open",
            impact: 85,
            brief: "## Session closure quality guardrail\n\nWarn the agent before stop when session has no commit + plan still open.\n\n**Trigger:** session-end without commit + plan still open\n**Proposed behavior:** warn the agent before stop with the plan delta",
            link: null,
            inline_action: {
                type: "accept",
                sig: "skill__4555aa4f87404b1",
                skill: null,
                suggested_verdict: null,
            },
        },
        {
            id: "tool_failure:Bash:cd-not-found",
            kind: "tool_failure",
            title: "Bash: repeated `cd` path-not-found errors",
            evidence: "14 failures in the last 7 days across 3 projects",
            impact: 74,
            brief: "## Bash cd failures\n\nThe agent repeatedly attempts `cd` with relative paths that don't exist. Consider using absolute paths or checking directory existence first.",
            link: "/tools",
            inline_action: null,
        },
    ],
    notes: [],
};

// ---------------------------------------------------------------------------
// Empty-but-typed responses for the other endpoints
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sessions - a believable recent slice for the acme org. Deterministic (fixed
// timestamps around NOW), so the /sessions route + StoryStrip render without a
// daemon. has_raw_file:false -> rows show "no transcript" (no session-detail
// mock surface needed); StoryStrip still fetches insights (mocked empty -> "–").
// Costs are per-session (a recent list), NOT the monthly org total - so they
// never contradict the $2,140/mo model spend the /team demo + cost view tell.
// ---------------------------------------------------------------------------

const M = 60_000;

const sess = (
    id: string,
    project: string,
    source: string,
    model: string | null,
    startISO: string,
    durMs: number,
    turns: number,
    cost: number | null,
    added: number | null,
    removed: number | null,
    commits: number | null,
    reverted: number | null,
    friction: number | null,
    signal: "clean" | "friction" | null,
    children = 0,
    parent: string | null = null,
): SessionListRow => ({
    id: `session:${id}`,
    project,
    source,
    cwd: `/Users/dev/acme/${project}`,
    model,
    started_at: startISO,
    ended_at: new Date(Date.parse(startISO) + durMs).toISOString(),
    has_raw_file: false,
    turn_count: turns,
    parent_session: parent,
    direct_children_count: children,
    cost_usd: cost,
    burn_buckets: null,
    friction,
    signal,
    produced_commits: commits,
    reverted_commits: reverted,
    lines_added: added,
    lines_removed: removed,
    is_live: false,
});

const SESSIONS: ReadonlyArray<SessionListRow> = [
    sess("a1c2e3", "acme-web", "claude", "claude-opus-4-8", "2026-05-26T13:12:00Z", 52 * M, 61, 4.18, 214, 38, 3, 0, 0, "clean", 3),
    sess("b4d5f6", "acme-api", "claude", "claude-sonnet-4-6", "2026-05-26T11:40:00Z", 38 * M, 44, 1.92, 132, 22, 2, 0, 1, "clean"),
    sess("c7e8a9", "acme-web", "codex", "gpt-5.4", "2026-05-26T09:05:00Z", 71 * M, 88, 2.34, 96, 44, 1, 1, 2, "friction"),
    sess("d1f2b3", "acme-mobile", "claude", "claude-sonnet-4-6", "2026-05-25T20:18:00Z", 26 * M, 31, 0.88, 67, 12, 1, 0, 0, "clean"),
    sess("e4a5c6", "acme-api", "claude", "claude-opus-4-8", "2026-05-25T16:02:00Z", 94 * M, 112, 5.40, 288, 91, 4, 0, 0, "clean", 2),
    sess("f7b8d9", "acme-billing", "cursor", "claude-haiku-4-5", "2026-05-25T14:22:00Z", 18 * M, 22, 0.31, 41, 9, 1, 0, 0, "clean"),
    sess("a0c1e2", "acme-web", "claude", "claude-opus-4-8", "2026-05-24T22:41:00Z", 63 * M, 74, 3.11, 173, 52, 2, 1, 1, "friction", 1),
    sess("b3d4f5", "acme-mobile", "codex", "gpt-5.4", "2026-05-24T18:09:00Z", 44 * M, 53, 1.05, 84, 31, 1, 0, 0, "clean"),
    sess("c6e7a8", "acme-api", "claude", "claude-sonnet-4-6", "2026-05-24T10:33:00Z", 33 * M, 39, 1.44, 118, 27, 2, 0, 0, "clean"),
    sess("d9f0b1", "acme-web", "claude", "claude-sonnet-4-6", "2026-05-23T21:15:00Z", 29 * M, 35, 1.02, 92, 18, 1, 0, 0, "clean"),
    sess("e2a3c4", "acme-billing", "claude", "claude-haiku-4-5", "2026-05-23T15:48:00Z", 21 * M, 26, 0.44, 58, 14, 1, 0, 0, "clean"),
    sess("f5b6d7", "acme-web", "cursor", "claude-sonnet-4-6", "2026-05-23T11:07:00Z", 47 * M, 57, 1.61, 142, 39, 2, 0, 1, "friction"),
    sess("a8c9e0", "acme-mobile", "claude", "claude-opus-4-8", "2026-05-22T19:52:00Z", 55 * M, 66, 2.87, 156, 43, 3, 0, 0, "clean", 4),
    sess("b1d2f3", "acme-api", "codex", "gpt-5.4", "2026-05-22T13:24:00Z", 39 * M, 47, 0.96, 79, 22, 1, 1, 0, "clean"),
    sess("c4e5a6", "acme-web", "claude", "claude-opus-4-8", "2026-05-21T23:41:00Z", 82 * M, 98, 4.62, 246, 88, 4, 0, 2, "friction"),
    sess("d7f8b9", "acme-billing", "claude", "claude-sonnet-4-6", "2026-05-21T16:18:00Z", 24 * M, 29, 0.79, 63, 16, 1, 0, 0, "clean"),
    sess("e0a1c2", "acme-mobile", "claude", "claude-sonnet-4-6", "2026-05-20T20:03:00Z", 31 * M, 38, 1.13, 88, 19, 1, 0, 0, "clean"),
    sess("f3b4d6", "acme-web", "claude", "claude-haiku-4-5", "2026-05-20T09:47:00Z", 16 * M, 19, 0.28, 34, 7, 1, 0, 0, "clean"),
];

/** Deterministic subagent children returned for any parent's /children call
 *  (the sessions route only knows direct_children_count, not the ids). */
const SESSION_CHILDREN_ROWS = (parentBare: string): ReadonlyArray<SessionListRow> => {
    const parent = `session:${parentBare}`;
    const base = Date.parse("2026-05-26T13:20:00Z");
    return [
        { ...sess(`${parentBare}-sub1`, "acme-web", "claude-subagent", "claude-sonnet-4-6", new Date(base).toISOString(), 12 * M, 14, 0.42, 38, 6, 1, 0, 0, "clean", 0, parent), project: null },
        { ...sess(`${parentBare}-sub2`, "acme-web", "claude-subagent", "claude-haiku-4-5", new Date(base + 14 * M).toISOString(), 7 * M, 9, 0.11, 12, 2, 0, 0, 0, "clean", 0, parent), project: null },
    ];
};

/** Parse ?offset/&limit/&source off a mock /api/sessions URL and page SESSIONS. */
function sessionListResponse(path: string): SessionListResponse {
    const usp = new URLSearchParams(path.split("?")[1] ?? "");
    const source = usp.get("source");
    const offset = Number(usp.get("offset") ?? "0") || 0;
    const limit = Number(usp.get("limit") ?? "200") || 200;
    const filtered = source && source !== "all"
        ? SESSIONS.filter((s) => s.source === source)
        : SESSIONS;
    return {
        sessions: filtered.slice(offset, offset + limit),
        total_count: filtered.length,
        burn_p90: null,
        window: { offset, limit },
    } as unknown as SessionListResponse;
}

// ---------------------------------------------------------------------------
// Cost + routing - all echo the acme story: model spend sums to $2,140/mo
// (opus $1,205 / sonnet $520 / haiku $210 / gpt-5.4 $205), $605 of it routable.
// These match the /team ?demo board's DEMO_CHANNELS / DEMO_ORG numbers exactly.
// ---------------------------------------------------------------------------

const COST_MODELS: CostModelsResult = {
    rows: [
        { model: "claude-opus-4-8", sessions: 210, cost_usd: 1205 },
        { model: "claude-sonnet-4-6", sessions: 276, cost_usd: 520 },
        { model: "claude-haiku-4-5", sessions: 140, cost_usd: 210 },
        { model: "gpt-5.4", sessions: 60, cost_usd: 205 },
    ],
    total_cost_usd: 2140,
};

// Spend split: model rollup (opus 1205 / sonnet 420+100=520 / haiku 210 /
// gpt 205) matches COST_MODELS exactly; main = 1625, subagent = 515.
const COST_SPLIT = {
    rows: [
        { origin: "main", model: "claude-opus-4-8", sessions: 210, cost_usd: 1205, share_pct: 56.3 },
        { origin: "main", model: "claude-sonnet-4-6", sessions: 180, cost_usd: 420, share_pct: 19.6 },
        { origin: "subagent", model: "claude-sonnet-4-6", sessions: 96, cost_usd: 100, share_pct: 4.7 },
        { origin: "subagent", model: "claude-haiku-4-5", sessions: 140, cost_usd: 210, share_pct: 9.8 },
        { origin: "subagent", model: "gpt-5.4", sessions: 60, cost_usd: 205, share_pct: 9.6 },
    ],
    totals: { cost_usd: 2140, sessions: 686 },
};

const COST_CANDIDATE_ROWS = [
    { ts: "2026-05-26T13:20:00Z", description: "summarize acme-web PR diff for review", agent_type: "general-purpose", dispatch_model: "inherit", child_model: "claude-opus-4-8", child_cost_usd: 0.42, routing_match: { classId: "gather", suggest: "haiku" }, suggested_model: "haiku", est_savings_usd: 0.36 },
    { ts: "2026-05-25T16:40:00Z", description: "extract error strings from acme-api logs", agent_type: "general-purpose", dispatch_model: "inherit", child_model: "claude-opus-4-8", child_cost_usd: 0.31, routing_match: { classId: "gather", suggest: "haiku" }, suggested_model: "haiku", est_savings_usd: 0.27 },
    { ts: "2026-05-25T14:05:00Z", description: "rename billing config keys across repo", agent_type: "general-purpose", dispatch_model: "inherit", child_model: "claude-opus-4-8", child_cost_usd: 0.58, routing_match: { classId: "mechanical-impl", suggest: "sonnet" }, suggested_model: "sonnet", est_savings_usd: 0.33 },
    { ts: "2026-05-24T22:12:00Z", description: "look up TanStack Router migration notes", agent_type: "general-purpose", dispatch_model: "inherit", child_model: "claude-opus-4-8", child_cost_usd: 0.44, routing_match: { classId: "niche-research", suggest: "sonnet" }, suggested_model: "sonnet", est_savings_usd: 0.25 },
    { ts: "2026-05-24T11:33:00Z", description: "list unused exports in acme-mobile", agent_type: "general-purpose", dispatch_model: "inherit", child_model: "claude-opus-4-8", child_cost_usd: 0.29, routing_match: { classId: "gather", suggest: "haiku" }, suggested_model: "haiku", est_savings_usd: 0.25 },
    { ts: "2026-05-23T15:58:00Z", description: "scaffold test files for acme-api handlers", agent_type: "general-purpose", dispatch_model: "inherit", child_model: "claude-opus-4-8", child_cost_usd: 0.51, routing_match: { classId: "mechanical-impl", suggest: "sonnet" }, suggested_model: "sonnet", est_savings_usd: 0.29 },
];

const COST_DISPATCHES = {
    candidates: COST_CANDIDATE_ROWS,
    total_est_savings_usd: COST_CANDIDATE_ROWS.reduce((s, c) => s + c.est_savings_usd, 0),
    top_classes: [
        { classId: "gather", savings_usd: 0.88 },
        { classId: "mechanical-impl", savings_usd: 0.62 },
        { classId: "niche-research", savings_usd: 0.25 },
    ],
};

// Routability: routableUsd $605 = the /team demo's routable spend; main = 1625.
const COST_ROUTABILITY = {
    mainSpendUsd: 1625,
    routableUsd: 605,
    routablePct: 37.2,
    estSavingsUsd: 178,
    rows: [
        { class: "gather", verdict: "routable", runs: 38, turns: 96, mainCostUsd: 245, tier: "haiku", repricedUsd: 149, estSavingsUsd: 96 },
        { class: "mechanical-impl", verdict: "routable", runs: 24, turns: 71, mainCostUsd: 210, tier: "sonnet", repricedUsd: 158, estSavingsUsd: 52 },
        { class: "niche-research", verdict: "routable", runs: 14, turns: 43, mainCostUsd: 150, tier: "sonnet", repricedUsd: 120, estSavingsUsd: 30 },
        { class: "review", verdict: "stays", runs: 31, turns: 128, mainCostUsd: 520, tier: null, repricedUsd: null, estSavingsUsd: null },
        { class: "design", verdict: "stays", runs: 12, turns: 64, mainCostUsd: 300, tier: null, repricedUsd: null, estSavingsUsd: null },
        { class: "plan", verdict: "stays", runs: 9, turns: 41, mainCostUsd: 200, tier: null, repricedUsd: null, estSavingsUsd: null },
    ],
    days: 30,
    minRun: 1,
};

const ROUTING_TABLE = {
    version: 1,
    classes: [
        { id: "gather", pattern: "summarize|extract|list|find|search", flags: "i", suggest: "haiku", reason: "read-only gather work belongs on the cheap tier", origin: "default" },
        { id: "mechanical-impl", pattern: "rename|move|format|scaffold|codemod", flags: "i", suggest: "sonnet", reason: "mechanical edits with clear acceptance", origin: "default" },
        { id: "niche-research", pattern: "look up|research|investigate|read the docs", flags: "i", suggest: "sonnet", reason: "bounded research, no judgment call", origin: "default" },
        { id: "acme-triage", pattern: "triage|classify|label", flags: "i", suggest: "sonnet", reason: "team-added routing class", origin: "user" },
    ],
    agentTypes: {},
};

/** Debounced backtest in the routing tuner - returns a plausible result so the
 *  cost view is fully interactive in the demo (live-only save stays gated). */
const ROUTING_BACKTEST = {
    matched: [
        { description: "summarize acme-web PR diff for review", childModel: "claude-opus-4-8", costUsd: 0.42, estSavingsUsd: 0.36 },
        { description: "extract error strings from acme-api logs", childModel: "claude-opus-4-8", costUsd: 0.31, estSavingsUsd: 0.27 },
        { description: "list unused exports in acme-mobile", childModel: "claude-opus-4-8", costUsd: 0.29, estSavingsUsd: 0.25 },
    ],
    excluded: [
        { description: "review architecture decision for billing", childModel: "claude-opus-4-8", costUsd: 0.61, estSavingsUsd: 0 },
    ],
    missed: [
        { description: "investigate flaky acme-api integration test", childModel: "claude-opus-4-8", costUsd: 0.38, estSavingsUsd: 0.22 },
    ],
    estSavingsUsd: 0.88,
    matchedCount: 3,
};

// ---------------------------------------------------------------------------
// Usage - CLI utilization rollup for /usage.
// ---------------------------------------------------------------------------

const USAGE: UsageRollupSchema = {
    windowDays: 30,
    total: 1240,
    activeDays: 22,
    topCommands: [
        { command: "ingest", count: 312, last_used: "2026-05-26T13:40:00Z" },
        { command: "sessions here", count: 188, last_used: "2026-05-26T12:10:00Z" },
        { command: "recall", count: 141, last_used: "2026-05-26T09:22:00Z" },
        { command: "skills weighted", count: 96, last_used: "2026-05-25T18:44:00Z" },
        { command: "cost routability", count: 74, last_used: "2026-05-25T15:03:00Z" },
        { command: "dispatches --candidates", count: 58, last_used: "2026-05-24T22:31:00Z" },
        { command: "otel", count: 41, last_used: "2026-05-24T11:12:00Z" },
    ],
    topCommandsByOrigin: {
        agent: [
            { command: "ingest", count: 298, last_used: "2026-05-26T13:40:00Z" },
            { command: "recall", count: 112, last_used: "2026-05-26T09:22:00Z" },
            { command: "skills weighted", count: 71, last_used: "2026-05-25T18:44:00Z" },
        ],
        tty: [
            { command: "sessions here", count: 154, last_used: "2026-05-26T12:10:00Z" },
            { command: "cost routability", count: 62, last_used: "2026-05-25T15:03:00Z" },
            { command: "dispatches --candidates", count: 44, last_used: "2026-05-24T22:31:00Z" },
        ],
    },
    unusedSurface: ["profile widget", "dojo spar-plan", "routing impact", "directives workflows"],
    originSplit: { agent: 860, tty: 380 },
    reliability: [
        { command: "ingest", runs: 312, failures: 4, failureRate: 0.013 },
        { command: "recall", runs: 141, failures: 2, failureRate: 0.014 },
    ],
};

const EMPTY_SESSION_COMPARE = {
    task_label: null,
    sessions: [],
    winners: { fastest: null, cheapest: null, fewest_tokens: null, cleanest: null },
    not_found: [],
} as never;
const EMPTY_SESSION_INSIGHTS: SessionInsightsPayload = {
    session: "mock",
    phases: [],
    friction_ticks: [],
    commits: [],
    subagent_spans: [],
    checks: [],
    loc: null,
    durability: null,
    delegation_ratio: null,
    skills: [],
    context_curve: [],
    compactions: [],
    baseline: {
        cost_ratio: null,
        friction_ratio: null,
        land_ratio: null,
        cache_pct: null,
    },
};

const EMPTY_TOOL_FAILURES: ToolFailuresResponse = { rows: [], total: 0 } as never;
const EMPTY_GRAPH: GraphExplorerPayload = { mode: "file-attention", limit: 0, nodes: [], edges: [], query: null } as never;
const EMPTY_SKILL_GRAPH: SkillGraphPayload = { min_count: 0, limit: 0, node_count: 0, edge_count: 0, max_edge_count: 0, nodes: [], edges: [] };
const EMPTY_RECALL: RecallResponse = { q: "", hits: [], commits: [], skills: [], truncated: false, total_count: 0, total_counts: { turn: 0, commit: 0, skill: 0 }, window: { offset: 0, limit: 50 } };
/** Deterministic ~14-week activity series for the mock Mission Control / wrapped. */
const MOCK_WRAPPED_DAYS = ((): WrappedProfile["usage"]["days"] => {
    const out: Array<{ date: string; sessions: number; turns: number; tokens: number | null }> = [];
    const start = Date.parse("2026-02-16T00:00:00.000Z");
    for (let i = 0; i < 98; i++) {
        const wobble = Math.sin(i * 0.7) + Math.sin(i * 0.27) * 0.6 + Math.cos(i * 1.3) * 0.4;
        const base = Math.max(0, Math.round((wobble + 1.4) * 2.3));
        const sessions = i % 19 === 0 ? 0 : base;
        out.push({
            date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
            sessions, turns: sessions * 14, tokens: sessions === 0 ? 0 : sessions * 92_000,
        });
    }
    return out;
})();

const MOCK_WRAPPED: WrappedProfile = {
    generatedAt: NOW,
    period: { label: "Last 98 days", startedAt: "2026-02-16T00:00:00.000Z", endedAt: NOW },
    usage: {
        sessions: 412, messages: 8930, totalTokens: 41_800_000, activeDays: 92,
        currentStreakDays: 14, longestStreakDays: 41, peakHour: 23,
        favoriteModel: "claude-fable-5", tokenComparison: "≈ 418 novels of text", days: MOCK_WRAPPED_DAYS,
    },
    primaryArchetype: {
        id: "night-owl-builder", label: "Night-Owl Builder", score: 0.86, confidence: "high",
        publicLine: "You ship hardest after midnight - long, focused build sessions with the lights off.",
        internalExplanation: "73% of tool calls land between 22:00 and 03:00; median session is 47 turns.",
        evidence: [],
    },
    secondaryArchetypes: [], facts: [],
    metrics: { toolCalls: 18_420, toolFailures: 612, distinctTools: 23, distinctSkills: 38, repositories: 6, verificationCalls: 2_140, spawnedAgents: 96 },
    privacy: { publicSafe: true, redactedFields: [] },
    cards: [
        { question: "How many agents at once?", headline: "3", body: "Your busiest session fanned out to three parallel subagents before merging the work back.", sensitivity: "public", position: 0, series: [1, 1, 2, 3, 2, 3, 1, 2, 3, 2, 1, 2], series_label: "concurrent subagents / week" },
        { question: "What did you lean on most?", headline: "superpowers", body: "The superpowers skill pack fired in 41% of your sessions - brainstorming, TDD, and worktrees led.", sensitivity: "public", position: 1, series: [4, 6, 5, 8, 7, 9, 6, 8, 10, 7, 9, 11], series_label: "skill invocations / week" },
        { question: "Where did the tokens go?", headline: "41.8M", body: "Most of your spend rode on claude-fable-5, with cheaper models routed to the mechanical dispatches.", sensitivity: "public", position: 2 },
        { question: "Your longest unbroken run?", headline: "41 days", body: "A six-week streak from March into April - the longest stretch you kept the graph fed every single day.", sensitivity: "public", position: 3 },
    ],
};
const EMPTY_WRAPPED = MOCK_WRAPPED;

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function notFound(): never { throw new Error("mock: 404"); }

function decisionsFromSkills(): { decisions: ReadonlyArray<SkillTriageNote> } {
    return { decisions: SKILLS.flatMap((s) => (s.decision ? [s.decision] : [])) };
}

/** URL-pattern dispatch. Returns a typed mock or throws (404). */
export async function mockFetch<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
    const url = typeof input === "string" ? input : (input as Request).url;
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const method = init?.method ?? "GET";

    // Skills
    if (path === "/api/skills" && method === "GET") {
        return { generatedAt: NOW, skills: SKILLS } satisfies SkillTriageResponse as unknown as T;
    }
    if (path === "/api/decisions" && method === "GET") {
        return decisionsFromSkills() as unknown as T;
    }
    if (/^\/api\/skills\/[^/]+\/detail$/.test(path)) {
        return {
            name: "mock", scope: "user", description: "mock detail",
            dir_path: null,
            invocations: { total: 0, d7: 0, d30: 0, last: null },
            recent: [], corrections: [], proposals: [], paired: [],
        } satisfies SkillDetailPayload as unknown as T;
    }
    if (/^\/api\/skills\/[^/]+\/source$/.test(path)) {
        return {
            name: "mock", scope: "user", dir_path: null, file_path: null,
            frontmatter: null, body: "# mock\n\nThis is a preview.\n",
            state: "active", editable: false, error: null,
        } satisfies SkillSourcePayload as unknown as T;
    }
    if (/^\/api\/skills\/[^/]+\/decide$/.test(path) && method === "POST") {
        const body = init?.body ? (JSON.parse(init.body as string) as { decision: SkillTriageNote["decision"] }) : { decision: "keep" as const };
        const name = decodeURIComponent(path.split("/")[3]);
        return { skill_name: name, decision: body.decision, reason: null, decided_at: new Date().toISOString() } satisfies SkillTriageNote as unknown as T;
    }
    if (/^\/api\/skills\/[^/]+\/decide$/.test(path) && method === "DELETE") {
        const name = decodeURIComponent(path.split("/")[3]);
        return { cleared: true, skill_name: name } as unknown as T;
    }
    if (path === "/api/skills/decide-bulk" && method === "POST") {
        return { notes: [] } as unknown as T;
    }

    // Workflow
    if (path === "/api/workflow") return WORKFLOW as unknown as T;

    // Next Actions
    if (path === "/api/next-actions") return NEXT_ACTIONS as unknown as T;

    // Improve
    if (path === "/api/improve") return IMPROVE as unknown as T;
    if (/^\/api\/improve\/[^/]+\/(accept|reject|verdict)$/.test(path) && method === "POST") {
        return { status: "accepted", message: "(mock) state not persisted in studio preview" } as unknown as T;
    }

    // Cost + routing + usage (all echo the acme $2,140/mo story)
    if (path === "/api/cost/models") return COST_MODELS as unknown as T;
    if (path.startsWith("/api/cost/split")) return COST_SPLIT as unknown as T;
    if (path.startsWith("/api/cost/dispatches")) return COST_DISPATCHES as unknown as T;
    if (path.startsWith("/api/cost/routability")) return COST_ROUTABILITY as unknown as T;
    if (path === "/api/routing/table") return ROUTING_TABLE as unknown as T;
    if (path === "/api/routing/backtest" && method === "POST") return ROUTING_BACKTEST as unknown as T;
    if (path.startsWith("/api/usage")) return USAGE as unknown as T;

    // Sessions
    if (path.startsWith("/api/sessions/compare")) return EMPTY_SESSION_COMPARE as unknown as T;
    if (/^\/api\/sessions\/[^/]+\/insights$/.test(path)) return EMPTY_SESSION_INSIGHTS as unknown as T;
    if (/^\/api\/sessions\/[^/]+\/children$/.test(path)) {
        const parentBare = decodeURIComponent(path.split("/")[3]).replace(/^session:/, "");
        return { parent_session: `session:${parentBare}`, children: SESSION_CHILDREN_ROWS(parentBare) } satisfies SessionChildrenResponse as unknown as T;
    }
    if (path.startsWith("/api/sessions")) return sessionListResponse(path) as unknown as T;
    if (path === "/api/tool-failures" || path.startsWith("/api/tool-failures/")) return EMPTY_TOOL_FAILURES as unknown as T;
    if (path.startsWith("/api/graph-explorer")) return EMPTY_GRAPH as unknown as T;
    if (path.startsWith("/api/skill-graph")) return EMPTY_SKILL_GRAPH as unknown as T;
    if (path.startsWith("/api/recall")) return EMPTY_RECALL as unknown as T;
    if (path === "/api/wrapped" || path === "/api/wrapped/public-preview") return EMPTY_WRAPPED as unknown as T;

    if (path === "/api/wrapped/generate-brief") {
        return { brief: "## Task: Write my Agent Wrapped cards (mock)\n\nConnect a local daemon for the real brief." } as unknown as T;
    }
    if (/^\/api\/improve\/[^/]+\/impact$/.test(path)) {
        return {
            sig: decodeURIComponent(path.split("/")[3]),
            impact: {
                kind: "savings_usd",
                headline: "~$297 redirectable over 30d (mock)",
                detail: "Connect a local daemon for a real estimate.",
                basis: "mock fixture",
                confidence: "indicative",
            },
        } as unknown as T;
    }
    if (path === "/api/improve/analyze-brief") {
        return { brief: "## Task: Deep-analysis pass (mock)\n\nConnect a local daemon for the real brief." } as unknown as T;
    }

    // Lab SQL console
    if (path === "/api/query" && method === "POST") {
        return {
            result: [[{ note: "mock mode - connect a local daemon to run real queries" }]],
            durationMs: 0,
        } as unknown as T;
    }

    notFound();
}
