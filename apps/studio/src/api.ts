import type {
    EpisodeTimelinePayload,
    GraphExplorerMode,
    GraphExplorerPayload,
    ImproveActionResponse,
    ImprovePayload,
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
        throw new Error(detail);
    }
    return (await res.json()) as T;
}

export interface IngestTriggerResponse {
    readonly runId: string;
    /** Full Durable Streams sidecar URL to subscribe to directly. */
    readonly stream: string;
    readonly streamName: string;
    readonly streamBaseUrl: string;
}

export interface DaemonVersion {
    readonly version: string;
    readonly api_version: number;
    readonly capabilities: ReadonlyArray<string>;
}

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
    version: (): Promise<DaemonVersion> => jsonFetch("/api/version"),
    skills: (): Promise<SkillTriageResponse> => jsonFetch("/api/skills"),
    decide: (
        name: string,
        decision: TriageDecision,
        reason?: string | null,
    ): Promise<SkillTriageNote> =>
        jsonFetch(`/api/skills/${encodeURIComponent(name)}/decide`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ decision, reason: reason ?? null }),
        }),
    clearDecision: (name: string): Promise<{ cleared: boolean; skill_name: string }> =>
        jsonFetch(`/api/skills/${encodeURIComponent(name)}/decide`, {
            method: "DELETE",
        }),
    decideBulk: (
        names: ReadonlyArray<string>,
        decision: TriageDecision,
        reason?: string | null,
    ): Promise<{ notes: ReadonlyArray<SkillTriageNote> }> =>
        jsonFetch("/api/skills/decide-bulk", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ names, decision, reason: reason ?? null }),
        }),
    detail: (name: string): Promise<SkillDetailPayload> =>
        jsonFetch(`/api/skills/${encodeURIComponent(name)}/detail`),
    skillSource: (name: string): Promise<SkillSourcePayload> =>
        jsonFetch(`/api/skills/${encodeURIComponent(name)}/source`),
    openSkill: (
        name: string,
        target: "finder" | "editor",
    ): Promise<{ launched: string }> =>
        jsonFetch(`/api/skills/${encodeURIComponent(name)}/open`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ target }),
        }),
    decisions: (): Promise<{ decisions: ReadonlyArray<SkillTriageNote> }> =>
        jsonFetch("/api/decisions"),
    workflow: (): Promise<WorkflowResponse> => jsonFetch("/api/workflow"),
    sessions: (params: { offset?: number; limit?: number; source?: string; project?: string } = {}): Promise<SessionListResponse> => {
        const usp = new URLSearchParams();
        if (params.offset != null) usp.set("offset", String(params.offset));
        if (params.limit != null) usp.set("limit", String(params.limit));
        if (params.source) usp.set("source", params.source);
        if (params.project) usp.set("project", params.project);
        const qs = usp.toString();
        return jsonFetch(qs ? `/api/sessions?${qs}` : "/api/sessions");
    },
    sessionDetail: (sessionId: string): Promise<SessionDetailPayload> =>
        jsonFetch(`/api/sessions/${encodeURIComponent(sessionId)}`),
    sessionChildren: (parentId: string): Promise<SessionChildrenResponse> =>
        jsonFetch(`/api/sessions/${encodeURIComponent(parentId)}/children`),
    sessionInspect: (sessionId: string, params: { turnOffset?: number; turnLimit?: number } = {}): Promise<SessionInspectPayload> => {
        const usp = new URLSearchParams();
        if (params.turnOffset != null) usp.set("turn_offset", String(params.turnOffset));
        if (params.turnLimit != null) usp.set("turn_limit", String(params.turnLimit));
        const qs = usp.toString();
        return jsonFetch(qs
            ? `/api/sessions/${encodeURIComponent(sessionId)}/inspect?${qs}`
            : `/api/sessions/${encodeURIComponent(sessionId)}/inspect`);
    },
    sessionTimeline: (sessionId: string): Promise<SessionTimelinePayload> =>
        jsonFetch(`/api/sessions/${encodeURIComponent(sessionId)}/timeline`),
    sessionCompare: (ids: ReadonlyArray<string>, params: { turns?: boolean } = {}): Promise<SessionComparePayload> => {
        const usp = new URLSearchParams();
        usp.set("ids", ids.join(","));
        if (params.turns) usp.set("turns", "1");
        return jsonFetch(`/api/sessions/compare?${usp.toString()}`);
    },
    episodeTimeline: (parentId: string): Promise<EpisodeTimelinePayload> =>
        jsonFetch(`/api/episodes/${encodeURIComponent(parentId)}`),
    project: (slug: string): Promise<ProjectPagePayload> =>
        jsonFetch(`/api/projects/${encodeURIComponent(slug)}`),
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
    sessionCanvas: (params: { limit?: number } = {}): Promise<SessionCanvasPayload> => {
        const usp = new URLSearchParams();
        if (params.limit != null) usp.set("limit", String(params.limit));
        const qs = usp.toString();
        return jsonFetch(qs ? `/api/session-canvas?${qs}` : "/api/session-canvas");
    },
    sessionOrchestration: (id: string): Promise<SessionOrchestration> =>
        jsonFetch(`/api/session-orchestration?id=${encodeURIComponent(id)}`),
    sessionSummary: (id: string): Promise<SessionSummary> =>
        jsonFetch(`/api/session-summary?id=${encodeURIComponent(id)}`),
    skillGraph: (params: { minCount?: number; limit?: number } = {}): Promise<SkillGraphPayload> => {
        const usp = new URLSearchParams();
        if (params.minCount != null) usp.set("minCount", String(params.minCount));
        if (params.limit != null) usp.set("limit", String(params.limit));
        const qs = usp.toString();
        return jsonFetch(qs ? `/api/skill-graph?${qs}` : "/api/skill-graph");
    },
    recall: (params: {
        q: string;
        project?: string | null;
        skill?: string | null;
        since?: string | null;
        offset?: number;
        limit?: number;
    }): Promise<RecallResponse> => {
        const usp = new URLSearchParams();
        usp.set("q", params.q);
        if (params.project) usp.set("project", params.project);
        if (params.skill) usp.set("skill", params.skill);
        if (params.since) usp.set("since", params.since);
        if (params.offset != null) usp.set("offset", String(params.offset));
        if (params.limit != null) usp.set("limit", String(params.limit));
        return jsonFetch(`/api/recall?${usp.toString()}`);
    },
    /** Trigger a live ingest run. Returns the full Durable Streams sidecar URL
     *  the browser subscribes to directly (the sidecar has permissive CORS and
     *  runs on its own localhost port). */
    ingest: (params: { since?: number } = {}): Promise<IngestTriggerResponse> =>
        jsonFetch("/api/ingest", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(params.since != null ? { since: params.since } : {}),
        }),
    toolFailures: (): Promise<ToolFailuresResponse> => jsonFetch("/api/tool-failures"),
    toolFailureDetail: (label: string): Promise<ToolFailureDetailPayload> =>
        jsonFetch(`/api/tool-failures/${encodeURIComponent(label)}/detail`),
    wrapped: (): Promise<WrappedProfile> => jsonFetch("/api/wrapped"),
    wrappedPublicPreview: (): Promise<WrappedProfile> =>
        jsonFetch("/api/wrapped/public-preview"),

    // Experiment loop - see
    // docs/superpowers/plans/2026-05-25-experiment-loop-cleanup-and-rebuild.md
    improve: (): Promise<ImprovePayload> => jsonFetch("/api/improve"),
    improveAccept: (sig: string, force = false): Promise<ImproveActionResponse> =>
        jsonFetch(`/api/improve/${encodeURIComponent(sig)}/accept`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ force }),
        }),
    improveReject: (sig: string, reason?: string | null): Promise<ImproveActionResponse> =>
        jsonFetch(`/api/improve/${encodeURIComponent(sig)}/reject`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ reason: reason ?? null }),
        }),
    improveSetVerdict: (sig: string, verdict: string): Promise<ImproveActionResponse> =>
        jsonFetch(`/api/improve/${encodeURIComponent(sig)}/verdict`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ verdict }),
        }),
};
