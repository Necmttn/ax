/**
 * The Insights Surface Contract (ADR-0013): the schema-typed HTTP API the
 * daemon serves and the studio consumes - the single source of truth for
 * routes, params, payloads, responses, and errors. The daemon registers it
 * into the v4 HttpRouter via HttpApiBuilder (apps/axctl/src/dashboard/
 * contract/), Scalar docs render it at /docs, and the studio derives its
 * client from it.
 *
 * Migration is strangler-style, one route family at a time; endpoints not
 * yet listed here are still served by the legacy route table. SSE
 * /api/events and binary /api/image stay OUTSIDE the contract permanently
 * (streaming/binary shapes that don't fit HttpApi).
 *
 * This module must stay daemon-agnostic: no imports from apps/* (the studio
 * bundles it for the browser).
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

// ---------------------------------------------------------------- system

/** GET /api/version - the studio's handshake + capability probe. */
export class DaemonVersion extends Schema.Class<DaemonVersion>("ax/DaemonVersion")({
    version: Schema.String,
    api_version: Schema.Number,
    capabilities: Schema.Array(Schema.String),
    /** Whether the Durable Streams sidecar is hosting live ingest. False on
     *  the compiled binary (native lmdb can't bundle), where POST /api/ingest
     *  503s - the studio reads this to engage its polling fallback. Optional
     *  on the wire: daemons older than the field omit it, and the hosted
     *  studio must keep decoding their responses. */
    live_ingest: Schema.optionalKey(Schema.Boolean),
    /** Whether the OTLP receiver (/v1/traces, /v1/metrics, /v1/logs) is
     *  available. Unlike live_ingest, this is always true: the receiver is
     *  pure HTTP+JSON+SurrealDB with no native dependency. Optional on the
     *  wire for forward-compatibility with older daemons. */
    otlp_receiver: Schema.optionalKey(Schema.Boolean),
}) {}

/** POST /api/query rejection: non-read SQL or a database error. Legacy
 *  behavior mapped every failure on this endpoint to HTTP 400. */
export class QueryRejected extends Schema.ErrorClass<QueryRejected>("ax/QueryRejected")({
    error: Schema.String,
}, { httpApiStatus: 400 }) {}

/** Database/internal failure on a read endpoint - the legacy route table
 *  rendered these as `{ error }` with HTTP 500; the contract keeps that. */
export class InternalError extends Schema.ErrorClass<InternalError>("ax/InternalError")({
    error: Schema.String,
}, { httpApiStatus: 500 }) {}

/** A looked-up entity does not exist - `{ error }` with HTTP 404. */
export class NotFoundError extends Schema.ErrorClass<NotFoundError>("ax/NotFoundError")({
    error: Schema.String,
}, { httpApiStatus: 404 }) {}

/** A request with invalid/missing parameters - `{ error }` with HTTP 400. */
export class BadRequestError extends Schema.ErrorClass<BadRequestError>("ax/BadRequestError")({
    error: Schema.String,
}, { httpApiStatus: 400 }) {}

/** POST /api/query - the read-only SQL console (SELECT/RETURN/INFO only). */
export class QueryResult extends Schema.Class<QueryResult>("ax/QueryResult")({
    result: Schema.Unknown,
    durationMs: Schema.Number,
}) {}

export class WorktreesResult extends Schema.Class<WorktreesResult>("ax/WorktreesResult")({
    activity: Schema.Unknown,
    git: Schema.Unknown,
}) {}

/**
 * The system family: version/capability metadata, the read-only SQL console,
 * and the legacy raw-row insight queries. The raw-row endpoints are
 * deliberately `Schema.Unknown` payloads - they pass SurrealDB rows through
 * untyped today; tightening them is contract work for a later pass, not a
 * blocker for the strangler migration.
 */
export const SystemGroup = HttpApiGroup.make("system")
    .add(
        HttpApiEndpoint.get("version", "/api/version", {
            success: DaemonVersion,
        }),
        HttpApiEndpoint.post("query", "/api/query", {
            // A real Schema (not bare fields) so the payload codec is JSON -
            // bare field maps are interpreted as form-urlencoded by HttpApi.
            payload: Schema.Struct({ sql: Schema.String }),
            success: QueryResult,
            error: QueryRejected,
        }),
        HttpApiEndpoint.get("graphHealth", "/api/graph-health", {
            success: Schema.Unknown,
            error: InternalError,
        }),
        HttpApiEndpoint.get("worktrees", "/api/worktrees", {
            success: WorktreesResult,
            error: InternalError,
        }),
        HttpApiEndpoint.get("selfImprove", "/api/self-improve", {
            success: Schema.Unknown,
            error: InternalError,
        }),
    );

