/**
 * System family: only GET /api/version remains in the legacy table. It is
 * the daemon's identity probe (`ax serve` pre-flight, studio connect,
 * desktop arbitration) and must answer when SurrealDB is down, so it stays
 * a DB-free rawRoute here even though the endpoint is part of the Insights
 * Surface Contract (docs + generated client). Everything else in this
 * family is served by the contract router (ADR-0013).
 */
import { AX_VERSION } from "../../../cli/version.ts";
import { API_VERSION, dashboardApiCapabilities } from "../../capabilities.ts";
import { jsonResponse, rawRoute, type AnyRoute } from "../router.ts";

export const systemRoutes: ReadonlyArray<AnyRoute> = [
    rawRoute({
        method: "ANY", // legacy: /api/version answered every method; studio probes it
        path: "/api/version",
        handler: ({ serve }) =>
            jsonResponse({
                version: AX_VERSION,
                api_version: API_VERSION,
                capabilities: dashboardApiCapabilities(),
                // Whether the Durable Streams sidecar is actually hosting live
                // ingest. False on the compiled binary (native lmdb can't
                // bundle), where POST /api/ingest would 503 - the studio reads
                // this to engage its polling fallback up front. Additive
                // optional field: forward-compatible, no api_version bump.
                live_ingest: serve?.ingestStream != null,
            }),
    }),
];
