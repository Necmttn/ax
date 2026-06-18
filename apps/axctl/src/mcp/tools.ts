/**
 * MCP tool registry.
 *
 * Each entry is a self-contained descriptor built through `defineMcpTool`: an
 * MCP-facing name + description + zod input shape, plus a `run` that maps the
 * *already-validated, typed* args onto an ax Effect query and resolves it on the
 * long-lived runtime. The factory is the single boundary that:
 *   - infers `run`'s args from the zod shape via `z.infer<ZodObject<Shape>>`
 *     (NO hand-coercion - the args reaching `run` are typed, not `unknown`);
 *   - parses raw args through the shape ONCE (idempotent with the SDK's own
 *     pre-callback `safeParseAsync`, so direct `tool.run(...)` calls in tests
 *     get the same validated input the live SDK delivers);
 *   - carries a `register(server, rt)` closure that wires the descriptor into
 *     the SDK with `wrapToolResult` / `wrapToolError`. Because the shape stays a
 *     deferred generic `Shape` inside the factory, `registerTool`'s callback
 *     type no longer eagerly expands `objectOutputType<ZodRawShape>` - which is
 *     what hit TS2589 and forced the old `register` cast in `server.ts`.
 *
 * Boundary convention: zod for input validation at the MCP edge (the SDK speaks
 * zod natively); Effect Schema / Effect stays internal to the query functions.
 *
 * Optional-param idiom: under `exactOptionalPropertyTypes: true` you cannot
 * assign `undefined` to an optional prop. zod omits absent optional keys from
 * the parsed object, so the `...(x !== undefined ? { x } : {})` spread callers
 * keep working on the typed args, mirroring `apps/axctl/src/dashboard/server.ts`.
 */
import { z, type ZodRawShape } from "zod";
import { Effect, type ManagedRuntime, type Layer } from "effect";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppLayer } from "@ax/lib/layers";
import { wrapToolError, wrapToolResult } from "./wrap.ts";
import {
    fetchRecall,
    normalizeRecallParams,
    resolveRecallSources,
} from "../dashboard/recall.ts";
import {
    listSessionsAround,
    normalizeSessionsAroundOpts,
} from "../dashboard/sessions-query.ts";
import { fetchEnrichedSession } from "../queries/enriched-session.ts";
import {
    fetchSkillsWeighted,
    normalizeSkillsWeightedParams,
} from "../dashboard/skills-weighted.ts";
import {
    fetchSkillsByRole,
    fetchRolesForSkill,
    fetchAllRoles,
    normalizeSkillsByRoleParams,
} from "../dashboard/role-queries.ts";
import { recommend, normalizeRecommendInput } from "../improve/recommend.ts";
import { showExperiment } from "../improve/show.ts";
import { listProposals, normalizeListProposalsInput } from "../improve/list.ts";
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
import { COST_DEFAULT_WINDOW_DAYS, fetchCostModels, fetchCostSplit } from "../queries/cost-analytics.ts";
import { fetchImageContext } from "../queries/image-context.ts";
import { fetchRoutability } from "../queries/routability.ts";
import { fetchDispatches, fetchDispatchCandidates } from "../queries/dispatch-analytics.ts";
import { loadEffectiveRoutingTable } from "../queries/routing-table-io.ts";
import { buildDispatchesNext, buildCandidatesNext } from "../nav/next-links.ts";
import { assembleAgenda, collectAgendaItems } from "../dojo/agenda.ts";
import { computeBudgetEnvelope } from "../dojo/budget.ts";
import { getQuota } from "../quota/quota.ts";
import { defaultQuotaCachePath } from "../quota/cache.ts";
import { QuotaEnvLive } from "../quota/quota-env.ts";

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
 * A single MCP tool descriptor produced by `defineMcpTool`.
 *
 * `inputSchema` is the zod raw shape (the SDK's `registerTool` accepts it
 * directly and derives the JSON schema). `run` is the type-erased entry point
 * used by direct callers (tests): it parses the raw args through the shape and
 * delegates to the typed inner handler, so it always receives validated input.
 * `register` wires the descriptor into a live `McpServer`.
 */
