/**
 * API version contract. Bump api_version when removing or renaming
 * endpoints / fields (breaking change). Adding endpoints / optional
 * fields is forward-compatible - keep api_version, append to capabilities.
 *
 * The hosted studio at ax.necmttn.com reads this and uses it to:
 *   - display the connected daemon's version in the banner
 *   - feature-gate UI for missing capabilities
 *   - nag the user to `axctl update` when their daemon is behind
 */
export const API_VERSION = 1;
export const isGraphExplorerEnabled = (
    env: Record<string, string | undefined> = process.env,
): boolean => env.AX_ENABLE_GRAPH_EXPLORER === "1";

export const baseApiCapabilities = [
    "skills",      // /api/skills + decide/detail/source/open
    "decisions",   // /api/decisions
    "workflow",    // /api/workflow
    "sessions",    // /api/sessions + detail/children/inspect
    "episodes",    // /api/episodes/:parentId
    "projects",    // /api/projects/:slug
    "skill-graph", // /api/skill-graph
    "recall",      // /api/recall
    "tools",       // /api/tool-failures
    "wrapped",     // /api/wrapped + public-preview
    "improve",     // /api/improve + accept/reject/verdict
    "next-actions", // /api/next-actions ranked action cards + agent briefs
    "improve-analyze", // GET /api/improve/analyze-brief - deep-analysis brief for agents
    "wrapped-generate", // GET /api/wrapped/generate-brief + agent card deck on /api/wrapped
    "improve-impact", // GET /api/improve/:sig/impact - projected impact per proposal
    "events",      // /api/events (SSE)
    "ingest",      // POST /api/ingest -> { runId, stream } + Durable Streams sidecar
    "image",       // GET /api/image?path= -> local on-disk image bytes
    "otlp",        // POST /v1/traces|/v1/metrics|/v1/logs OTLP/JSON receiver
] as const;

export const dashboardApiCapabilities = (
    env: Record<string, string | undefined> = process.env,
): ReadonlyArray<string> =>
    isGraphExplorerEnabled(env)
        ? [...baseApiCapabilities, "graph-explorer"]
        : baseApiCapabilities;
