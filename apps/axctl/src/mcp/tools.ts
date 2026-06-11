/**
 * MCP tool registry.
 *
 * Each entry is a self-contained descriptor: an MCP-facing name + description +
 * zod input shape, plus a `run` that maps the validated args onto an ax Effect
 * query and resolves it on the long-lived runtime. `server.ts` iterates this
 * array and wraps every result in the MCP content envelope, so adding a tool
 * (Task 3) means only appending a descriptor here - no transport changes.
 *
 * Boundary convention: zod for input validation at the MCP edge (the SDK speaks
 * zod natively); Effect Schema / Effect stays internal to the query functions.
 *
 * Optional-param idiom: under `exactOptionalPropertyTypes: true` you cannot
 * assign `undefined` to an optional prop. We build params with object spread -
 * `...(x !== undefined ? { x } : {})` - instead of `as`-casts, mirroring
 * `apps/axctl/src/dashboard/server.ts`.
 */
import { z, type ZodRawShape } from "zod";
import type { ManagedRuntime, Layer } from "effect";
import type { AppLayer } from "@ax/lib/layers";
import {
    fetchRecall,
    type RecallParams,
    type RecallSource,
} from "../dashboard/recall.ts";
import {
    listSessionsAround,
    type SessionsAroundOpts,
} from "../dashboard/sessions-query.ts";
import { fetchSessionShow } from "../dashboard/session-show.ts";
import type { FetchSessionViewOptions } from "../dashboard/session-view.ts";
import {
    fetchSkillsWeighted,
    type SkillsWeightedParams,
} from "../dashboard/skills-weighted.ts";
import {
    fetchSkillsByRole,
    fetchRolesForSkill,
    fetchAllRoles,
    type FetchSkillsByRoleParams,
} from "../dashboard/role-queries.ts";
import { recommend, type RecommendInput } from "../improve/recommend.ts";
import { showExperiment } from "../improve/show.ts";
import { listProposals, type ListProposalsInput } from "../improve/list.ts";
import { fetchSessionMetrics } from "../metrics/session-metrics-query.ts";
import { SIGNAL_CATALOG, findSignal, runRelationSignal } from "../metrics/catalog.ts";
import {
    NEXT_PROTOCOL_HINT,
    buildRecallNext,
    buildSessionsNext,
    buildSessionShowNext,
    buildSkillsWeightedNext,
    buildSkillsByRoleNext,
    buildSkillsRolesNext,
    buildRolesNext,
    buildImproveProposalsNext,
    buildCostModelsNext,
    buildCostSplitNext,
} from "../nav/next-links.ts";
import { fetchCostModels, fetchCostSplit } from "../queries/cost-analytics.ts";
import { fetchDispatches, fetchDispatchCandidates } from "../queries/dispatch-analytics.ts";
import { buildDispatchesNext, buildCandidatesNext } from "../nav/next-links.ts";

/**
 * The long-lived MCP runtime, built from `AppLayer` (SurrealClient + config +
 * trace transport). The service/error params are derived from the layer so they
 * stay in sync if `AppLayer` changes.
 */
export type AxRuntime = ManagedRuntime.ManagedRuntime<
    Layer.Success<typeof AppLayer>,
    Layer.Error<typeof AppLayer>
>;

/**
 * A single MCP tool descriptor. `inputSchema` is a zod raw shape (the SDK's
 * `registerTool` accepts this directly and derives the JSON schema + arg type).
 * `run` receives the validated args and the runtime; it returns a raw JSON-able
 * value, which `server.ts` serialises into the MCP text content envelope.
 */
export interface AxMcpTool {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: ZodRawShape;
    readonly run: (args: Record<string, unknown>, rt: AxRuntime) => Promise<unknown>;
}

const RECALL_SOURCES = ["turn", "commit", "skill"] as const;

