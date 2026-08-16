/**
 * Handlers for the system group of the Insights Surface Contract
 * (@ax/lib/shared/api-contract). Behavior parity with the legacy
 * router/routes/system.ts rows is the contract here: same payloads, same
 * status mapping (query failures -> 400, read failures -> { error } 500).
 */
import { Context, Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
    AxApi,
    DaemonVersion,
    InternalError,
    QueryRejected,
    QueryResult,
    WorktreesResult,
} from "@ax/lib/shared/api-contract";
import { SurrealClient } from "@ax/lib/db";
import { CacheRead } from "@ax/lib/duckdb/seam";
import { AX_VERSION } from "../../cli/version.ts";
import { graphHealthSql } from "../../queries/graph-health.ts";
import { API_VERSION, dashboardApiCapabilities } from "../capabilities.ts";
import { fetchWorktreesOverview } from "../worktrees-overview.ts";
import { asJsonValue } from "./common.ts";
import { isSingleReadStatement } from "./read-guard.ts";

/**
 * Boot-time facts the contract handlers need from `serveDashboard`: the
 * Durable Streams sidecar handle when it came up (null on the compiled
 * binary). Provided as a layer when the web handler is built - the
 * contract module itself must stay daemon-agnostic.
 */
export class ContractServeInfo extends Context.Service<
    ContractServeInfo,
    { readonly ingestStream: import("../ingest-stream-durable.ts").DurableIngestStream | null }
>()("axctl/dashboard/ContractServeInfo") {}

const errorText = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);

const internal = (err: unknown) => new InternalError({ error: errorText(err) });

export const SystemGroupLive = HttpApiBuilder.group(AxApi, "system", (handlers) =>
    handlers
        .handle("version", () =>
            Effect.gen(function* () {
                const info = yield* ContractServeInfo;
                return new DaemonVersion({
                    version: AX_VERSION,
                    api_version: API_VERSION,
                    capabilities: dashboardApiCapabilities(),
                    live_ingest: info.ingestStream !== null,
                    // OTLP receiver is pure HTTP+JSON+SurrealDB (no native dep),
                    // so it works in both source and compiled binary - always true.
                    otlp_receiver: true,
                });
            }))
        .handle("query", ({ payload }) =>
            Effect.gen(function* () {
                const sql = payload.sql.trim();
                if (!sql) return yield* new QueryRejected({ error: "SQL is required" });
                if (!isSingleReadStatement(sql)) {
                    return yield* new QueryRejected({
                        error: "Only a single SELECT or read-only DuckDB introspection statement is allowed",
                    });
                }
                const started = performance.now();
                const read = yield* CacheRead;
                // Undecoded pass-through (`raw`): the console accepts caller-typed
                // SQL with no schema to decode against - same as the old
                // SurrealClient.query passthrough. The console's query LANGUAGE
                // changed with the engine (DuckDB SQL, not SurrealQL) - see
                // read-guard.ts's module doc.
                const result = yield* read.raw(sql).pipe(
                    Effect.mapError((err) => new QueryRejected({ error: errorText(err) })),
                );
                return new QueryResult({
                    result,
                    durationMs: Math.round(performance.now() - started),
                });
            }))
        // NOT YET PORTED: graphHealthSql (queries/graph-health.ts, chunk 2b's)
        // composes 6 sub-diagnostics (duplicate-identity scans across 7 edge
        // tables, a backlink count, array::group aggregation) into one
        // SurrealQL `RETURN { ... }` object literal - a genuinely complex
        // multi-query bundle, not a mechanical single-query translation. Left
        // on SurrealClient (write-frozen but still reachable) until 2b lands a
        // CacheRead equivalent or this gets its own translation pass.
        .handle("graphHealth", () =>
            Effect.gen(function* () {
                const db = yield* SurrealClient;
                return yield* db.query(graphHealthSql(25)).pipe(Effect.mapError(internal));
            }))
        .handle("worktrees", () =>
            Effect.gen(function* () {
                // Deref-free aggregates + JS join: the legacy correlated SQL
                // took 50+ seconds and died on the 60s idleTimeout.
                const overview = yield* fetchWorktreesOverview(50).pipe(Effect.mapError(internal));
                // asJsonValue: rows carry RecordId instances - see common.ts.
                return new WorktreesResult({
                    activity: asJsonValue(overview.activity),
                    git: asJsonValue(overview.git),
                });
            }))
        .handle("selfImprove", () =>
            Effect.gen(function* () {
                const read = yield* CacheRead;
                return yield* read.raw(`
SELECT id, guidance, version, text, status, scope, risk, evidence, metrics_before, metrics_after, created_at
FROM guidance_version
ORDER BY created_at DESC
LIMIT 50;`).pipe(Effect.mapError(internal));
            })));