// ---- recall payload (the first tightened insights response) -------------
// These mirror the dashboard-types Recall* interfaces exactly. They are
// Schema.Struct (not Schema.Class) on purpose: HttpApi ENCODES a handler's
// return through the success schema, and a class schema's encode demands
// actual class instances, while the recall handler returns plain JS-mapped
// objects. A struct's Type is a plain object, so it encodes cleanly.

export const RecallHit = Schema.Struct({
    turn_id: Schema.String,
    session_id: Schema.String,
    project: Schema.NullOr(Schema.String),
    source: Schema.NullOr(Schema.String),
    cwd: Schema.NullOr(Schema.String),
    role: Schema.NullOr(Schema.String),
    ts: Schema.NullOr(Schema.String),
    snippet: Schema.String,
});

export const RecallCommitHit = Schema.Struct({
    commit_id: Schema.String,
    sha: Schema.String,
    repo: Schema.NullOr(Schema.String),
    repository: Schema.NullOr(Schema.String),
    ts: Schema.NullOr(Schema.String),
    snippet: Schema.String,
    score: Schema.Number,
});

export const RecallSkillHit = Schema.Struct({
    skill_id: Schema.String,
    name: Schema.String,
    description: Schema.NullOr(Schema.String),
    snippet: Schema.String,
    score: Schema.Number,
});

export const RecallResponse = Schema.Struct({
    q: Schema.String,
    hits: Schema.Array(RecallHit),
    commits: Schema.Array(RecallCommitHit),
    skills: Schema.Array(RecallSkillHit),
    truncated: Schema.Boolean,
    total_count: Schema.Number,
    total_counts: Schema.Struct({
        turn: Schema.Number,
        commit: Schema.Number,
        skill: Schema.Number,
    }),
    window: Schema.Struct({
        offset: Schema.Number,
        limit: Schema.Number,
    }),
});

/** Studio-facing type derived from the contract (single source of truth). */
export type RecallResponse = typeof RecallResponse.Type;

// ---- tool-failures, skill-graph, episode-timeline, workflow payloads -----
// Bounded curated shapes mirroring the dashboard-types interfaces. SessionId
// is a branded string on the wire, so Schema.String here.

const ToolFailureEntry = Schema.Struct({
    label: Schema.String,
    failure_count: Schema.Number,
    last_seen: Schema.NullOr(Schema.String),
    last_error_text: Schema.NullOr(Schema.String),
    last_project: Schema.NullOr(Schema.String),
    distinct_sessions: Schema.Number,
    total_calls: Schema.Number,
    failure_rate: Schema.Number,
    exit_codes: Schema.Array(Schema.Number),
    recommendation: Schema.Literals(["fix", "watch", "ignore"]),
    recommendation_reason: Schema.String,
});

export const ToolFailuresResponse = Schema.Struct({
    generatedAt: Schema.String,
    failures: Schema.Array(ToolFailureEntry),
});

const ToolFailureSample = Schema.Struct({
    ts: Schema.String,
    exit_code: Schema.NullOr(Schema.Number),
    error_text: Schema.NullOr(Schema.String),
    output_excerpt: Schema.NullOr(Schema.String),
    command_text: Schema.NullOr(Schema.String),
    project: Schema.NullOr(Schema.String),
    session_id: Schema.NullOr(Schema.String),
    cwd: Schema.NullOr(Schema.String),
});

export const ToolFailureDetailPayload = Schema.Struct({
    label: Schema.String,
    samples: Schema.Array(ToolFailureSample),
});

const SkillGraphNode = Schema.Struct({
    name: Schema.String,
    weight: Schema.Number,
    last_seen: Schema.NullOr(Schema.String),
});

const SkillGraphEdge = Schema.Struct({
    source: Schema.String,
    target: Schema.String,
    count: Schema.Number,
    last_seen: Schema.NullOr(Schema.String),
});

export const SkillGraphPayload = Schema.Struct({
    min_count: Schema.Number,
    limit: Schema.Number,
    node_count: Schema.Number,
    edge_count: Schema.Number,
    max_edge_count: Schema.Number,
    nodes: Schema.Array(SkillGraphNode),
    edges: Schema.Array(SkillGraphEdge),
});

