import type {
    EpisodeTimelinePayload,
    ProjectPagePayload,
    RecallResponse,
    SkillGraphPayload,
    SessionDetailPayload,
    SkillDetailPayload,
    SkillTriageNote,
    SkillTriageResponse,
    ToolFailureDetailPayload,
    ToolFailuresResponse,
    TriageDecision,
    WorkflowResponse,
    WrappedProfile,
} from "@shared/dashboard-types.ts";

async function jsonFetch<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
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
    decisions: (): Promise<{ decisions: ReadonlyArray<SkillTriageNote> }> =>
        jsonFetch("/api/decisions"),
    workflow: (): Promise<WorkflowResponse> => jsonFetch("/api/workflow"),
    sessionDetail: (sessionId: string): Promise<SessionDetailPayload> =>
        jsonFetch(`/api/sessions/${encodeURIComponent(sessionId)}`),
    episodeTimeline: (parentId: string): Promise<EpisodeTimelinePayload> =>
        jsonFetch(`/api/episodes/${encodeURIComponent(parentId)}`),
    project: (slug: string): Promise<ProjectPagePayload> =>
        jsonFetch(`/api/projects/${encodeURIComponent(slug)}`),
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
    }): Promise<RecallResponse> => {
        const usp = new URLSearchParams();
        usp.set("q", params.q);
        if (params.project) usp.set("project", params.project);
        if (params.skill) usp.set("skill", params.skill);
        if (params.since) usp.set("since", params.since);
        return jsonFetch(`/api/recall?${usp.toString()}`);
    },
    toolFailures: (): Promise<ToolFailuresResponse> => jsonFetch("/api/tool-failures"),
    toolFailureDetail: (label: string): Promise<ToolFailureDetailPayload> =>
        jsonFetch(`/api/tool-failures/${encodeURIComponent(label)}/detail`),
    wrapped: (): Promise<WrappedProfile> => jsonFetch("/api/wrapped"),
    wrappedPublicPreview: (): Promise<WrappedProfile> =>
        jsonFetch("/api/wrapped/public-preview"),
};