const recallTool: AxMcpTool = {
    name: "recall",
    description:
        `Full-text recall across the ax graph: search turns (conversation excerpts), git commits, and skills. Returns scored hits with source, excerpt, and provenance. ${NEXT_PROTOCOL_HINT}`,
    inputSchema: {
        q: z.string().describe("Search query (required). Matched against turn text, commit messages, and skill metadata."),
        limit: z
            .number()
            .int()
            .positive()
            .max(200)
            .optional()
            .describe("Max hits to return (default 50, max 200)."),
        sources: z
            .array(z.enum(RECALL_SOURCES))
            .optional()
            .describe('Which sources to search. Defaults to ["turn"]. Any of "turn", "commit", "skill".'),
    },
    run: async (args, rt) => {
        const q = String(args.q ?? "").trim();
        const limit = typeof args.limit === "number" ? args.limit : undefined;
        const sources = Array.isArray(args.sources)
            ? (args.sources.filter((s): s is RecallSource =>
                  RECALL_SOURCES.includes(s as RecallSource),
              ))
            : undefined;
        // No scope param in v0: omit it so fetchRecall defaults to unscoped
        // (all repositories). Real repo-scoping needs the git resolver, which
        // is unfit for a long-lived server - revisit later.
        const params: RecallParams = {
            q,
            ...(limit !== undefined ? { limit } : {}),
            ...(sources && sources.length > 0 ? { sources } : {}),
        };

        const result = await rt.runPromise(fetchRecall(params));
        const { hits, next } = buildRecallNext(result, {
            requestedSources: params.sources ?? ["turn"],
        });
        return { ...result, hits, next };
    },
};

const sessionsAroundTool: AxMcpTool = {
    name: "sessions_around",
    description:
        `List agent sessions in a time window centred on a date (default +/-3 days). Returns an envelope { sessions, next } - session rows with turn counts and the first user message. Use to find what work happened around a given day. ${NEXT_PROTOCOL_HINT}`,
    inputSchema: {
        date: z
            .string()
            .describe("Centre date (required). ISO timestamp or YYYY-MM-DD."),
        days: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Half-width of the window in days (default 3)."),
        project: z
            .string()
            .optional()
            .describe("Optional Claude project slug to filter sessions to."),
    },
    run: async (args, rt) => {
        const dateStr = String(args.date ?? "");
        const date = new Date(dateStr);
        if (Number.isNaN(date.getTime())) {
            throw new Error(`Invalid date: ${JSON.stringify(args.date)}. Expected an ISO timestamp or YYYY-MM-DD.`);
        }
        const days = typeof args.days === "number" ? args.days : undefined;
        const project = typeof args.project === "string" ? args.project : undefined;
        const opts: SessionsAroundOpts = {
            date,
            ...(days !== undefined ? { days } : {}),
            ...(project !== undefined ? { project } : {}),
        };
        const rows = await rt.runPromise(listSessionsAround(opts));
        return buildSessionsNext(rows, {
            date: dateStr,
            ...(days !== undefined ? { days } : {}),
            ...(project !== undefined ? { project } : {}),
        });
    },
};

const sessionShowTool: AxMcpTool = {
    name: "session_show",
    description:
        `Show one session in detail: base facts, optionally expanded subagent children, and optional skill-by-role grouping. Use after sessions_around / recall to drill into a specific session id. ${NEXT_PROTOCOL_HINT}`,
    inputSchema: {
        sessionId: z
            .string()
            .describe("Session id to show (required)."),
        expand: z
            .array(z.string())
            .optional()
            .describe("Subagent session ids (or fragments) to expand inline. Default: none."),
        expandAll: z
            .boolean()
            .optional()
            .describe("Expand ALL subagent children regardless of `expand` (default false)."),
        byRole: z
            .boolean()
            .optional()
            .describe("Group the session's top skills by their role classifications."),
    },
    run: async (args, rt) => {
        const sessionId = String(args.sessionId ?? "");
        const expand = Array.isArray(args.expand)
            ? new Set(args.expand.map((v) => String(v)))
            : new Set<string>();
        const expandAll = args.expandAll === true;
        const byRole = typeof args.byRole === "boolean" ? args.byRole : undefined;
        const opts: FetchSessionViewOptions = {
            sessionId,
            expand,
            expandAll,
            ...(byRole !== undefined ? { byRole } : {}),
        };
        const payload = await rt.runPromise(fetchSessionShow(opts));
        return { ...payload, next: buildSessionShowNext(payload) };
    },
};