export interface AxMcpTool {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: ZodRawShape;
    readonly run: (args: Record<string, unknown>, rt: AxRuntime) => Promise<unknown>;
    readonly register: (server: McpServer, rt: AxRuntime) => void;
}

/**
 * The typed spec a tool author writes. `run` receives `z.infer<ZodObject<Shape>>`
 * - fully typed args - and returns a raw JSON-able value.
 */
interface AxMcpToolSpec<Shape extends ZodRawShape> {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Shape;
    readonly run: (args: z.infer<z.ZodObject<Shape>>, rt: AxRuntime) => Promise<unknown>;
}

/**
 * Minimal SDK registration seam. The SDK's `registerTool<InputArgs>` derives its
 * callback type as `ToolCallback<InputArgs>` -> `ShapeOutput<InputArgs>`, a
 * mapped type so deep that instantiating it over ANY `ZodRawShape` (generic or
 * erased) hits TS2589. We pin the registration to this narrow signature so TS
 * never expands that type. Type SAFETY is NOT lost: it has moved UP into
 * `defineMcpTool`'s typed `run` boundary (args are `z.infer<ZodObject<Shape>>`),
 * and the SDK still `safeParse`-validates args against the shape at runtime
 * before the callback fires. This replaces the old broad `server.ts` cast that
 * erased every tool's args to `Record<string, unknown>` and forced per-tool
 * hand-coercion.
 */
type RegisterToolFn = (
    name: string,
    config: { description?: string; inputSchema?: ZodRawShape },
    cb: (args: Record<string, unknown>) => Promise<CallToolResult>,
) => unknown;

/**
 * The typed zod tool factory. Centralises the parse boundary, the
 * `wrapToolResult`/`wrapToolError` envelope, and SDK registration so each tool
 * is just a name + description + zod shape + a typed `run`. The typed `run`
 * boundary is the deepening win: no tool hand-coerces `unknown` args anymore.
 */
export const defineMcpTool = <Shape extends ZodRawShape>(
    spec: AxMcpToolSpec<Shape>,
): AxMcpTool => {
    const schema = z.object(spec.inputSchema);
    // Parse raw args through the shape, then hand the typed result to the inner
    // handler. The SDK already validates before its callback fires (mcp.js
    // safeParseAsync), so this parse is idempotent on the live path; it exists
    // so direct `tool.run(...)` callers (tests) get the same validated input.
    const run = async (args: Record<string, unknown>, rt: AxRuntime): Promise<unknown> =>
        spec.run(schema.parse(args), rt);
    return {
        name: spec.name,
        description: spec.description,
        inputSchema: spec.inputSchema,
        run,
        register: (server, rt) => {
            const register = server.registerTool.bind(server) as unknown as RegisterToolFn;
            register(
                spec.name,
                { description: spec.description, inputSchema: spec.inputSchema },
                async (args) => {
                    try {
                        return wrapToolResult(await run(args, rt));
                    } catch (err) {
                        console.error(`[ax mcp] tool "${spec.name}" failed:`, err);
                        return wrapToolError(err);
                    }
                },
            );
        },
    };
};

const RECALL_SOURCES = ["turn", "commit", "skill"] as const;

const recallTool: AxMcpTool = defineMcpTool({
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
        // No scope param in v0: omit it so fetchRecall defaults to unscoped
        // (all repositories). Real repo-scoping needs the git resolver, which
        // is unfit for a long-lived server - revisit later.
        //
        // Route through the shared recall input contract. This now echoes the
        // RAW q (previously `.trim()`ed here) to match the CLI/HTTP echo and the
        // buildRecallNext follow-up links - a deliberate contract invariant.
        const params = normalizeRecallParams({
            q: args.q,
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
            ...(args.sources && args.sources.length > 0 ? { sources: args.sources } : {}),
        });

        const result = await rt.runPromise(fetchRecall(params));
        const { hits, next } = buildRecallNext(result, {
            requestedSources: resolveRecallSources(params.sources),
        });
        return { ...result, hits, next };
    },
});

