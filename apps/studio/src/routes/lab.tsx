import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../api.ts";

/**
 * Lab - hidden power-user area (footer link, no nav tab).
 * Hosts the experimental/exploratory surfaces that earned demotion from the
 * top nav. (The SQL console that used to live here read a live daemon over
 * POST /api/query; studio is ephemeral now - it opens a published snapshot
 * and exits when the last client disconnects, so there is no daemon left to
 * hold an ad-hoc query console open against. Retired rather than reworked.)
 *
 * Graph explorer is gated server-side behind AX_ENABLE_GRAPH_EXPLORER=1
 * (`/api/graph-explorer` answers 404 `graph_explorer_disabled` otherwise -
 * see dashboard/router/routes/insights.ts). The link used to render
 * unconditionally regardless of that flag, so most visitors clicked into a
 * dead end (#834) - the daemon's `/api/version` capability list is the
 * single source of truth for whether the flag is on, so gate on it here too.
 */
export function LabRoute() {
    // Cache the capability probe so repeat visits share the same version read.
    const version = useQuery({
        queryKey: ["daemon-version"],
        queryFn: () => api.version(),
        staleTime: 60_000,
        retry: false,
    });
    const graphExplorerEnabled = version.data?.capabilities.includes("graph-explorer") ?? false;

    return (
        <section className="panel">
            <header>
                <h2>Lab</h2>
                <span className="meta">experimental surfaces · not the day-to-day dashboard</span>
            </header>

            <div className="actions" style={{ display: "flex", gap: 8, margin: "12px 0 20px" }}>
                <Link to="/canvas" className="badge review" style={{ textDecoration: "none" }}>
                    Session canvas →
                </Link>
                {graphExplorerEnabled ? (
                    <Link to="/graph" className="badge review" style={{ textDecoration: "none" }}>
                        Graph explorer →
                    </Link>
                ) : (
                    <span
                        className="badge review"
                        style={{ opacity: 0.5, cursor: "not-allowed" }}
                        title="Disabled - set AX_ENABLE_GRAPH_EXPLORER=1 on the daemon to enable this experimental endpoint."
                    >
                        Graph explorer (disabled) →
                    </span>
                )}
                <Link to="/lab/sigils" className="badge review" style={{ textDecoration: "none" }}>
                    Archetype sigils →
                </Link>
            </div>
        </section>
    );
}
