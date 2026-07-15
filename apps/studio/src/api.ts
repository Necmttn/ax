import type {
    ImpactEstimate,
    EpisodeTimelinePayload,
    GraphExplorerMode,
    GraphExplorerPayload,
    ImproveActionResponse,
    ImprovePayload,
    NextActionsPayload,
    ProjectPagePayload,
    RecallResponse,
    RunEvidencePayload,
    SkillGraphPayload,
    SessionCanvasPayload,
    SessionOrchestration,
    SessionSummary,
    SessionChildrenResponse,
    SessionComparePayload,
    SessionDetailPayload,
    SessionInspectPayload,
    SessionInsightsPayload,
    SessionListResponse,
    SkillDetailPayload,
    SkillSourcePayload,
    SkillTriageNote,
    SkillTriageResponse,
    ToolFailureDetailPayload,
    ToolFailuresResponse,
    TriageDecision,
    WorkflowResponse,
    WrappedProfile,
} from "@ax/lib/shared/dashboard-types";
import type { UsageRollupSchema } from "@ax/lib/shared/api-contract";

// Studio mock-mode build flag. When true (set at build time for the public
// studio bundle), every fetch is either:
//   (a) served from local mock fixtures, OR
//   (b) re-pointed at a user-specified local axctl serve endpoint.
//
// The runtime "connect" mode (b) is set via localStorage and reflected
// across the app via `studioConnection`. See live-connection.ts for the
// probe + set/clear surface.
const STUDIO_MOCK = import.meta.env.VITE_STUDIO_MOCK === "true";

const ENDPOINT_KEY = "ax-studio-endpoint";

// Allow auto-connect via ?endpoint=<url> query param. When ax serve prints
// "open in studio    https://ax.necmttn.com/studio/?endpoint=http://...",
// clicking the link writes the endpoint to localStorage and strips the
// query so reloads don't re-trigger the path.
if (typeof window !== "undefined" && STUDIO_MOCK) {
    const params = new URLSearchParams(window.location.search);
    const ep = params.get("endpoint");
    if (ep && /^https?:\/\//.test(ep)) {
        try {
            window.localStorage.setItem(ENDPOINT_KEY, ep.replace(/\/$/, ""));
        } catch { /* ignore */ }
        params.delete("endpoint");
        const qs = params.toString();
        const cleanUrl = window.location.pathname + (qs ? "?" + qs : "");
        window.history.replaceState({}, "", cleanUrl);
    }
}

function readEndpoint(): string | null {
    if (typeof window === "undefined") return null;
    try {
        const v = window.localStorage.getItem(ENDPOINT_KEY);
        if (v && /^https?:\/\//.test(v)) return v.replace(/\/$/, "");
        return null;
    } catch {
        return null;
    }
}

export const studioConnection = {
    get endpoint(): string | null { return readEndpoint(); },
    isLive(): boolean { return readEndpoint() !== null; },
    set(endpoint: string): void {
        window.localStorage.setItem(ENDPOINT_KEY, endpoint.replace(/\/$/, ""));
    },
    clear(): void {
        window.localStorage.removeItem(ENDPOINT_KEY);
    },
    /** Try a HEAD-equivalent on /api/skills against the endpoint.
     *  Returns true if reachable + CORS-permitted. */
    async probe(endpoint: string): Promise<boolean> {
        const url = endpoint.replace(/\/$/, "") + "/api/skills";
        try {
            const res = await fetch(url, { method: "GET", cache: "no-store" });
            return res.ok;
        } catch {
            return false;
        }
    },
};

/**
 * Build the `<img src>` for a local on-disk image referenced in a turn. The
 * daemon serves the bytes via `GET /api/image?path=<url-encoded-abs-path>`
 * (the browser can't load `file://` from an http(s) origin). When studio is
 * live-pointed at a remote daemon, prefix with that endpoint so the image
 * resolves against the same daemon the data came from; otherwise it stays a
 * same-origin path.
 */
export function imageSrc(absolutePath: string): string {
    const path = `/api/image?path=${encodeURIComponent(absolutePath)}`;
    const endpoint = STUDIO_MOCK ? readEndpoint() : null;
    return endpoint ? endpoint + path : path;
}

// Moved to its own module so the contract client can throw it without an
// import cycle; re-exported here so existing importers keep working.
export { ApiError } from "./api-error.ts";
import { ApiError } from "./api-error.ts";
import { runContract, type AxClient } from "./contract-client.ts";
import type { Effect } from "effect";
import type { DaemonVersion } from "@ax/lib/shared/api-contract";

async function jsonFetch<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
    if (STUDIO_MOCK) {
        const endpoint = readEndpoint();
        if (!endpoint) {
            const { mockFetch } = await import("./mock-fixtures.ts");
            return mockFetch<T>(input, init);
        }
        // Live mode: rewrite same-origin /api/* paths to the user's daemon.
        const path = typeof input === "string" ? input : (input as Request).url;
        const rewritten = path.startsWith("/api/")
            ? endpoint + path
            : path;
        input = rewritten;
    }
    const res = await fetch(input, init);
    if (!res.ok) {
        let detail = `${res.status} ${res.statusText}`;
        try {
            const body = (await res.json()) as { error?: string };
            if (body?.error) detail = body.error;
        } catch {
            /* fall through */
        }
        throw new ApiError(detail, res.status);
    }
    return (await res.json()) as T;
}