const PhaseLiteral = Schema.Literals(["plan", "execute", "review", "merge"]);

const EpisodeNode = Schema.Struct({
    session_id: Schema.String,
    role: Schema.Literals(["parent", "child"]),
    project: Schema.NullOr(Schema.String),
    source: Schema.NullOr(Schema.String),
    started_at: Schema.NullOr(Schema.String),
    ended_at: Schema.NullOr(Schema.String),
    duration_ms: Schema.NullOr(Schema.Number),
    phase: Schema.Literals(["plan", "execute", "review", "merge", "other", "mixed"]),
    top_skills: Schema.Array(Schema.Struct({ skill: Schema.String, count: Schema.Number })),
    invocation_count: Schema.Number,
});

export const EpisodeTimelinePayload = Schema.Struct({
    parent_session_id: Schema.String,
    project: Schema.NullOr(Schema.String),
    started_at: Schema.NullOr(Schema.String),
    ended_at: Schema.NullOr(Schema.String),
    duration_ms: Schema.NullOr(Schema.Number),
    node_count: Schema.Number,
    nodes: Schema.Array(EpisodeNode),
    shape: Schema.String,
});

const WorkflowWeekBucket = Schema.Struct({
    week: Schema.String,
    counts: Schema.Array(Schema.Struct({ label: Schema.String, count: Schema.Number })),
});

const WorkflowConvergencePoint = Schema.Struct({
    week: Schema.String,
    jaccard: Schema.NullOr(Schema.Number),
    topK: Schema.Array(Schema.String),
    newcomers: Schema.Array(Schema.String),
    dropouts: Schema.Array(Schema.String),
});

const WorkflowSessionShape = Schema.Struct({
    week: Schema.String,
    session_count: Schema.Number,
});

const SessionShapeAggregate = Schema.Struct({
    shape: Schema.String,
    phases: Schema.Array(PhaseLiteral),
    session_count: Schema.Number,
    example_session_ids: Schema.Array(Schema.String),
});

const WorkflowEpisode = Schema.Struct({
    parent_session_id: Schema.String,
    project: Schema.NullOr(Schema.String),
    started_at: Schema.NullOr(Schema.String),
    child_count: Schema.Number,
    distinct_nicknames: Schema.Number,
});

const EpisodeShapeAggregate = Schema.Struct({
    shape: Schema.String,
    phases: Schema.Array(PhaseLiteral),
    episode_count: Schema.Number,
    example_parent_ids: Schema.Array(Schema.String),
    avg_children: Schema.Number,
});

export const WorkflowResponse = Schema.Struct({
    generatedAt: Schema.String,
    weeksLookback: Schema.Number,
    topK: Schema.Number,
    skills: Schema.Array(WorkflowWeekBucket),
    tools: Schema.Array(WorkflowWeekBucket),
    sessionShape: Schema.Array(WorkflowSessionShape),
    convergence: Schema.Array(WorkflowConvergencePoint),
    shapes: Schema.Array(SessionShapeAggregate),
    shapesTotal: Schema.Number,
    episodes: Schema.Array(WorkflowEpisode),
    episode_shapes: Schema.Array(EpisodeShapeAggregate),
    episode_shapes_total: Schema.Number,
    narrative: Schema.String,
});

/**
 * The insights family: cross-source recall, project pages, episode
 * timelines, the skill graph, wrapped profiles, workflow rollups, and tool
 * failures. Recall is the first response with a real Schema; the rest stay
 * `Schema.Unknown` for now - tightening is per-family follow-up work, and
 * raw-row passthroughs (graph-health, worktrees, self-improve) keep Unknown
 * deliberately (validating untyped DB rows buys little and risks 400s).
 *
 * Path params are single-segment: every client URL-encodes ids, and the
 * legacy greedy `:param+` rows remain mounted for raw-slash ids.
 */
