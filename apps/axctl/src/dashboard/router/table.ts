/**
 * The legacy dashboard route table - now only the routes that deliberately
 * live OUTSIDE the Insights Surface Contract (ADR-0013):
 *   - GET /api/version (DB-free identity probe; see routes/system.ts)
 *   - GET /api/graph-explorer (env-gated experiment; see routes/insights.ts)
 *   - GET /api/events + GET /api/image (SSE/binary; see routes/live.ts)
 *   - POST /hooks/eval (DB-free hook dispatcher fast-path; see routes/hooks.ts)
 * Every other endpoint is served by the contract router
 * (../contract/web-handler.ts) before dispatch reaches this table.
 */
import type { AnyRoute } from "./router.ts";
import { hooksRoutes } from "./routes/hooks.ts";
import { insightRoutes } from "./routes/insights.ts";
import { liveRoutes } from "./routes/live.ts";
import { systemRoutes } from "./routes/system.ts";

export const routeTable: ReadonlyArray<AnyRoute> = [
    ...systemRoutes,
    ...insightRoutes,
    ...liveRoutes,
    ...hooksRoutes,
];