const skillsWeightedTool: AxMcpTool = {
    name: "skills_weighted",
    description:
        `Rank skills by usage x role-weight (score = invocations x role-weight). Returns ranked rows plus a doctor summary of unclassified skills. Use to see which skills actually carry weight in recent work. ${NEXT_PROTOCOL_HINT}`,
    inputSchema: {
        windowDays: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Only count invocations within the last N days (default: all time)."),
        limit: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Max ranked rows to return (default 25)."),
    },
    run: async (args, rt) => {
        const windowDays = typeof args.windowDays === "number" ? args.windowDays : undefined;
        const limit = typeof args.limit === "number" ? args.limit : undefined;
        const params: SkillsWeightedParams = {
            ...(windowDays !== undefined ? { windowDays } : {}),
            ...(limit !== undefined ? { limit } : {}),
        };
        const result = await rt.runPromise(fetchSkillsWeighted(params));
        return { ...result, next: buildSkillsWeightedNext(result) };
    },
};

const skillsByRoleTool: AxMcpTool = {
    name: "skills_by_role",
    description:
        `List skills tagged with a given role, ranked by invocation count. Returns rows with source/confidence/rationale and whether any skill matched the role. ${NEXT_PROTOCOL_HINT}`,
    inputSchema: {
        role: z
            .string()
            .describe("Role name to look up (required)."),
        limit: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Max skills to return (default 50)."),
    },
    run: async (args, rt) => {
        const role = String(args.role ?? "");
        const limit = typeof args.limit === "number" ? args.limit : undefined;
        const params: FetchSkillsByRoleParams = {
            role,
            ...(limit !== undefined ? { limit } : {}),
        };
        const result = await rt.runPromise(fetchSkillsByRole(params));
        return { ...result, next: buildSkillsByRoleNext(result, role) };
    },
};

const skillsRolesTool: AxMcpTool = {
    name: "skills_roles",
    description:
        `List the roles a given skill plays, with weights, source, confidence and rationale. Returns whether the skill exists. The inverse of skills_by_role. ${NEXT_PROTOCOL_HINT}`,
    inputSchema: {
        skill: z
            .string()
            .describe("Skill name to look up roles for (required)."),
    },
    run: async (args, rt) => {
        const skill = String(args.skill ?? "");
        const result = await rt.runPromise(fetchRolesForSkill({ skill }));
        return { ...result, next: buildSkillsRolesNext(result, skill) };
    },
};

const rolesTool: AxMcpTool = {
    name: "roles",
    description:
        `List the full role vocabulary with each role's weight and the number of skills classified into it. Use to discover valid role labels for skills_by_role. ${NEXT_PROTOCOL_HINT}`,
    inputSchema: {},
    run: async (_args, rt) => {
        const result = await rt.runPromise(fetchAllRoles());
        return { ...result, next: buildRolesNext(result) };
    },
};

const RECOMMEND_AGENTS = ["claude", "codex"] as const;

const improveRecommendTool: AxMcpTool = {
    name: "improve_recommend",
    description:
        `Rank open self-improvement proposals by confidence x recency x frequency. Returns an envelope { proposals, next } - the shortlist of grounded suggestions the agent could accept. Use to surface what to improve next. ${NEXT_PROTOCOL_HINT}`,
    inputSchema: {
        limit: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Max proposals to return (default 10)."),
        forms: z
            .array(z.string())
            .optional()
            .describe("Filter to these proposal forms (e.g. skill, hook, rule)."),
        agent: z
            .enum(RECOMMEND_AGENTS)
            .optional()
            .describe('Filter to a single agent: "claude" or "codex".'),
        sinceDays: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Only proposals updated within the last N days."),
    },
    run: async (args, rt) => {
        // `limit` is required on RecommendInput with no internal default - so
        // default it to 10 here. cwd/project are deliberately not exposed (they
        // are cwd-bound and meaningless at the MCP boundary).
        const limit = typeof args.limit === "number" ? args.limit : 10;
        const forms = Array.isArray(args.forms)
            ? args.forms.map((v) => String(v))
            : undefined;
        const agent =
            args.agent === "claude" || args.agent === "codex" ? args.agent : undefined;
        const sinceDays = typeof args.sinceDays === "number" ? args.sinceDays : undefined;
        const input: RecommendInput = {
            limit,
            ...(forms !== undefined ? { forms } : {}),
            ...(agent !== undefined ? { agent } : {}),
            ...(sinceDays !== undefined ? { sinceDays } : {}),
        };
        const items = await rt.runPromise(recommend(input));
        const next = buildImproveProposalsNext(
            items.map((i) => ({ sig: i.shortId, title: i.title })),
        );
        return { proposals: items, next };
    },
};