export const InsightsGroup = HttpApiGroup.make("insights")
    .add(
        HttpApiEndpoint.get("recall", "/api/recall", {
            query: {
                q: Schema.optionalKey(Schema.String),
                project: Schema.optionalKey(Schema.String),
                skill: Schema.optionalKey(Schema.String),
                since: Schema.optionalKey(Schema.String),
                offset: Schema.optionalKey(Schema.Number),
                limit: Schema.optionalKey(Schema.Number),
            },
            success: RecallResponse,
            error: InternalError,
        }),
        HttpApiEndpoint.get("episodeTimeline", "/api/episodes/:parentId", {
            params: { parentId: Schema.String },
            success: EpisodeTimelinePayload,
            error: InternalError,
        }),
        HttpApiEndpoint.get("skillGraph", "/api/skill-graph", {
            query: {
                minCount: Schema.optionalKey(Schema.Number),
                limit: Schema.optionalKey(Schema.Number),
            },
            success: SkillGraphPayload,
            error: InternalError,
        }),
        HttpApiEndpoint.get("project", "/api/projects/:project", {
            params: { project: Schema.String },
            success: Schema.Unknown,
            error: [NotFoundError, InternalError],
        }),
        HttpApiEndpoint.get("wrapped", "/api/wrapped", {
            success: Schema.Unknown,
            error: InternalError,
        }),
        HttpApiEndpoint.get("wrappedPublicPreview", "/api/wrapped/public-preview", {
            success: Schema.Unknown,
            error: InternalError,
        }),
        HttpApiEndpoint.get("wrappedGenerateBrief", "/api/wrapped/generate-brief", {
            success: Schema.Unknown,
            error: InternalError,
        }),
        HttpApiEndpoint.get("costModels", "/api/cost/models", {
            success: Schema.Unknown,
            error: InternalError,
        }),
        HttpApiEndpoint.get("workflow", "/api/workflow", {
            success: WorkflowResponse,
            error: InternalError,
        }),
        HttpApiEndpoint.get("toolFailures", "/api/tool-failures", {
            success: ToolFailuresResponse,
            error: InternalError,
        }),
        HttpApiEndpoint.get("toolFailureDetail", "/api/tool-failures/:label/detail", {
            params: { label: Schema.String },
            success: ToolFailureDetailPayload,
            error: InternalError,
        }),
    );

// ---- sessions payloads (the bounded ones) -------------------------------
// Mirror the dashboard-types Session* interfaces. The deeply-nested
// detail/inspect/insights payloads stay Schema.Unknown below (transcribing
// the 54k-line inspect handler's output exactly is high-drift, low-value).

const SessionListRow = Schema.Struct({
    id: Schema.String,
    project: Schema.NullOr(Schema.String),
    source: Schema.String,
    cwd: Schema.NullOr(Schema.String),
    model: Schema.NullOr(Schema.String),
    started_at: Schema.NullOr(Schema.String),
    ended_at: Schema.NullOr(Schema.String),
    has_raw_file: Schema.Boolean,
    turn_count: Schema.Number,
    parent_session: Schema.NullOr(Schema.String),
    direct_children_count: Schema.optionalKey(Schema.Number),
    cost_usd: Schema.NullOr(Schema.Number),
    burn_buckets: Schema.NullOr(Schema.Array(Schema.Number)),
    friction: Schema.NullOr(Schema.Number),
    signal: Schema.NullOr(Schema.Literals(["clean", "friction"])),
    produced_commits: Schema.NullOr(Schema.Number),
    reverted_commits: Schema.NullOr(Schema.Number),
    lines_added: Schema.NullOr(Schema.Number),
    lines_removed: Schema.NullOr(Schema.Number),
    is_live: Schema.Boolean,
});

export const SessionListResponse = Schema.Struct({
    sessions: Schema.Array(SessionListRow),
    total_count: Schema.Number,
    burn_p90: Schema.NullOr(Schema.Number),
    window: Schema.Struct({ offset: Schema.Number, limit: Schema.Number }),
});

export const SessionChildrenResponse = Schema.Struct({
    parent_session: Schema.String,
    children: Schema.Array(SessionListRow),
});

export const SessionSummary = Schema.Struct({
    session_id: Schema.String,
    task: Schema.NullOr(Schema.String),
    first_ask: Schema.NullOr(Schema.String),
    last_assistant: Schema.NullOr(Schema.String),
    correction: Schema.NullOr(Schema.String),
    turns: Schema.Number,
    tokens: Schema.NullOr(Schema.Number),
    cost_usd: Schema.NullOr(Schema.Number),
    model: Schema.NullOr(Schema.String),
    subagents: Schema.Number,
    tools: Schema.Array(Schema.Struct({ name: Schema.String, count: Schema.Number })),
});

const SessionOrchestrationSubagent = Schema.Struct({
    id: Schema.String,
    nickname: Schema.NullOr(Schema.String),
    task: Schema.NullOr(Schema.String),
    started_at: Schema.NullOr(Schema.String),
    ended_at: Schema.NullOr(Schema.String),
    tone: Schema.String,
    duration_ms: Schema.NullOr(Schema.Number),
});

