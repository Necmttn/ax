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
                // Retired too: the OTLP receiver moved to its own long-lived
                // daemon (`ax otlpd`) - this router registers zero /v1/*
                // routes now, so answering `true` here was stale (issue: the
                // daemon claimed a capability it no longer has).
                otlp_receiver: false,
                // POST /hooks/eval warm-evaluates SDK hooks (DB-free); the hook
                // shim probes this to decide daemon-first vs spawn fallback.
                hooks_eval: true,
            }),
    }),
];