const improveShowTool: AxMcpTool = {
    name: "improve_show",
    description:
        "Show one experiment's evidence trail: the proposal, its experiment, and recent checkpoints. Returns null if no proposal/experiment matches. Use to inspect a single improve_recommend / improve_list entry.",
    inputSchema: {
        sigOrId: z
            .string()
            .describe("Proposal dedupe signature or experiment id (required)."),
    },
    run: async (args, rt) => {
        const sigOrId = String(args.sigOrId ?? "");
        // null is a valid result (no match) - return it as plain JSON.
        return await rt.runPromise(showExperiment({ sigOrId }));
    },
};

const improveListTool: AxMcpTool = {
    name: "improve_list",
    description:
        `List the experiment-loop proposal shortlist, filterable by status and form. Returns an envelope { proposals, next } - proposal rows ordered by frequency. Use to browse proposals beyond the ranked improve_recommend view. ${NEXT_PROTOCOL_HINT}`,
    inputSchema: {
        status: z
            .string()
            .optional()
            .describe('Status filter (default "open"; pass "all" to disable).'),
        form: z
            .string()
            .optional()
            .describe("Filter to a single proposal form."),
        limit: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Max proposals to return (default 30)."),
    },
    run: async (args, rt) => {
        const status = typeof args.status === "string" ? args.status : undefined;
        const form = typeof args.form === "string" ? args.form : undefined;
        const limit = typeof args.limit === "number" ? args.limit : undefined;
        const input: ListProposalsInput = {
            ...(status !== undefined ? { status } : {}),
            ...(form !== undefined ? { form } : {}),
            ...(limit !== undefined ? { limit } : {}),
        };
        const rows = await rt.runPromise(listProposals(input));
        const next = buildImproveProposalsNext(
            rows.map((r) => ({ sig: r.dedupe_sig, title: r.title })),
        );
        return { proposals: rows, next };
    },
};

const sessionMetricsTool: AxMcpTool = {
    name: "session_metrics",
    description:
        "Graph-derived per-session metrics: durability ratio (commits not later reverted), produced commits, time-to-land (commit -> PR merge), lines added/removed, first-edit latency, cold-start reads, delegation ratio, estimated cost, and user corrections. Sorted by produced commits (desc), then most fragile first.",
    inputSchema: {
        sinceDays: z
            .number()
            .int()
            .positive()
            .max(3650)
            .optional()
            .describe("Only sessions started within the last N days (default: all time)."),
        limit: z
            .number()
            .int()
            .positive()
            .max(500)
            .optional()
            .describe("Max session rows to return (default 50, max 500)."),
        project: z
            .string()
            .optional()
            .describe("Filter to sessions whose project or cwd equals this path (e.g. a repo root)."),
    },
    run: async (args, rt) => {
        const sinceDays = typeof args.sinceDays === "number" ? args.sinceDays : undefined;
        // Mirror the CLI's clamp (1..3650 days) so MCP and `ax sessions metrics`
        // agree on window semantics.
        const since = sinceDays !== undefined
            ? new Date(Date.now() - Math.min(Math.max(Math.trunc(sinceDays), 1), 3650) * 86_400_000)
            : null;
        const limit = typeof args.limit === "number" ? args.limit : 50;
        const project =
            typeof args.project === "string" && args.project.length > 0
                ? args.project
                : null;
        return await rt.runPromise(fetchSessionMetrics({ since, limit, project }));
    },
};