export const SessionOrchestration = Schema.Struct({
    session_id: Schema.String,
    label: Schema.String,
    started_at: Schema.NullOr(Schema.String),
    ended_at: Schema.NullOr(Schema.String),
    wait_pct: Schema.Number,
    subagents: Schema.Array(SessionOrchestrationSubagent),
});

const SessionTokenUsageDetail = Schema.Struct({
    model: Schema.NullOr(Schema.String),
    prompt_tokens: Schema.NullOr(Schema.Number),
    completion_tokens: Schema.NullOr(Schema.Number),
    cache_creation_input_tokens: Schema.NullOr(Schema.Number),
    cache_read_input_tokens: Schema.NullOr(Schema.Number),
    estimated_tokens: Schema.Number,
    estimated_input_cost_usd: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    estimated_output_cost_usd: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    estimated_cache_creation_cost_usd: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    estimated_cache_read_cost_usd: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    estimated_cost_usd: Schema.NullOr(Schema.Number),
    pricing_source: Schema.NullOr(Schema.String),
});

const SessionHealthSummary = Schema.Struct({
    turns: Schema.Number,
    tool_calls: Schema.Number,
    tool_errors: Schema.Number,
    user_corrections: Schema.Number,
    interruptions: Schema.Number,
    subagent_dispatches: Schema.Number,
    task_label: Schema.NullOr(Schema.String),
});

const SessionCompareTurn = Schema.Struct({
    seq: Schema.Number,
    role: Schema.NullOr(Schema.String),
    ts: Schema.NullOr(Schema.String),
    gap_ms: Schema.NullOr(Schema.Number),
    est_tokens: Schema.NullOr(Schema.Number),
    est_cost_usd: Schema.NullOr(Schema.Number),
    has_error: Schema.Boolean,
});

const SessionCompareEntry = Schema.Struct({
    session_id: Schema.String,
    source: Schema.String,
    model: Schema.NullOr(Schema.String),
    project: Schema.NullOr(Schema.String),
    started_at: Schema.NullOr(Schema.String),
    ended_at: Schema.NullOr(Schema.String),
    duration_ms: Schema.NullOr(Schema.Number),
    token_usage: Schema.NullOr(SessionTokenUsageDetail),
    health: Schema.NullOr(SessionHealthSummary),
    commit_count: Schema.Number,
    noise_score: Schema.NullOr(Schema.Number),
    turns: Schema.optionalKey(Schema.Array(SessionCompareTurn)),
});

export const SessionComparePayload = Schema.Struct({
    task_label: Schema.NullOr(Schema.String),
    sessions: Schema.Array(SessionCompareEntry),
    winners: Schema.Struct({
        fastest: Schema.NullOr(Schema.String),
        cheapest: Schema.NullOr(Schema.String),
        fewest_tokens: Schema.NullOr(Schema.String),
        cleanest: Schema.NullOr(Schema.String),
    }),
    not_found: Schema.Array(Schema.String),
});

const SessionCanvasNode = Schema.Struct({
    id: Schema.String,
    label: Schema.String,
    project: Schema.NullOr(Schema.String),
    source: Schema.String,
    started_at: Schema.NullOr(Schema.String),
    ended_at: Schema.NullOr(Schema.String),
    size: Schema.Number,
    turns: Schema.Number,
    epochs: Schema.Number,
    compactions: Schema.Array(Schema.Struct({ pre_tokens: Schema.Number, trigger: Schema.String })),
    context_pressure: Schema.String,
    corrections: Schema.Number,
    tone: Schema.String,
    is_subagent: Schema.Boolean,
    subagent_count: Schema.Number,
    wait_segments: Schema.Array(Schema.Struct({ start: Schema.Number, end: Schema.Number })),
});

const SessionCanvasEdge = Schema.Struct({
    source: Schema.String,
    target: Schema.String,
    relation: Schema.String,
    label: Schema.NullOr(Schema.String),
});

export const SessionCanvasPayload = Schema.Struct({
    generatedAt: Schema.String,
    nodes: Schema.Array(SessionCanvasNode),
    edges: Schema.Array(SessionCanvasEdge),
    warnings: Schema.Array(Schema.String),
});

/**
 * The sessions family: list, children, summary, orchestration, compare, and
 * canvas are schema-typed. The detail/inspect/insights/timeline payloads
 * stay `Schema.Unknown` deliberately - they are deeply-nested mega-payloads
 * (inspect comes from the 54k-line session-inspect handler) where exact
 * transcription is high-drift and low-value. Path params are single-segment
 * (client URL-encodes ids); the legacy greedy `:param+` rows are retired.
 */
