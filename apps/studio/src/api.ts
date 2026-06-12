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
 * Route a call through the Insights Surface Contract client (ADR-0013).
 * Mock mode without a connected endpoint keeps the legacy mock-fixtures
 * behavior, keyed by the same bare path jsonFetch used; otherwise the
 * generated client runs against the connected endpoint (or same-origin).
 * The `T` cast preserves the dashboard-types interfaces the UI was already
 * trusting under jsonFetch<T> - contract payloads tighten in a later pass.
 */
async function viaContract<T>(
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
    version: (): Promise<DaemonVersion> =>
        viaContract("/api/version", (c) => c.system.version()),
    skills: (): Promise<SkillTriageResponse> =>
        viaContract("/api/skills", (c) => c.skills.skills()),
    decide: (
        name: string,
        decision: TriageDecision,
        reason?: string | null,
    ): Promise<SkillTriageNote> =>
        viaContract(
            `/api/skills/${encodeURIComponent(name)}/decide`,
            (c) => c.skills.skillDecide({
                params: { name },
                payload: { decision, reason: reason ?? null },
            }),
            { method: "POST" },
        ),
    clearDecision: (name: string): Promise<{ cleared: boolean; skill_name: string }> =>
        viaContract(
            `/api/skills/${encodeURIComponent(name)}/decide`,
            (c) => c.skills.skillDecideClear({ params: { name } }),
            { method: "DELETE" },
        ),
    decideBulk: (
        names: ReadonlyArray<string>,
        decision: TriageDecision,
        reason?: string | null,
    ): Promise<{ notes: ReadonlyArray<SkillTriageNote> }> =>
        viaContract(
            "/api/skills/decide-bulk",
            (c) => c.skills.skillDecideBulk({
                payload: { names, decision, reason: reason ?? null },
            }),
            { method: "POST" },
        ),
    detail: (name: string): Promise<SkillDetailPayload> =>
        viaContract(
            `/api/skills/${encodeURIComponent(name)}/detail`,
            (c) => c.skills.skillDetail({ params: { name } }),
        ),
    skillSource: (name: string): Promise<SkillSourcePayload> =>
        viaContract(
            `/api/skills/${encodeURIComponent(name)}/source`,
            (c) => c.skills.skillSource({ params: { name } }),
        ),
    openSkill: (
        name: string,
        target: "finder" | "editor",
    ): Promise<{ launched: string }> =>
        viaContract(
            `/api/skills/${encodeURIComponent(name)}/open`,
            (c) => c.skills.skillOpen({ params: { name }, payload: { target } }),
            { method: "POST" },
        ),
    decisions: (): Promise<{ decisions: ReadonlyArray<SkillTriageNote> }> =>
        viaContract("/api/decisions", (c) => c.skills.decisions()),
    workflow: (): Promise<WorkflowResponse> =>
        viaContract("/api/workflow", (c) => c.insights.workflow()),
    sessions: (params: { offset?: number; limit?: number; source?: string; project?: string } = {}): Promise<SessionListResponse> =>
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
        viaContract(
            `/api/sessions/${encodeURIComponent(sessionId)}`,
            (c) => c.sessions.sessionDetail({ params: { id: sessionId } }),
        ),
    sessionChildren: (parentId: string): Promise<SessionChildrenResponse> =>
        viaContract(
            `/api/sessions/${encodeURIComponent(parentId)}/children`,
            (c) => c.sessions.sessionChildren({ params: { id: parentId }, query: {} }),
        ),
    sessionInsights: async (sessionId: string): Promise<SessionInsightsPayload> => {
        const payload = await viaContract<SessionInsightsPayload>(
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
        viaContract(
            `/api/sessions/${encodeURIComponent(sessionId)}/inspect`,
            (c) => c.sessions.sessionInspect({
                params: { id: sessionId },
                query: {
                    ...(params.turnOffset != null ? { turn_offset: params.turnOffset } : {}),
                    ...(params.turnLimit != null ? { turn_limit: params.turnLimit } : {}),
                },
            }),
        ),
    sessionTimeline: (sessionId: string): Promise<SessionTimelinePayload> =>
        viaContract(
            `/api/sessions/${encodeURIComponent(sessionId)}/timeline`,
            (c) => c.sessions.sessionTimeline({ params: { id: sessionId } }),
        ),
    sessionCompare: (ids: ReadonlyArray<string>, params: { turns?: boolean } = {}): Promise<SessionComparePayload> =>
        viaContract("/api/sessions/compare", (c) =>
            c.sessions.sessionCompare({
                query: {
                    ids: ids.join(","),
                    ...(params.turns ? { turns: "1" } : {}),
                },
            })),
    episodeTimeline: (parentId: string): Promise<EpisodeTimelinePayload> =>
        viaContract(
            `/api/episodes/${encodeURIComponent(parentId)}`,
            (c) => c.insights.episodeTimeline({ params: { parentId } }),
        ),
    project: (slug: string): Promise<ProjectPagePayload> =>
        viaContract(
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
    sessionCanvas: (params: { limit?: number } = {}): Promise<SessionCanvasPayload> =>
        viaContract("/api/session-canvas", (c) =>
            c.sessions.sessionCanvas({
                query: params.limit != null ? { limit: params.limit } : {},
            })),
    sessionOrchestration: (id: string): Promise<SessionOrchestration> =>
        viaContract("/api/session-orchestration", (c) =>
            c.sessions.sessionOrchestration({ query: { id } })),
    sessionSummary: (id: string): Promise<SessionSummary> =>
        viaContract("/api/session-summary", (c) =>
            c.sessions.sessionSummary({ query: { id } })),
    skillGraph: (params: { minCount?: number; limit?: number } = {}): Promise<SkillGraphPayload> =>
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
    }): Promise<RecallResponse> =>
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
    ingest: (params: { since?: number } = {}): Promise<IngestTriggerResponse> =>
        viaContract(
            "/api/ingest",
            (c) => c.live.ingestTrigger({
                payload: params.since != null ? { since: params.since } : {},
            }),
            { method: "POST" },
        ),
    toolFailures: (): Promise<ToolFailuresResponse> =>
        viaContract("/api/tool-failures", (c) => c.insights.toolFailures()),
    toolFailureDetail: (label: string): Promise<ToolFailureDetailPayload> =>
        viaContract(
            `/api/tool-failures/${encodeURIComponent(label)}/detail`,
            (c) => c.insights.toolFailureDetail({ params: { label } }),
        ),
    wrapped: (): Promise<WrappedProfile> =>
        viaContract("/api/wrapped", (c) => c.insights.wrapped()),
    wrappedPublicPreview: (): Promise<WrappedProfile> =>
        viaContract("/api/wrapped/public-preview", (c) => c.insights.wrappedPublicPreview()),

    nextActions: (): Promise<NextActionsPayload> =>
        viaContract("/api/next-actions", (c) => c.improve.nextActions()),

    improveAnalyzeBrief: (): Promise<{ brief: string }> =>
        viaContract("/api/improve/analyze-brief", (c) => c.improve.analyzeBrief()),

    improveImpact: (sig: string): Promise<{ sig: string; impact: ImpactEstimate }> =>
        viaContract(`/api/improve/${encodeURIComponent(sig)}/impact`, (c) =>
            c.improve.improveImpact({ params: { sig } })),

    wrappedGenerateBrief: (): Promise<{ brief: string }> =>
        viaContract("/api/wrapped/generate-brief", (c) => c.insights.wrappedGenerateBrief()),

    /** Read-only SQL console (Lab) - daemon accepts SELECT/RETURN/INFO only. */
    query: (sql: string): Promise<{ result: unknown; durationMs: number }> =>
        viaContract(
            "/api/query",
            (c) => c.system.query({ payload: { sql } }),
            { method: "POST" },
        ),

    // Experiment loop - see
    // docs/superpowers/plans/2026-05-25-experiment-loop-cleanup-and-rebuild.md
    improve: (): Promise<ImprovePayload> =>
        viaContract("/api/improve", (c) => c.improve.improveList()),
    improveAccept: (sig: string, force = false): Promise<ImproveActionResponse> =>
        viaContract(
            `/api/improve/${encodeURIComponent(sig)}/accept`,
            (c) => c.improve.improveAction({
                params: { sig, action: "accept" },
                payload: { force },
            }),
            { method: "POST" },
        ),
    improveReject: (sig: string, reason?: string | null): Promise<ImproveActionResponse> =>
        viaContract(
            `/api/improve/${encodeURIComponent(sig)}/reject`,
            (c) => c.improve.improveAction({
                params: { sig, action: "reject" },
                payload: { reason: reason ?? null },
            }),
            { method: "POST" },
        ),
    improveSetVerdict: (sig: string, verdict: string): Promise<ImproveActionResponse> =>
        viaContract(
            `/api/improve/${encodeURIComponent(sig)}/verdict`,
            (c) => c.improve.improveAction({
                params: { sig, action: "verdict" },
                payload: { verdict },
            }),
            { method: "POST" },
        ),
};