const sessionsAroundTool: AxMcpTool = defineMcpTool({
    name: "sessions_around",
    description:
        `List agent sessions in a time window centred on a date (default +/-3 days). Returns an envelope { sessions, next } - session rows with turn counts and the first user message. Use to find what work happened around a given day. ${NEXT_PROTOCOL_HINT}`,
    inputSchema: {
        date: z
            .string()
            // The lone bespoke check (was a hand-thrown Error in `run`) now lives
            // in the schema as a `.refine`, so an invalid date yields the same
            // uniform validation envelope every other bad arg does.
            .refine((s) => !Number.isNaN(new Date(s).getTime()), {
                message: "Invalid date. Expected an ISO timestamp or YYYY-MM-DD.",
            })
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
        const opts = normalizeSessionsAroundOpts({
            date: new Date(args.date),
            ...(args.days !== undefined ? { days: args.days } : {}),
            ...(args.project !== undefined ? { project: args.project } : {}),
        });
        const rows = await rt.runPromise(listSessionsAround(opts));
        return buildSessionsNext(rows, {
            date: args.date,
            ...(args.days !== undefined ? { days: args.days } : {}),
            ...(args.project !== undefined ? { project: args.project } : {}),
        });
    },
});

const sessionShowTool: AxMcpTool = defineMcpTool({
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
        const expand = new Set(args.expand ?? []);
        const expandAll = args.expandAll === true;
        // Read through the Enriched Session facade (the single home for
        // assembling a session read model). The MCP tool needs the Session View
        // base only - no metrics/insights - so the response shape is the bare
        // SessionViewPayload, identical to the former fetchSessionShow call.
        const enriched = await rt.runPromise(
            fetchEnrichedSession({
                sessionId: args.sessionId,
                base: {
                    kind: "view",
                    expand,
                    expandAll,
                    ...(args.byRole !== undefined ? { byRole: args.byRole } : {}),
                },
            }),
        );
        const payload = enriched.view!;
        return { ...payload, next: buildSessionShowNext(payload) };
    },
});

const skillsWeightedTool: AxMcpTool = defineMcpTool({
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
        const params = normalizeSkillsWeightedParams({
            ...(args.windowDays !== undefined ? { windowDays: args.windowDays } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
        });
        const result = await rt.runPromise(fetchSkillsWeighted(params));
        return { ...result, next: buildSkillsWeightedNext(result) };
    },
});

const skillsByRoleTool: AxMcpTool = defineMcpTool({
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
        const params = normalizeSkillsByRoleParams({
            role: args.role,
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
        });
        const result = await rt.runPromise(fetchSkillsByRole(params));
        return { ...result, next: buildSkillsByRoleNext(result, args.role) };
    },
});

const skillsRolesTool: AxMcpTool = defineMcpTool({
    name: "skills_roles",
    description:
        `List the roles a given skill plays, with weights, source, confidence and rationale. Returns whether the skill exists. The inverse of skills_by_role. ${NEXT_PROTOCOL_HINT}`,
    inputSchema: {
        skill: z
            .string()
            .describe("Skill name to look up roles for (required)."),
    },
    run: async (args, rt) => {
        const result = await rt.runPromise(fetchRolesForSkill({ skill: args.skill }));
        return { ...result, next: buildSkillsRolesNext(result, args.skill) };
    },
});

const rolesTool: AxMcpTool = defineMcpTool({
    name: "roles",
    description:
        `List the full role vocabulary with each role's weight and the number of skills classified into it. Use to discover valid role labels for skills_by_role. ${NEXT_PROTOCOL_HINT}`,
    inputSchema: {},
    run: async (_args, rt) => {
        const result = await rt.runPromise(fetchAllRoles());
        return { ...result, next: buildRolesNext(result) };
    },
});

