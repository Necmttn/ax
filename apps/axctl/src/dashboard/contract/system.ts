/**
 * Handlers for the system group of the Insights Surface Contract
 * (@ax/lib/shared/api-contract). Behavior parity with the legacy
 * router/routes/system.ts rows is the contract here: same payloads, same
 * status mapping (read failures -> { error } 500).
 *
 * Studio ephemeral (wave 3): `POST /api/query` (the raw read-only SQL
 * console) and `GET /api/graph-health` are RETIRED, not ported. Both were the
 * last two things in this contract still reaching for `SurrealClient` -
 * graph-health's `graphHealthSql` composes correlated SurrealQL sub-queries
 * with no DuckDB equivalent, and it queries a database that is write-frozen
 * (wave 3's `c-ingest-cutover`), so it had quietly become a dead reader:
 * every call would answer against whatever SurrealDB happened to still hold,
 * never the live graph. Studio ephemeral's whole point is zero required
 * daemons; keeping either endpoint alive would mean re-opening the one
 * dependency this chunk exists to remove for a feature (an admin SQL console,
 * a health scan) that does not belong on a process that reads a published
 * snapshot and exits. `GET /api/worktrees` and `GET /api/self-improve` were
 * already ported to `CacheRead` and are unaffected.
 */
import { Context, Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
    AxApi,
    DaemonVersion,
    InternalError,
    WorktreesResult,
} from "@ax/lib/shared/api-contract";
import { CacheRead } from "@ax/lib/duckdb/seam";
import { AX_VERSION } from "../../cli/version.ts";
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
                    // OTLP receiver is pure HTTP+JSON+SurrealDB (no native dep),
                    // so it works in both source and compiled binary - always true.
                    otlp_receiver: true,
                });
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
