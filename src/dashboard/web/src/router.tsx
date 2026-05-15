import {
    createRootRoute,
    createRoute,
    createRouter,
    Link,
    Outlet,
} from "@tanstack/react-router";
import { Shell } from "./Shell.tsx";
import { SkillsRoute } from "./routes/skills.tsx";
import { DecisionsRoute } from "./routes/decisions.tsx";
import { ToolFailuresRoute } from "./routes/tools.tsx";
import { WorkflowRoute } from "./routes/workflow.tsx";
import { SessionRoute } from "./routes/session.tsx";
import { EpisodeRoute } from "./routes/episode.tsx";
import { ProjectRoute } from "./routes/project.tsx";
import { RecallRoute } from "./routes/recall.tsx";
import { SkillGraphRoute } from "./routes/skill-graph.tsx";
import { GraphRoute } from "./routes/graph.tsx";
import type { GraphExplorerMode } from "@shared/dashboard-types.ts";
import { WrappedRoute } from "./routes/wrapped.tsx";

const rootRoute = createRootRoute({
    component: () => (
        <Shell>
            <Outlet />
        </Shell>
    ),
    notFoundComponent: () => (
        <section className="panel">
            <header>
                <h2>Page not found</h2>
                <span className="meta">404</span>
            </header>
            <p style={{ margin: "8px 0 16px" }}>
                Nothing here. The dashboard only has the Skill Triage view for now.
            </p>
            <div className="actions">
                <Link to="/skills" className="badge keep" style={{ textDecoration: "none" }}>
                    ← Back to Skills
                </Link>
            </div>
        </section>
    ),
});

const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: SkillsRoute,
});

const skillsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/skills",
    component: SkillsRoute,
    validateSearch: (search): { q?: string } => ({
        q: typeof search.q === "string" ? search.q : undefined,
    }),
});

const decisionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/decisions",
    component: DecisionsRoute,
});

const toolsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/tools",
    component: ToolFailuresRoute,
    validateSearch: (search): { q?: string } => ({
        q: typeof search.q === "string" ? search.q : undefined,
    }),
});

const workflowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflow",
    component: WorkflowRoute,
});

const sessionRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/sessions/$sessionId",
    component: SessionRoute,
});

const episodeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/episodes/$parentId",
    component: EpisodeRoute,
});

const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$slug",
    component: ProjectRoute,
});

const skillGraphRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/skills/graph",
    component: SkillGraphRoute,
    validateSearch: (search): { minCount?: number } => ({
        minCount:
            typeof search.minCount === "number" && Number.isFinite(search.minCount)
                ? search.minCount
                : undefined,
    }),
});

const graphModes = new Set<GraphExplorerMode>([
    "file-attention",
    "ask-outcome",
    "phase-balance",
    "delivery",
    "patterns",
    "skill-pairs",
]);

const graphRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/graph",
    component: GraphRoute,
    validateSearch: (search): {
        mode?: GraphExplorerMode;
        q?: string;
        limit?: number;
    } => ({
        mode:
            typeof search.mode === "string" && graphModes.has(search.mode as GraphExplorerMode)
                ? search.mode as GraphExplorerMode
                : undefined,
        q: typeof search.q === "string" ? search.q : undefined,
        limit:
            typeof search.limit === "number" && Number.isFinite(search.limit)
                ? search.limit
                : undefined,
    }),
});

const recallRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/recall",
    component: RecallRoute,
    validateSearch: (search): {
        q?: string;
        project?: string;
        skill?: string;
        since?: string;
    } => ({
        q: typeof search.q === "string" ? search.q : undefined,
        project: typeof search.project === "string" ? search.project : undefined,
        skill: typeof search.skill === "string" ? search.skill : undefined,
        since: typeof search.since === "string" ? search.since : undefined,
    }),
});

const wrappedRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/wrapped",
    component: WrappedRoute,
});

const routeTree = rootRoute.addChildren([
    indexRoute,
    skillsRoute,
    decisionsRoute,
    toolsRoute,
    workflowRoute,
    sessionRoute,
    episodeRoute,
    projectRoute,
    skillGraphRoute,
    graphRoute,
    recallRoute,
    wrappedRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
    interface Register {
        router: typeof router;
    }
}