/**
 * Route a call through the Insights Surface Contract client (ADR-0013) and
 * thread the contract's response type straight through: the `HttpApiClient`
 * call (`c.insights.recall(...)`) already returns a precisely-typed `Effect`,
 * so `A` is inferred from it and callers no longer annotate `Promise<T>`.
 * Mock mode without a connected endpoint keeps the legacy mock-fixtures
 * behavior, keyed by the same bare path jsonFetch used; otherwise the
 * generated client runs against the connected endpoint (or same-origin).
 */
async function viaContract<A, E>(
    mockPath: string,
    call: (client: AxClient) => Effect.Effect<A, E>,
    mockInit?: RequestInit,
): Promise<A> {
    if (STUDIO_MOCK) {
        const endpoint = readEndpoint();
        if (!endpoint) {
            const { mockFetch } = await import("./mock-fixtures.ts");
            // mockInit carries the method for fixtures keyed on POST/DELETE.
            return mockFetch<A>(mockPath, mockInit);
        }
        return runContract(endpoint, call);
    }
    return runContract(null, call);
}

/**
 * Variant for endpoints whose contract response is `Schema.Unknown` on
 * purpose (raw-row passthroughs, deeply-nested mega-payloads, and `RecordId`
 * payloads - see the inline rationale in api-contract.ts). The contract can't
 * type these, so the studio asserts the hand-written dashboard-types shape `T`
 * at this single, greppable seam instead of scattering casts. Migrate a method
 * off this helper if/when its contract payload is tightened to a `Schema.Struct`.
 */
async function viaContractUnknown<T>(
    mockPath: string,
    call: (client: AxClient) => Effect.Effect<unknown, unknown>,
    mockInit?: RequestInit,
): Promise<T> {
    if (STUDIO_MOCK) {
        const endpoint = readEndpoint();
        if (!endpoint) {
            const { mockFetch } = await import("./mock-fixtures.ts");
            // mockInit carries the method for fixtures keyed on POST/DELETE.
            return mockFetch<T>(mockPath, mockInit);
        }
        return await runContract(endpoint, call) as T;
    }
    return await runContract(null, call) as T;
}

export interface IngestTriggerResponse {
    readonly runId: string;
    /** Full Durable Streams sidecar URL to subscribe to directly. */
    readonly stream: string;
    readonly streamName: string;
    readonly streamBaseUrl: string;
}

export interface CostModelRow {
    readonly model: string;
    readonly sessions: number;
    readonly cost_usd: number;
}
export interface CostModelsResult {
    readonly rows: ReadonlyArray<CostModelRow>;
    readonly total_cost_usd: number;
}