const RECOMMEND_AGENTS = ["claude", "codex"] as const;

const improveRecommendTool: AxMcpTool = defineMcpTool({
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
        // cwd/project are deliberately not exposed (they are cwd-bound and
        // meaningless at the MCP boundary). The MCP limit default is 10 (the
        // CLI's is 5) - both pass their own default into the shared normalizer,
        // which is why `defaultLimit` is a parameter rather than baked in.
        const input = normalizeRecommendInput(
            {
                ...(args.limit !== undefined ? { limit: args.limit } : {}),
                ...(args.forms !== undefined ? { forms: args.forms } : {}),
                ...(args.agent !== undefined ? { agent: args.agent } : {}),
                ...(args.sinceDays !== undefined ? { sinceDays: args.sinceDays } : {}),
            },
            10,
        );
        const items = await rt.runPromise(recommend(input));
        const next = buildImproveProposalsNext(
            items.map((i) => ({ sig: i.shortId, title: i.title })),
        );
        return { proposals: items, next };
    },
});

const improveShowTool: AxMcpTool = defineMcpTool({
    name: "improve_show",
    description:
        "Show one experiment's evidence trail: the proposal, its experiment, and recent checkpoints. Returns null if no proposal/experiment matches. Use to inspect a single improve_recommend / improve_list entry.",
    inputSchema: {
        sigOrId: z
            .string()
            .describe("Proposal dedupe signature or experiment id (required)."),
    },
    run: async (args, rt) => {
        // null is a valid result (no match) - return it as plain JSON.
        return await rt.runPromise(showExperiment({ sigOrId: args.sigOrId }));
    },
});

const improveListTool: AxMcpTool = defineMcpTool({
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
        const input = normalizeListProposalsInput({
            ...(args.status !== undefined ? { status: args.status } : {}),
            ...(args.form !== undefined ? { form: args.form } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
        });
        const rows = await rt.runPromise(listProposals(input));
        const next = buildImproveProposalsNext(
            rows.map((r) => ({ sig: r.dedupe_sig, title: r.title })),
        );
        return { proposals: rows, next };
    },
});

const sessionMetricsTool: AxMcpTool = defineMcpTool({
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
        // Mirror the CLI's clamp (1..3650 days) so MCP and `ax sessions metrics`
        // agree on window semantics.
        const since = args.sinceDays !== undefined
            ? new Date(Date.now() - Math.min(Math.max(Math.trunc(args.sinceDays), 1), 3650) * 86_400_000)
            : null;
        const limit = args.limit ?? 50;
        const project =
            args.project !== undefined && args.project.length > 0 ? args.project : null;
        return await rt.runPromise(fetchSessionMetrics({ since, limit, project }));
    },
});

const signalShowTool: AxMcpTool = defineMcpTool({
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
        // A blank id is treated as "list the catalog" - domain semantics, not
        // type coercion, so the trim/empty branch stays.
        const id = args.id !== undefined && args.id.trim().length > 0 ? args.id.trim() : undefined;
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
        const limit = args.limit ?? 30;
        const all = await rt.runPromise(runRelationSignal(descriptor.id));
        const edges = [...all].sort((a, b) => b.weight - a.weight).slice(0, limit);
        return { signal: descriptor, edges };
    },
});

const costModelsTool: AxMcpTool = defineMcpTool({
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
        const days = args.days ?? COST_DEFAULT_WINDOW_DAYS;
        const result = await rt.runPromise(fetchCostModels({ sinceDays: days }));
        return { ...result, next: buildCostModelsNext(result) };
    },
});

const costSplitTool: AxMcpTool = defineMcpTool({
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
        const days = args.days ?? COST_DEFAULT_WINDOW_DAYS;
        const result = await rt.runPromise(fetchCostSplit({ sinceDays: days }));
        return { ...result, next: buildCostSplitNext(result) };
    },
});