export const SessionsGroup = HttpApiGroup.make("sessions")
    .add(
        HttpApiEndpoint.get("sessionCanvas", "/api/session-canvas", {
            query: {
                limit: Schema.optionalKey(Schema.Number),
            },
            success: SessionCanvasPayload,
            error: InternalError,
        }),
        HttpApiEndpoint.get("sessionSummary", "/api/session-summary", {
            query: {
                id: Schema.String,
            },
            success: SessionSummary,
            error: InternalError,
        }),
        HttpApiEndpoint.get("sessionOrchestration", "/api/session-orchestration", {
            query: {
                id: Schema.String,
            },
            success: SessionOrchestration,
            error: InternalError,
        }),
        HttpApiEndpoint.get("sessionsList", "/api/sessions", {
            query: {
                offset: Schema.optionalKey(Schema.Number),
                limit: Schema.optionalKey(Schema.Number),
                source: Schema.optionalKey(Schema.String),
                project: Schema.optionalKey(Schema.String),
            },
            success: SessionListResponse,
            error: InternalError,
        }),
        // Static path must precede the single-segment param path: HttpApi's
        // FindMyWay router gives static paths precedence, so /api/sessions/compare
        // resolves here even though it also matches /api/sessions/:id.
        HttpApiEndpoint.get("sessionCompare", "/api/sessions/compare", {
            query: {
                ids: Schema.String,
                turns: Schema.optionalKey(Schema.String),
            },
            success: SessionComparePayload,
            error: [BadRequestError, InternalError],
        }),
        HttpApiEndpoint.get("sessionChildren", "/api/sessions/:id/children", {
            params: { id: Schema.String },
            query: {
                limit: Schema.optionalKey(Schema.Number),
            },
            success: SessionChildrenResponse,
            error: InternalError,
        }),
        HttpApiEndpoint.get("sessionInsights", "/api/sessions/:id/insights", {
            params: { id: Schema.String },
            success: Schema.Unknown,
            error: InternalError,
        }),
        HttpApiEndpoint.get("sessionInspect", "/api/sessions/:id/inspect", {
            params: { id: Schema.String },
            query: {
                turn_offset: Schema.optionalKey(Schema.Number),
                turn_limit: Schema.optionalKey(Schema.Number),
            },
            success: Schema.Unknown,
            error: [NotFoundError, InternalError],
        }),
        HttpApiEndpoint.get("sessionTimeline", "/api/sessions/:id/timeline", {
            params: { id: Schema.String },
            success: Schema.Unknown,
            error: [NotFoundError, InternalError],
        }),
        HttpApiEndpoint.get("sessionDetail", "/api/sessions/:id", {
            params: { id: Schema.String },
            success: Schema.Unknown,
            error: InternalError,
        }),
    );

/** Conflicting state transition (improve actions) - `{ error }` HTTP 409. */
export class ConflictError extends Schema.ErrorClass<ConflictError>("ax/ConflictError")({
    error: Schema.String,
}, { httpApiStatus: 409 }) {}

/** Live-ingest unavailable (no sidecar) - `{ error }` HTTP 503. */
export class ServiceUnavailableError extends Schema.ErrorClass<ServiceUnavailableError>("ax/ServiceUnavailableError")({
    error: Schema.String,
}, { httpApiStatus: 503 }) {}

/** Skill triage decision states (mirrors dashboard-types TriageDecision). */
export const TriageDecisionSchema = Schema.Literals(["keep", "archive", "review"]);

// ---- skills payloads (Schema.Struct: encode-safe for plain handler returns) -
// Mirror the dashboard-types Skill* interfaces exactly. Handlers JS-map their
// rows, so plain objects encode cleanly through these (see RecallResponse).

export const SkillTriageNote = Schema.Struct({
    skill_name: Schema.String,
    decision: TriageDecisionSchema,
    reason: Schema.NullOr(Schema.String),
    decided_at: Schema.String,
});

const SkillRowFields = {
    name: Schema.String,
    scope: Schema.String,
    description: Schema.NullOr(Schema.String),
    dir_path: Schema.NullOr(Schema.String),
    bytes: Schema.NullOr(Schema.Number),
    total_inv: Schema.Number,
    inv_7d: Schema.Number,
    inv_30d: Schema.Number,
    last_used: Schema.NullOr(Schema.String),
    last_project: Schema.NullOr(Schema.String),
    corrections: Schema.Number,
    proposals: Schema.Number,
    commits_after: Schema.Number,
    taste_score: Schema.Number,
};