// --- context budget (session startup footprint) ----------------------------
export interface ContextSkillRow {
    readonly name: string;
    readonly scope: string;
    readonly source: string;
    readonly index_chars: number;
    readonly body_chars: number;
    readonly index_tokens: number;
    readonly body_tokens: number;
    readonly content_hash: string;
    readonly dir_path: string;
    readonly is_tool: boolean;
    readonly uses_total: number;
    readonly uses_window: number;
    readonly last_used: string | null;
    readonly dead_weight: boolean;
    readonly verbose: boolean;
}
export interface ContextSourceRow {
    readonly source: string;
    readonly skills: number;
    readonly index_chars: number;
    readonly body_chars: number;
    readonly index_tokens: number;
    readonly body_tokens: number;
    readonly is_tool: boolean;
    readonly uses_window: number;
    readonly dead_skills: number;
    readonly reclaimable_index_tokens: number;
}
export interface ContextStartupSourceRow {
    readonly source: string;
    readonly category: "skills" | "claude_md" | "harness_base" | "mcp_tools";
    readonly scope: string | null;
    readonly entries: number;
    readonly chars: number;
    readonly tokens: number;
    readonly estimated: boolean;
    readonly note: string;
}
export interface ContextBudgetResult {
    readonly skills: ReadonlyArray<ContextSkillRow>;
    readonly sources: ReadonlyArray<ContextSourceRow>;
    readonly startupSources: ReadonlyArray<ContextStartupSourceRow>;
    readonly totals: {
        readonly skills: number;
        readonly index_chars: number;
        readonly body_chars: number;
        readonly index_tokens: number;
        readonly body_tokens: number;
        readonly cc_index_tokens: number;
        readonly cc_body_tokens: number;
        readonly reclaimable_index_tokens: number;
        readonly reclaimable_skills: number;
        readonly verbose_skills: number;
        readonly startup_chars: number;
        readonly startup_tokens: number;
        readonly measured_startup_tokens: number;
        readonly estimated_startup_tokens: number;
        readonly window_days: number;
    };
}
export interface ContextDriftRow {
    readonly kind: "skill" | "claude_md";
    readonly name: string;
    readonly scope: string;
    readonly change: string;
    readonly ts: string;
    readonly bytes: number;
    readonly prev_bytes: number;
    readonly byte_delta: number;
    readonly token_delta: number;
}
export interface ContextDriftResult {
    readonly changes: ReadonlyArray<ContextDriftRow>;
    readonly total: number;
}

// The version handshake type now comes from the Insights Surface Contract -
// the same Schema the daemon serves - so the two cannot drift.
export type { DaemonVersion } from "@ax/lib/shared/api-contract";

// --- session timeline (highlight zoom) -------------------------------------

export type TimelineEventKind =
    | "decision" | "tool_call" | "file_edit" | "skill_invocation"
    | "failure" | "correction" | "checkpoint" | "outcome";

export interface TimelineRef {
    readonly type: "turn" | "file" | "tool" | "skill" | "subagent" | "commit";
    readonly id: string;
}
export interface TimelineEvent {
    readonly kind: TimelineEventKind;
    readonly ts: string;
    readonly seq: number | null;
    readonly segment_id?: string;
    readonly title: string;
    readonly detail?: string;
    readonly status?: "ok" | "error";
    readonly refs: ReadonlyArray<TimelineRef>;
    readonly recovered_by_seq?: number | null;
}
export interface TimelineSegment {
    readonly id: string;
    readonly index: number;
    readonly title: string;
    readonly boundary: "session_start" | "ask" | "commit" | "compaction" | "time_gap";
    readonly start_seq: number | null;
    readonly end_seq: number | null;
    readonly started_at: string;
    readonly ended_at: string | null;
    readonly duration_ms: number | null;
    readonly rollup: {
        readonly tool_calls: number; readonly file_edits: number; readonly files: number;
        readonly failures: number; readonly recovered: number; readonly skills: number;
        readonly decisions: number; readonly checkpoints: number; readonly corrections: number;
    };
    readonly event_count: number;
}
export interface SessionTimelinePayload {
    readonly session_id: string;
    readonly highlights: {
        readonly started_at: string | null; readonly ended_at: string | null; readonly duration_ms: number | null;
        readonly model: string | null; readonly project: string | null; readonly repository: string | null;
        readonly turns: number; readonly user_turns: number; readonly assistant_turns: number;
        readonly tool_calls: number; readonly tool_errors: number; readonly files_changed: number;
        readonly skills_used: number; readonly corrections: number; readonly interruptions: number;
        readonly cost_usd: number | null; readonly estimated_tokens: number | null;
        readonly event_counts: Readonly<Record<TimelineEventKind, number>>;
    };
    readonly segments: ReadonlyArray<TimelineSegment>;
    readonly events: ReadonlyArray<TimelineEvent>;
}