const signalShowTool: AxMcpTool = {
    name: "signal_show",
    description:
        "Signal catalog access. With no `id`: list all signal descriptors (id, kind, label, description). With an `id` (e.g. fragility_cascade): run that relation signal and return its edges sorted by weight (descending). Unknown ids error with the list of valid ids.",
    inputSchema: {
        id: z
            .string()
            .optional()
            .describe('Signal id to run (e.g. "fragility_cascade"). Omit to list the catalog.'),
        limit: z
            .number()
            .int()
            .positive()
            .max(500)
            .optional()
            .describe("Max edges to return when running a signal (default 30)."),
    },
    run: async (args, rt) => {
        const id =
            typeof args.id === "string" && args.id.trim().length > 0
                ? args.id.trim()
                : undefined;
        if (id === undefined) {
            return { signals: SIGNAL_CATALOG };
        }
        const descriptor = findSignal(id);
        if (descriptor === undefined) {
            const ids = SIGNAL_CATALOG.map((s) => s.id).join(", ");
            throw new Error(`Unknown signal "${id}". Valid ids: ${ids}`);
        }
        if (descriptor.kind !== "relation") {
            // Mirrors the CLI: aggregate signals have no runnable rendering yet.
            return {
                signal: descriptor,
                edges: null,
                note: "aggregate signals are not runnable via MCP yet",
            };
        }
        const limit = typeof args.limit === "number" ? args.limit : 30;
        const all = await rt.runPromise(runRelationSignal(descriptor.id));
        const edges = [...all].sort((a, b) => b.weight - a.weight).slice(0, limit);
        return { signal: descriptor, edges };
    },
};

const costModelsTool: AxMcpTool = {
    name: "cost_models",
    description:
        `Per-model cost rollup over session_token_usage: sessions count, prompt/completion/cache tokens, estimated cost USD, sorted by cost desc. Includes an "(unattributed)" row for sessions with no model recorded. ${NEXT_PROTOCOL_HINT}`,
    inputSchema: {
        days: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Window in days (default 14)."),
    },
    run: async (args, rt) => {
        const days = typeof args.days === "number" ? args.days : 14;
        const result = await rt.runPromise(fetchCostModels({ sinceDays: days }));
        return { ...result, next: buildCostModelsNext(result) };
    },
};

const costSplitTool: AxMcpTool = {
    name: "cost_split",
    description:
        `Cost matrix split by origin (main = non-subagent, subagent = claude-subagent) x model. Returns rows with cost, token sums, and share-of-total percent, plus a totals row. Use to understand how much subagent dispatch costs relative to top-level sessions. ${NEXT_PROTOCOL_HINT}`,
    inputSchema: {
        days: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Window in days (default 14)."),
    },
    run: async (args, rt) => {
        const days = typeof args.days === "number" ? args.days : 14;
        const result = await rt.runPromise(fetchCostSplit({ sinceDays: days }));
        return { ...result, next: buildCostSplitNext(result) };
    },
};

const dispatchesTool: AxMcpTool = {
    name: "dispatches",
    description:
        `Subagent dispatch analytics over the spawned relation. Without candidates: table of dispatches sorted by child cost (ts, agent_type, description, dispatch_model, child_model, child_cost_usd) + summary (count, inherit%, total cost). With candidates=true: only inherit dispatches on expensive models (fable/opus) that match a routing class, with suggested model + est savings. ${NEXT_PROTOCOL_HINT}`,
    inputSchema: {
        days: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Window in days (default 14)."),
        limit: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Max dispatch rows to return (default 30). Ignored when candidates=true."),
        candidates: z
            .boolean()
            .optional()
            .describe("When true, return only routing-optimisation candidates with est savings."),
    },
    run: async (args, rt) => {
        const days = typeof args.days === "number" ? args.days : 14;
        const candidates = args.candidates === true;
        if (candidates) {
            const result = await rt.runPromise(fetchDispatchCandidates({ sinceDays: days }));
            return { ...result, next: buildCandidatesNext(result) };
        }
        const limit = typeof args.limit === "number" ? args.limit : 30;
        const result = await rt.runPromise(fetchDispatches({ sinceDays: days, limit }));
        return { ...result, next: buildDispatchesNext(result) };
    },
};

/**
 * All registered MCP tools. `server.ts` iterates this array to register +
 * wrap each one.
 *
 * Deliberately deferred (NOT in v0): `sessions_here` and `sessions_near`. Both
 * need a resolved git `repositoryKey` / commit-window from the CLI's cwd+git
 * resolver, which `process.exit`s and is unfit for a long-lived server. They
 * are a documented follow-up.
 */
export const axMcpTools: ReadonlyArray<AxMcpTool> = [
    recallTool,
    sessionsAroundTool,
    sessionShowTool,
    skillsWeightedTool,
    skillsByRoleTool,
    skillsRolesTool,
    rolesTool,
    improveRecommendTool,
    improveShowTool,
    improveListTool,
    sessionMetricsTool,
    signalShowTool,
    costModelsTool,
    costSplitTool,
    dispatchesTool,
];
