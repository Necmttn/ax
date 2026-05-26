import type {
    EpisodeTimelinePayload,
    GraphExplorerMode,
    GraphExplorerPayload,
    ImproveActionResponse,
    ImprovePayload,
    ProjectPagePayload,
    RecallResponse,
    SkillGraphPayload,
    SessionChildrenResponse,
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
} from "@shared/dashboard-types.ts";

// Studio mock-mode: when built with VITE_STUDIO_MOCK=true, intercept every
// jsonFetch and return canned fixtures. See mock-fixtures.ts.
const STUDIO_MOCK = import.meta.env.VITE_STUDIO_MOCK === "true";

async function jsonFetch<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
    if (STUDIO_MOCK) {
        const { mockFetch } = await import("./mock-fixtures.ts");
        return mockFetch<T>(input, init);
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

export const api = {
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