export const api = {
    version: () =>
        viaContract("/api/version", (c) => c.system.version()),
    skills: () =>
        viaContract("/api/skills", (c) => c.skills.skills()),
    decide: (
        name: string,
        decision: TriageDecision,
        reason?: string | null,
    ) =>
        viaContract(
            `/api/skills/${encodeURIComponent(name)}/decide`,
            (c) => c.skills.skillDecide({
                params: { name },
                payload: { decision, reason: reason ?? null },
            }),
            { method: "POST" },
        ),
    clearDecision: (name: string) =>
        viaContract(
            `/api/skills/${encodeURIComponent(name)}/decide`,
            (c) => c.skills.skillDecideClear({ params: { name } }),
            { method: "DELETE" },
        ),
    decideBulk: (
        names: ReadonlyArray<string>,
        decision: TriageDecision,
        reason?: string | null,
    ) =>
        viaContract(
            "/api/skills/decide-bulk",
            (c) => c.skills.skillDecideBulk({
                payload: { names, decision, reason: reason ?? null },
            }),
            { method: "POST" },
        ),
    detail: (name: string) =>
        viaContract(
            `/api/skills/${encodeURIComponent(name)}/detail`,
            (c) => c.skills.skillDetail({ params: { name } }),
        ),
    skillSource: (name: string) =>
        viaContract(
            `/api/skills/${encodeURIComponent(name)}/source`,
            (c) => c.skills.skillSource({ params: { name } }),
        ),
    openSkill: (
        name: string,
        target: "finder" | "editor",
    ) =>
        viaContract(
            `/api/skills/${encodeURIComponent(name)}/open`,
            (c) => c.skills.skillOpen({ params: { name }, payload: { target } }),
            { method: "POST" },
        ),
    decisions: () =>
        viaContract("/api/decisions", (c) => c.skills.decisions()),
    workflow: () =>
        viaContract("/api/workflow", (c) => c.insights.workflow()),
    sessions: (params: { offset?: number; limit?: number; source?: string; project?: string } = {}) =>
        viaContract("/api/sessions", (c) =>
            c.sessions.sessionsList({
                query: {
                    ...(params.offset != null ? { offset: params.offset } : {}),
                    ...(params.limit != null ? { limit: params.limit } : {}),
                    ...(params.source ? { source: params.source } : {}),
                    ...(params.project ? { project: params.project } : {}),
                },
            })),
    sessionDetail: (sessionId: string): Promise<SessionDetailPayload> =>
        viaContractUnknown(
            `/api/sessions/${encodeURIComponent(sessionId)}`,
            (c) => c.sessions.sessionDetail({ params: { id: sessionId } }),
        ),
    sessionChildren: (parentId: string) =>
        viaContract(
            `/api/sessions/${encodeURIComponent(parentId)}/children`,
            (c) => c.sessions.sessionChildren({ params: { id: parentId }, query: {} }),
        ),
    sessionInsights: async (sessionId: string): Promise<SessionInsightsPayload> => {
        const payload = await viaContractUnknown<SessionInsightsPayload>(
            `/api/sessions/${encodeURIComponent(sessionId)}/insights`,
            (c) => c.sessions.sessionInsights({ params: { id: sessionId } }),
        );
        // Daemons older than the /insights route answer via the /api/sessions/:id+
        // catch-all with a 200 + session-detail shape. Reject it here so callers
        // hit their query error path instead of crashing on `payload.phases`.
        if (!Array.isArray((payload as { phases?: unknown }).phases)) {
            throw new ApiError("daemon too old for session insights - update axctl", 404);
        }
        return payload;
    },
    sessionInspect: (sessionId: string, params: { turnOffset?: number; turnLimit?: number } = {}): Promise<SessionInspectPayload> =>
        viaContractUnknown(
            `/api/sessions/${encodeURIComponent(sessionId)}/inspect`,
            (c) => c.sessions.sessionInspect({
                params: { id: sessionId },
                query: {
                    ...(params.turnOffset != null ? { turn_offset: params.turnOffset } : {}),
                    ...(params.turnLimit != null ? { turn_limit: params.turnLimit } : {}),
                },
            }),
        ),
    sessionEvidence: async (sessionId: string): Promise<RunEvidencePayload> => {
        const payload = await viaContractUnknown<RunEvidencePayload>(
            `/api/sessions/${encodeURIComponent(sessionId)}/evidence`,
            (c) => c.sessions.sessionEvidence({ params: { id: sessionId } }),
        );
        // Daemons older than the /evidence route answer via the legacy
        // /api/sessions/:id+ catch-all with a 200 + session-detail shape.
        // Reject it here so callers hit their query error path instead of
        // crashing on `payload.by_backing`.
        if (!Array.isArray((payload as { by_backing?: unknown }).by_backing)) {
            throw new ApiError("daemon too old for run evidence - update axctl", 404);
        }
        return payload;
    },
    sessionTimeline: (sessionId: string): Promise<SessionTimelinePayload> =>
        viaContractUnknown(
            `/api/sessions/${encodeURIComponent(sessionId)}/timeline`,
            (c) => c.sessions.sessionTimeline({ params: { id: sessionId } }),
        ),
    sessionCompare: (ids: ReadonlyArray<string>, params: { turns?: boolean } = {}) =>
        viaContract("/api/sessions/compare", (c) =>
            c.sessions.sessionCompare({
                query: {
                    ids: ids.join(","),
                    ...(params.turns ? { turns: "1" } : {}),
                },
            })),
    episodeTimeline: (parentId: string) =>
        viaContract(
            `/api/episodes/${encodeURIComponent(parentId)}`,
            (c) => c.insights.episodeTimeline({ params: { parentId } }),
        ),
    project: (slug: string): Promise<ProjectPagePayload> =>
        viaContractUnknown(
            `/api/projects/${encodeURIComponent(slug)}`,
            (c) => c.insights.project({ params: { project: slug } }),
        ),
    graphExplorer: (params: {
        mode?: GraphExplorerMode;
        q?: string | null;
        limit?: number;
    } = {}): Promise<GraphExplorerPayload> => {
        const usp = new URLSearchParams();
        if (params.mode) usp.set("mode", params.mode);
        if (params.q) usp.set("q", params.q);
        if (params.limit != null) usp.set("limit", String(params.limit));
        const qs = usp.toString();
        return jsonFetch(qs ? `/api/graph-explorer?${qs}` : "/api/graph-explorer");
    },
    sessionCanvas: (params: { limit?: number } = {}) =>
        viaContract("/api/session-canvas", (c) =>
            c.sessions.sessionCanvas({
                query: params.limit != null ? { limit: params.limit } : {},
            })),
    sessionOrchestration: (id: string) =>
        viaContract("/api/session-orchestration", (c) =>
            c.sessions.sessionOrchestration({ query: { id } })),
    sessionSummary: (id: string) =>
        viaContract("/api/session-summary", (c) =>
            c.sessions.sessionSummary({ query: { id } })),
    skillGraph: (params: { minCount?: number; limit?: number } = {}) =>
        viaContract("/api/skill-graph", (c) =>
            c.insights.skillGraph({
                query: {
                    ...(params.minCount != null ? { minCount: params.minCount } : {}),
                    ...(params.limit != null ? { limit: params.limit } : {}),
                },
            })),
    recall: (params: {
        q: string;
        project?: string | null;
        skill?: string | null;
        since?: string | null;
        offset?: number;
        limit?: number;
    }) =>
        viaContract("/api/recall", (c) =>
            c.insights.recall({
                query: {
                    q: params.q,
                    ...(params.project ? { project: params.project } : {}),
                    ...(params.skill ? { skill: params.skill } : {}),
                    ...(params.since ? { since: params.since } : {}),
                    ...(params.offset != null ? { offset: params.offset } : {}),
                    ...(params.limit != null ? { limit: params.limit } : {}),
                },
            })),
    /** Trigger a live ingest run. Returns the full Durable Streams sidecar URL
     *  the browser subscribes to directly (the sidecar has permissive CORS and
     *  runs on its own localhost port). */
    ingest: (params: { since?: number } = {}) =>
        viaContract(
            "/api/ingest",
            (c) => c.live.ingestTrigger({
                payload: params.since != null ? { since: params.since } : {},
            }),
            { method: "POST" },
        ),
    toolFailures: () =>
        viaContract("/api/tool-failures", (c) => c.insights.toolFailures()),
    toolFailureDetail: (label: string) =>
        viaContract(
            `/api/tool-failures/${encodeURIComponent(label)}/detail`,
            (c) => c.insights.toolFailureDetail({ params: { label } }),
        ),
    wrapped: (): Promise<WrappedProfile> =>
        viaContractUnknown("/api/wrapped", (c) => c.insights.wrapped()),
    wrappedPublicPreview: (): Promise<WrappedProfile> =>
        viaContractUnknown("/api/wrapped/public-preview", (c) => c.insights.wrappedPublicPreview()),

    costModels: (): Promise<CostModelsResult> =>
        viaContractUnknown("/api/cost/models", (c) => c.insights.costModels()) as Promise<CostModelsResult>,
    costSplit: (days = 30): Promise<unknown> =>
        viaContractUnknown("/api/cost/split", (c) => c.insights.costSplit({ query: { days } })),
    costDispatches: (days = 30, candidates = false): Promise<unknown> =>
        viaContractUnknown("/api/cost/dispatches", (c) => c.insights.costDispatches({ query: { days, candidates } })),
    costRoutability: (days = 30, minRun = 1): Promise<unknown> =>
        viaContractUnknown("/api/cost/routability", (c) => c.insights.costRoutability({ query: { days, minRun } })),
    routingTable: (): Promise<unknown> =>
        viaContractUnknown("/api/routing/table", (c) => c.insights.routingTable()),
    routingBacktest: (body: { pattern: string; flags?: string; suggest: string; exclude?: string[]; days?: number }): Promise<unknown> =>
        viaContractUnknown("/api/routing/backtest", (c) => c.insights.routingBacktest({ payload: body }), { method: "POST" }),
    routingUpsertClass: (body: { id: string; pattern: string; flags?: string; suggest: string; reason?: string; exclude?: string[] }): Promise<unknown> =>
        viaContractUnknown("/api/routing/classes", (c) => c.routing.routingUpsertClass({ payload: body }), { method: "POST" }),
    routingRemoveClass: (id: string): Promise<unknown> =>
        viaContractUnknown(`/api/routing/classes/${encodeURIComponent(id)}`, (c) => c.routing.routingRemoveClass({ params: { id } }), { method: "DELETE" }),
    contextBudget: (): Promise<ContextBudgetResult> =>
        viaContractUnknown("/api/context/budget", (c) => c.insights.contextBudget()) as Promise<ContextBudgetResult>,
    contextDrift: (): Promise<ContextDriftResult> =>
        viaContractUnknown("/api/context/drift", (c) => c.insights.contextDrift()) as Promise<ContextDriftResult>,

    nextActions: (): Promise<NextActionsPayload> =>
        viaContractUnknown("/api/next-actions", (c) => c.improve.nextActions()),

    improveAnalyzeBrief: (): Promise<{ brief: string }> =>
        viaContractUnknown("/api/improve/analyze-brief", (c) => c.improve.analyzeBrief()),

    improveImpact: (sig: string): Promise<{ sig: string; impact: ImpactEstimate }> =>
        viaContractUnknown(`/api/improve/${encodeURIComponent(sig)}/impact`, (c) =>
            c.improve.improveImpact({ params: { sig } })),

    wrappedGenerateBrief: (): Promise<{ brief: string }> =>
        viaContractUnknown("/api/wrapped/generate-brief", (c) => c.insights.wrappedGenerateBrief()),

    /** CLI utilization rollup: active days, top commands, unused surface. */
    usage: (params: { days?: number } = {}) =>
        viaContract("/api/usage", (c) =>
            c.usage.usageRollup({
                query: params.days != null ? { days: params.days } : {},
            })),

    /** Read-only SQL console (Lab) - daemon accepts SELECT/RETURN/INFO only. */
    query: (sql: string) =>
        viaContract(
            "/api/query",
            (c) => c.system.query({ payload: { sql } }),
            { method: "POST" },
        ),

    // Experiment loop - see
    // docs/superpowers/plans/2026-05-25-experiment-loop-cleanup-and-rebuild.md
    improve: (): Promise<ImprovePayload> =>
        viaContractUnknown("/api/improve", (c) => c.improve.improveList()),
    improveAccept: (sig: string, force = false): Promise<ImproveActionResponse> =>
        viaContractUnknown(
            `/api/improve/${encodeURIComponent(sig)}/accept`,
            (c) => c.improve.improveAction({
                params: { sig, action: "accept" },
                payload: { force },
            }),
            { method: "POST" },
        ),
    improveReject: (sig: string, reason?: string | null): Promise<ImproveActionResponse> =>
        viaContractUnknown(
            `/api/improve/${encodeURIComponent(sig)}/reject`,
            (c) => c.improve.improveAction({
                params: { sig, action: "reject" },
                payload: { reason: reason ?? null },
            }),
            { method: "POST" },
        ),
    improveSetVerdict: (sig: string, verdict: string): Promise<ImproveActionResponse> =>
        viaContractUnknown(
            `/api/improve/${encodeURIComponent(sig)}/verdict`,
            (c) => c.improve.improveAction({
                params: { sig, action: "verdict" },
                payload: { verdict },
            }),
            { method: "POST" },
        ),
};
