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
import { SessionInspectRoute } from "./routes/session-inspect.tsx";
import { ShareInspectRoute } from "./routes/share-inspect.tsx";
import { SessionsRoute } from "./routes/sessions.tsx";
import { SessionsCompareRoute } from "./routes/sessions-compare.tsx";
import { EpisodeRoute } from "./routes/episode.tsx";
import { ProjectRoute } from "./routes/project.tsx";
import { RecallRoute } from "./routes/recall.tsx";
import { SkillGraphRoute } from "./routes/skill-graph.tsx";
import { GraphRoute } from "./routes/graph.tsx";
import { CanvasRoute } from "./routes/canvas.tsx";
import type { GraphExplorerMode } from "@ax/lib/shared/dashboard-types";
import { WrappedRoute } from "./routes/wrapped.tsx";
import { ImproveRoute } from "./routes/improve.tsx";
import { IngestLiveRoute } from "./routes/ingest-live.tsx";
import { NarrationPanel } from "./routes/narration-panel.tsx";
import { sampleNarration } from "./routes/narration-sample.ts";
import { ShareInspectView } from "./routes/share-inspect.tsx";

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
    component: StudioIndexRoute,
    validateSearch: (search): { shareOwner?: string; gistId?: string; sub?: string } => ({
        shareOwner: typeof search.shareOwner === "string" ? search.shareOwner : undefined,
        gistId: typeof search.gistId === "string" ? search.gistId : undefined,
        sub: typeof search.sub === "string" ? search.sub : undefined,
    }),
});

function StudioIndexRoute() {
    const search = indexRoute.useSearch();
    if (search.shareOwner && search.gistId) {
        return <ShareInspectView owner={search.shareOwner} gistId={search.gistId} />;
    }
    return <SkillsRoute />;
}

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

const sessionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/sessions",
    component: SessionsRoute,
});

// Static segment - must out-prioritize /sessions/$sessionId below.
const sessionsCompareRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/sessions/compare",
    component: SessionsCompareRoute,
    validateSearch: (search): { ids?: string; turns?: boolean } => ({
        ids: typeof search.ids === "string" ? search.ids : undefined,
        turns: search.turns === true || search.turns === "1" || search.turns === "true",
    }),
});

const sessionRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/sessions/$sessionId",
    component: SessionRoute,
});

const sessionInspectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/sessions/$sessionId/inspect",
    component: SessionInspectRoute,
});

const shareInspectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/share/$owner/$gistId",
    component: ShareInspectRoute,
    validateSearch: (search): { sub?: string } => ({
        sub: typeof search.sub === "string" ? search.sub : undefined,
    }),
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

const canvasRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/canvas",
    component: CanvasRoute,
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

const improveRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/improve",
    component: ImproveRoute,
});

const ingestLiveRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/ingest-live",
    component: IngestLiveRoute,
});

/** Prototype showcase for the session-narration artifact (sample data). */
const narrationDemoRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/narration-demo",
    component: NarrationDemoRoute,
});

function NarrationDemoRoute() {
    return (
        <section className="panel">
            <header>
                <h2>Session narration (prototype)</h2>
                <span className="meta">sample artifact · schema v1</span>
            </header>
            <NarrationPanel narration={sampleNarration} onJumpToTurn={() => {}} />
        </section>
    );
}

const routeTree = rootRoute.addChildren([
    indexRoute,
    skillsRoute,
    decisionsRoute,
    toolsRoute,
    workflowRoute,
    sessionsRoute,
    sessionsCompareRoute,
    sessionRoute,
    sessionInspectRoute,
    shareInspectRoute,
    episodeRoute,
    projectRoute,
    skillGraphRoute,
    graphRoute,
    canvasRoute,
    recallRoute,
    wrappedRoute,
    improveRoute,
    ingestLiveRoute,
    narrationDemoRoute,
]);

// Studio build serves at /studio/; mount router under that basepath so
// `/studio/` resolves to the index route. Production `axctl serve` keeps
// basepath = "" (root mount).
const STUDIO_BASEPATH = import.meta.env.VITE_STUDIO_MOCK === "true" ? "/studio" : "";

export const router = createRouter({ routeTree, basepath: STUDIO_BASEPATH });

declare module "@tanstack/react-router" {
    interface Register {
        router: typeof router;
    }
}
