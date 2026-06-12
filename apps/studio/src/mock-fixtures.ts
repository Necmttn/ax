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

const EMPTY_SESSION_LIST: SessionListResponse = {
    sessions: [],
    total: 0,
    offset: 0,
    limit: 200,
} as never;

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
const EMPTY_WRAPPED: WrappedProfile = { generatedAt: NOW, ready: false, sections: [] } as never;

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

    // Empties
    if (path.startsWith("/api/sessions/compare")) return EMPTY_SESSION_COMPARE as unknown as T;
    if (/^\/api\/sessions\/[^/]+\/insights$/.test(path)) return EMPTY_SESSION_INSIGHTS as unknown as T;
    if (path.startsWith("/api/sessions")) return EMPTY_SESSION_LIST as unknown as T;
    if (path === "/api/tool-failures" || path.startsWith("/api/tool-failures/")) return EMPTY_TOOL_FAILURES as unknown as T;
    if (path.startsWith("/api/graph-explorer")) return EMPTY_GRAPH as unknown as T;
    if (path.startsWith("/api/skill-graph")) return EMPTY_SKILL_GRAPH as unknown as T;
    if (path.startsWith("/api/recall")) return EMPTY_RECALL as unknown as T;
    if (path === "/api/wrapped" || path === "/api/wrapped/public-preview") return EMPTY_WRAPPED as unknown as T;

    if (path === "/api/wrapped/generate-brief") {
        return { brief: "## Task: Write my Agent Wrapped cards (mock)\n\nConnect a local daemon for the real brief." } as unknown as T;
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
