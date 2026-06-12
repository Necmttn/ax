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
import { AX_VERSION } from "../../cli/version.ts";
import { graphHealthSql } from "../../queries/graph-health.ts";
import { API_VERSION, dashboardApiCapabilities } from "../capabilities.ts";
import { fetchWorktreesOverview } from "../worktrees-overview.ts";
import { asJsonValue } from "./common.ts";

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
                });
            }))
        .handle("query", ({ payload }) =>
            Effect.gen(function* () {
                const sql = payload.sql.trim();
                if (!sql) return yield* new QueryRejected({ error: "SQL is required" });
                if (!/^(SELECT|RETURN|INFO)\b/i.test(sql)) {
                    return yield* new QueryRejected({
                        error: "Only SELECT, RETURN, and INFO queries are allowed",
                    });
                }
                const started = performance.now();
                const db = yield* SurrealClient;
                const result = yield* db.query(sql).pipe(
                    Effect.mapError((err) => new QueryRejected({ error: errorText(err) })),
                );
                return new QueryResult({
                    result,
                    durationMs: Math.round(performance.now() - started),
                });
            }))
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
                const db = yield* SurrealClient;
                return yield* db.query(`
SELECT id, guidance, version, text, status, scope, risk, evidence, metrics_before, metrics_after, created_at
FROM guidance_version
ORDER BY created_at DESC
LIMIT 50;`).pipe(Effect.mapError(internal));
            })));
