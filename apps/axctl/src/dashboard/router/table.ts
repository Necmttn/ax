/**
 * The ordered dashboard route table. FIRST MATCH WINS - keep static paths
 * before param paths within a family, and keep the sessions detail
 * catch-all (`/api/sessions/:id+`) after its sibling subroutes.
 */
import type { AnyRoute } from "./router.ts";
import { insightRoutes } from "./routes/insights.ts";
import { sessionRoutes } from "./routes/sessions.ts";
import { systemRoutes } from "./routes/system.ts";

export const routeTable: ReadonlyArray<AnyRoute> = [
    ...systemRoutes,
    ...insightRoutes,
    ...sessionRoutes,
];
