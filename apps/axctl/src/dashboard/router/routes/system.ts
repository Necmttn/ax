/**
 * System family: only GET /api/version remains in the legacy table. It is
 * the daemon's identity probe (`ax studio` pre-flight, deeplink liveness,
 * desktop arbitration) and must answer when the published snapshot is
 * missing/empty, so it stays a DB-free rawRoute here even though the
 * endpoint is part of the Insights Surface Contract (docs + generated
 * client). Everything else in this family is served by the contract router
 * (ADR-0013).
 */
import { AX_VERSION } from "../../../cli/version.ts";
import { API_VERSION, dashboardApiCapabilities } from "../../capabilities.ts";
import { jsonResponse, rawRoute, type AnyRoute } from "../router.ts";

export const systemRoutes: ReadonlyArray<AnyRoute> = [
    rawRoute({
        method: "ANY", // legacy: /api/version answered every method; studio probes it
        path: "/api/version",
        handler: () =>
            jsonResponse({
                version: AX_VERSION,
                api_version: API_VERSION,
                capabilities: dashboardApiCapabilities(),
                // Retired in studio ephemeral (wave 3): the in-browser ingest
                // trigger + its Durable Streams sidecar are gone. Kept on the
                // wire (optional field) so an older studio bundle's polling
                // fallback still engages correctly instead of erroring on a
                // missing key.
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
                // POST /hooks/eval warm-evaluates SDK hooks (DB-free); the hook
                // shim probes this to decide daemon-first vs spawn fallback.
                hooks_eval: true,
            }),
    }),
];