export const SkillTriageEntry = Schema.Struct({
    ...SkillRowFields,
    recommendation: TriageDecisionSchema,
    recommendation_reason: Schema.String,
    decision: Schema.NullOr(SkillTriageNote),
});

export const SkillTriageResponse = Schema.Struct({
    generatedAt: Schema.String,
    skills: Schema.Array(SkillTriageEntry),
});

const SkillRecentInvocation = Schema.Struct({
    ts: Schema.String,
    project: Schema.NullOr(Schema.String),
    turn_has_error: Schema.optionalKey(Schema.Boolean),
});

const SkillProposalEvidence = Schema.Struct({
    ts: Schema.String,
    project: Schema.NullOr(Schema.String),
    context_excerpt: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const SkillPair = Schema.Struct({
    partner: Schema.String,
    count: Schema.Number,
    last_seen: Schema.NullOr(Schema.String),
});

export const SkillDetailPayload = Schema.Struct({
    name: Schema.String,
    scope: Schema.NullOr(Schema.String),
    description: Schema.NullOr(Schema.String),
    dir_path: Schema.NullOr(Schema.String),
    invocations: Schema.Struct({
        total: Schema.Number,
        d7: Schema.Number,
        d30: Schema.Number,
        last: Schema.NullOr(Schema.String),
    }),
    recent: Schema.Array(SkillRecentInvocation),
    corrections: Schema.Array(SkillRecentInvocation),
    proposals: Schema.Array(SkillProposalEvidence),
    paired: Schema.Array(SkillPair),
});

export const SkillSourcePayload = Schema.Struct({
    name: Schema.String,
    scope: Schema.String,
    dir_path: Schema.NullOr(Schema.String),
    file_path: Schema.NullOr(Schema.String),
    frontmatter: Schema.NullOr(Schema.String),
    body: Schema.NullOr(Schema.String),
    state: Schema.Literals(["active", "disabled", "missing"]),
    editable: Schema.Boolean,
    error: Schema.NullOr(Schema.String),
});

export const SkillDecisionsResponse = Schema.Struct({
    decisions: Schema.Array(SkillTriageNote),
});

export const SkillDecideBulkResponse = Schema.Struct({
    notes: Schema.Array(SkillTriageNote),
});

export const SkillDecideClearResponse = Schema.Struct({
    cleared: Schema.Boolean,
    skill_name: Schema.String,
});

export const SkillOpenResponse = Schema.Struct({ launched: Schema.String });

/**
 * The skills family: triage listing, per-skill decide (POST/DELETE),
 * bulk decide, detail, source, open-in, and the decisions list. Request
 * bodies AND responses are schema-typed; the handlers return plain objects.
 */
export const SkillsGroup = HttpApiGroup.make("skills")
    .add(
        HttpApiEndpoint.get("decisions", "/api/decisions", {
            success: SkillDecisionsResponse,
            error: InternalError,
        }),
        HttpApiEndpoint.get("skills", "/api/skills", {
            success: SkillTriageResponse,
            error: InternalError,
        }),
        HttpApiEndpoint.post("skillDecideBulk", "/api/skills/decide-bulk", {
            payload: Schema.Struct({
                names: Schema.Array(Schema.String),
                decision: TriageDecisionSchema,
                reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
            }),
            success: SkillDecideBulkResponse,
            error: [BadRequestError, InternalError],
        }),
        HttpApiEndpoint.post("skillDecide", "/api/skills/:name/decide", {
            params: { name: Schema.String },
            payload: Schema.Struct({
                decision: TriageDecisionSchema,
                reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
            }),
            success: SkillTriageNote,
            error: InternalError,
        }),
        HttpApiEndpoint.delete("skillDecideClear", "/api/skills/:name/decide", {
            params: { name: Schema.String },
            success: SkillDecideClearResponse,
            error: InternalError,
        }),
        HttpApiEndpoint.get("skillDetail", "/api/skills/:name/detail", {
            params: { name: Schema.String },
            success: SkillDetailPayload,
            error: InternalError,
        }),
        HttpApiEndpoint.get("skillSource", "/api/skills/:name/source", {
            params: { name: Schema.String },
            success: SkillSourcePayload,
            error: InternalError,
        }),
        HttpApiEndpoint.post("skillOpen", "/api/skills/:name/open", {
            params: { name: Schema.String },
            payload: Schema.Struct({
                target: Schema.Literals(["finder", "editor"]),
            }),
            success: SkillOpenResponse,
            error: InternalError,
        }),
    );

/**
 * The improve family (experiment loop): the proposals list and the three
 * proposal actions. Action results carry a status string the daemon maps
 * to HTTP (ok -> 200 body, otherwise the matching error class).
 */
export const ImproveGroup = HttpApiGroup.make("improve")
    .add(
        HttpApiEndpoint.get("improveList", "/api/improve", {
            success: Schema.Unknown,
            error: InternalError,
        }),
        HttpApiEndpoint.get("nextActions", "/api/next-actions", {
            success: Schema.Unknown,
            error: InternalError,
        }),
        HttpApiEndpoint.get("analyzeBrief", "/api/improve/analyze-brief", {
            success: Schema.Unknown,
            error: InternalError,
        }),
        HttpApiEndpoint.get("improveImpact", "/api/improve/:sig/impact", {
            params: { sig: Schema.String },
            success: Schema.Unknown,
            error: [NotFoundError, InternalError],
        }),
        HttpApiEndpoint.post("improveAction", "/api/improve/:sig/:action", {
            params: {
                sig: Schema.String,
                // String, not Literals: an unknown action must answer the
                // legacy 404 `{ error: "unknown_improve_action" }`, which the
                // handler produces - a Literals decode failure would be a 400.
                action: Schema.String,
            },
            payload: Schema.Struct({
                force: Schema.optionalKey(Schema.Boolean),
                reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
                verdict: Schema.optionalKey(Schema.String),
            }),
            success: Schema.Unknown,
            error: [BadRequestError, NotFoundError, ConflictError, InternalError],
        }),
    );

// ---- OTLP receiver -------------------------------------------------------

/** OTLP/HTTP ack: `{ partialSuccess: {} }` (all signals, all cases). */
export const OtlpAck = Schema.Struct({
    partialSuccess: Schema.optional(Schema.Struct({})),
});

/**
 * The OTLP receiver family: POST /v1/metrics, /v1/traces, /v1/logs.
 *
 * All three accept arbitrary binary/JSON bodies (the payload is decoded
 * manually in the handler via `handleRaw`; `Schema.Unknown` here is a
 * placeholder so HttpApi registers the endpoint - the actual payload decoding
 * happens inside the handler, not through the contract codec).
 * All three return the standard OTLP/HTTP ack `{ partialSuccess: {} }`.
 */
export const OtelGroup = HttpApiGroup.make("otel")
    .add(
        HttpApiEndpoint.post("otlpMetrics", "/v1/metrics", {
            payload: Schema.Unknown,
            success: OtlpAck,
        }),
        HttpApiEndpoint.post("otlpTraces", "/v1/traces", {
            payload: Schema.Unknown,
            success: OtlpAck,
        }),
        HttpApiEndpoint.post("otlpLogs", "/v1/logs", {
            payload: Schema.Unknown,
            success: OtlpAck,
        }),
    );

/** POST /api/ingest - trigger a live ingest run (Durable Streams sidecar). */
export class IngestTriggerResult extends Schema.Class<IngestTriggerResult>("ax/IngestTriggerResult")({
    runId: Schema.String,
    /** Full sidecar stream URL the browser subscribes to directly. */
    stream: Schema.String,
    streamName: Schema.String,
    streamBaseUrl: Schema.String,
}) {}

/**
 * The live family's JSON endpoint. SSE /api/events and binary /api/image
 * stay OUTSIDE the contract permanently (module doc above).
 */
export const LiveGroup = HttpApiGroup.make("live")
    .add(
        HttpApiEndpoint.post("ingestTrigger", "/api/ingest", {
            payload: Schema.Struct({
                since: Schema.optionalKey(Schema.Number),
            }),
            success: IngestTriggerResult,
            error: [ServiceUnavailableError, InternalError],
        }),
    );

/** The Insights Surface Contract. Families join as they migrate (ADR-0013). */
export const AxApi = HttpApi.make("ax")
    .add(SystemGroup)
    .add(InsightsGroup)
    .add(SessionsGroup)
    .add(SkillsGroup)
    .add(ImproveGroup)
    .add(LiveGroup)
    .add(OtelGroup)
    .annotate(OpenApi.Title, "ax daemon API")
    .annotate(OpenApi.Version, "1");
