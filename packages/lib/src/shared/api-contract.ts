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

/**
 * The insights family: cross-source recall, project pages, episode
 * timelines, the skill graph, wrapped profiles, workflow rollups, and tool
 * failures. Payloads are `Schema.Unknown` for now (same later-pass deal as
 * the system raw rows); paths, params, and status mapping are the contract.
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
            success: Schema.Unknown,
            error: InternalError,
        }),
        HttpApiEndpoint.get("episodeTimeline", "/api/episodes/:parentId", {
            params: { parentId: Schema.String },
            success: Schema.Unknown,
            error: InternalError,
        }),
        HttpApiEndpoint.get("skillGraph", "/api/skill-graph", {
            query: {
                minCount: Schema.optionalKey(Schema.Number),
                limit: Schema.optionalKey(Schema.Number),
            },
            success: Schema.Unknown,
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
        HttpApiEndpoint.get("workflow", "/api/workflow", {
            success: Schema.Unknown,
            error: InternalError,
        }),
        HttpApiEndpoint.get("toolFailures", "/api/tool-failures", {
            success: Schema.Unknown,
            error: InternalError,
        }),
        HttpApiEndpoint.get("toolFailureDetail", "/api/tool-failures/:label/detail", {
            params: { label: Schema.String },
            success: Schema.Unknown,
            error: InternalError,
        }),
    );

/**
 * The sessions family: per-session detail, list, canvas, compare, inspect,
 * timeline, insights, orchestration, children, and summary. Payloads are
 * `Schema.Unknown` (same later-pass deal); paths, params, and status mapping
 * are the contract. Path params are single-segment (client URL-encodes ids);
 * the legacy greedy `:param+` rows remain mounted for raw-slash ids.
 */
export const SessionsGroup = HttpApiGroup.make("sessions")
    .add(
        HttpApiEndpoint.get("sessionCanvas", "/api/session-canvas", {
            query: {
                limit: Schema.optionalKey(Schema.Number),
            },
            success: Schema.Unknown,
            error: InternalError,
        }),
        HttpApiEndpoint.get("sessionSummary", "/api/session-summary", {
            query: {
                id: Schema.String,
            },
            success: Schema.Unknown,
            error: InternalError,
        }),
        HttpApiEndpoint.get("sessionOrchestration", "/api/session-orchestration", {
            query: {
                id: Schema.String,
            },
            success: Schema.Unknown,
            error: InternalError,
        }),
        HttpApiEndpoint.get("sessionsList", "/api/sessions", {
            query: {
                offset: Schema.optionalKey(Schema.Number),
                limit: Schema.optionalKey(Schema.Number),
                source: Schema.optionalKey(Schema.String),
                project: Schema.optionalKey(Schema.String),
            },
            success: Schema.Unknown,
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
            success: Schema.Unknown,
            error: [BadRequestError, InternalError],
        }),
        HttpApiEndpoint.get("sessionChildren", "/api/sessions/:id/children", {
            params: { id: Schema.String },
            query: {
                limit: Schema.optionalKey(Schema.Number),
            },
            success: Schema.Unknown,
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

/**
 * The skills family: triage listing, per-skill decide (POST/DELETE),
 * bulk decide, detail, source, open-in, and the decisions list. Payloads
 * `Schema.Unknown` except the mutation request bodies, which are typed.
 */
export const SkillsGroup = HttpApiGroup.make("skills")
    .add(
        HttpApiEndpoint.get("decisions", "/api/decisions", {
            success: Schema.Unknown,
            error: InternalError,
        }),
        HttpApiEndpoint.get("skills", "/api/skills", {
            success: Schema.Unknown,
            error: InternalError,
        }),
        HttpApiEndpoint.post("skillDecideBulk", "/api/skills/decide-bulk", {
            payload: Schema.Struct({
                names: Schema.Array(Schema.String),
                decision: TriageDecisionSchema,
                reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
            }),
            success: Schema.Unknown,
            error: [BadRequestError, InternalError],
        }),
        HttpApiEndpoint.post("skillDecide", "/api/skills/:name/decide", {
            params: { name: Schema.String },
            payload: Schema.Struct({
                decision: TriageDecisionSchema,
                reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
            }),
            success: Schema.Unknown,
            error: InternalError,
        }),
        HttpApiEndpoint.delete("skillDecideClear", "/api/skills/:name/decide", {
            params: { name: Schema.String },
            success: Schema.Unknown,
            error: InternalError,
        }),
        HttpApiEndpoint.get("skillDetail", "/api/skills/:name/detail", {
            params: { name: Schema.String },
            success: Schema.Unknown,
            error: InternalError,
        }),
        HttpApiEndpoint.get("skillSource", "/api/skills/:name/source", {
            params: { name: Schema.String },
            success: Schema.Unknown,
            error: InternalError,
        }),
        HttpApiEndpoint.post("skillOpen", "/api/skills/:name/open", {
            params: { name: Schema.String },
            payload: Schema.Struct({
                target: Schema.Literals(["finder", "editor"]),
            }),
            success: Schema.Unknown,
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
    .annotate(OpenApi.Title, "ax daemon API")
    .annotate(OpenApi.Version, "1");
