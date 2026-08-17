/**
 * Handlers for the system group of the Insights Surface Contract
 * (@ax/lib/shared/api-contract). Behavior parity with the legacy
 * router/routes/system.ts rows is the contract here: same payloads, same
 * status mapping (read failures -> { error } 500).
 *
 * Studio ephemeral (wave 3): `POST /api/query` (the raw read-only SQL
 * console) and `GET /api/graph-health` are not implemented. Studio
 * ephemeral's whole point is zero required daemons; either endpoint would
 * mean re-opening a dependency (an admin SQL console, a health scan) that
 * does not belong on a process that reads a published snapshot and exits.
 * `GET /api/worktrees` and `GET /api/self-improve` read through `CacheRead`
 * and are unaffected.
 */
import { Effect } from "effect";
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

const errorText = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);

const internal = (err: unknown) => new InternalError({ error: errorText(err) });

export const SystemGroupLive = HttpApiBuilder.group(AxApi, "system", (handlers) =>
    handlers
        .handle("version", () =>
            Effect.gen(function* () {
                return new DaemonVersion({
                    version: AX_VERSION,
                    api_version: API_VERSION,
                    capabilities: dashboardApiCapabilities(),
                    // Retired in studio ephemeral (wave 3): the in-browser
                    // ingest trigger + its Durable Streams sidecar are gone.
                    live_ingest: false,
                    // Derived from the capability list, never hardcoded: the two
                    // live in the SAME response body, and for a while they
                    // disagreed - `capabilities` carried "otlp" while this said
                    // `false`, so a client that gated on the boolean concluded the
                    // receiver was absent while `POST /v1/logs` on that very port
                    // answered 200 `{"partialSuccess":{}}`. The comment that
                    // justified the `false` claimed this router registers zero
                    // /v1/* routes; `OtelGroupLive` is mounted in
                    // contract/web-handler.ts and appends to the spool.
                    //
                    // What IS true: `ax studio` is on-demand and exits when the
                    // last client disconnects, so it is not a durable exporter
                    // target - that is `ax otlpd`. This field answers "can this
                    // process accept OTLP right now", and it can.
                    otlp_receiver: dashboardApiCapabilities().includes("otlp"),
                });
            }))
        .handle("worktrees", () =>
            Effect.gen(function* () {
                // Deref-free aggregates + JS join: the legacy correlated SQL
                // took 50+ seconds and died on the 60s idleTimeout.
                const overview = yield* fetchWorktreesOverview(50).pipe(Effect.mapError(internal));
                // asJsonValue: forces plain JSON data - see common.ts.
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