const costImagesTool: AxMcpTool = defineMcpTool({
    name: "cost_images",
    description:
        "Per-session image-read context (content_type:binary tool outputs), split main-thread vs subagent. High main-thread MB = screenshots persisting in the main context window and re-billing across turns; route visual judgment to a subagent.",
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
            .describe("Max session rows to return (default 20)."),
    },
    run: async (args, rt) => {
        const sinceDays = args.days ?? COST_DEFAULT_WINDOW_DAYS;
        const limit = args.limit ?? 20;
        return await rt.runPromise(fetchImageContext({ sinceDays, limit }));
    },
});

const costRoutabilityTool: AxMcpTool = defineMcpTool({
    name: "cost_routability",
    description:
        `Main-thread routability lens: of main-agent (non-subagent) spend, how much sat in routable class-runs (gather, mechanical-impl / niche-research) vs genuine judgment, with estimated savings repriced one tier down. Covers Claude (-> haiku/sonnet) AND Codex (-> gpt-5-nano/gpt-5-mini), classified + repriced separately; the result has a per-provider breakdown in 'providers' plus combined totals. Deterministic (tool composition + JUDGMENT_GUARD_RE text guard); turn-level by default. Use to see how much main-thread work could have been a cheaper subagent. ${NEXT_PROTOCOL_HINT}`,
    inputSchema: {
        days: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Window in days (default 30)."),
        min_run: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Min consecutive same-class turns for a span to count (default 1)."),
    },
    run: async (args, rt) => {
        const days = args.days ?? 30;
        const minRun = args.min_run ?? 1;
        const result = await rt.runPromise(fetchRoutability({ days, minRun }));
        return result;
    },
});

const dispatchesTool: AxMcpTool = defineMcpTool({
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
        const days = args.days ?? COST_DEFAULT_WINDOW_DAYS;
        const candidates = args.candidates === true;
        if (candidates) {
            // Match against the live routing table (same file the hook and the
            // CLI candidates path read), not the baked-in defaults.
            const result = await rt.runPromise(
                Effect.gen(function* () {
                    const table = yield* loadEffectiveRoutingTable();
                    return yield* fetchDispatchCandidates({ sinceDays: days, table });
                }),
            );
            return { ...result, next: buildCandidatesNext(result) };
        }
        const limit = args.limit ?? 30;
        const result = await rt.runPromise(fetchDispatches({ sinceDays: days, limit }));
        return { ...result, next: buildDispatchesNext(result) };
    },
});

const dojoAgendaTool: AxMcpTool = defineMcpTool({
    name: "dojo_agenda",
    description:
        "Dojo training agenda for surplus-quota self-improvement: budget envelope (window remaining minus reserve, deadline = window reset) + prioritized work items (pending verdicts, unfilled briefs, routing backtests, proposal minting, churn experiments, optional sparring). Mirrors `ax dojo agenda`. Read-only.",
    inputSchema: {
        days: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Window in days (default 30)."),
        spar: z
            .boolean()
            .optional()
            .describe("Include opt-in sparring items (needs spendable headroom)."),
    },
    run: async (args, rt) => {
        const nowMs = Date.now();
        const days = args.days ?? 30;
        const spar = args.spar === true;
        return await rt.runPromise(
            Effect.gen(function* () {
                const quota = yield* getQuota(
                    { cachePath: defaultQuotaCachePath(), maxAgeSeconds: 60, nowMs },
                ).pipe(
                    Effect.map((r) => r.snapshot),
                    Effect.catch(() => Effect.succeed(null)),
                );
                const envelope = computeBudgetEnvelope(
                    quota,
                    { budgetPctOverride: null, untilIso: null, force: false },
                    nowMs,
                );
                const collected = yield* collectAgendaItems({ nowMs, days, spar });
                return assembleAgenda(envelope, collected.items, {
                    nowMs,
                    spar,
                    sourceFailures: collected.source_failures,
                });
            }).pipe(Effect.provide(QuotaEnvLive)),
        );
    },
});

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
    costImagesTool,
    costRoutabilityTool,
    dispatchesTool,
    dojoAgendaTool,
];
