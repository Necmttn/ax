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

/** The Insights Surface Contract. Families join as they migrate (ADR-0013). */
export const AxApi = HttpApi.make("ax")
    .add(SystemGroup)
    .annotate(OpenApi.Title, "ax daemon API")
    .annotate(OpenApi.Version, "1");
