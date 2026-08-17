import { Link } from "@tanstack/react-router";

/**
 * Lab - hidden power-user area (footer link, no nav tab).
 * Hosts the experimental/exploratory surfaces that earned demotion from the
 * top nav. (The SQL console that used to live here read a live daemon over
 * POST /api/query; studio is ephemeral now - it opens a published snapshot
 * and exits when the last client disconnects, so there is no daemon left to
 * hold an ad-hoc query console open against. Retired rather than reworked.)
 */
export function LabRoute() {
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
                <Link to="/graph" className="badge review" style={{ textDecoration: "none" }}>
                    Graph explorer →
                </Link>
                <Link to="/lab/sigils" className="badge review" style={{ textDecoration: "none" }}>
                    Archetype sigils →
                </Link>
            </div>
        </section>
    );
}
