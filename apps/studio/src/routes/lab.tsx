import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { api } from "../api.ts";

/**
 * Lab - hidden power-user area (footer link, no nav tab).
 * Hosts the experimental/exploratory surfaces that earned demotion from the
 * top nav, plus a read-only SQL console over POST /api/query.
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

            <SqlConsole />
        </section>
    );
}

function SqlConsole() {
    const [sql, setSql] = useState("SELECT count() FROM session GROUP ALL;");
    const [output, setOutput] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [durationMs, setDurationMs] = useState<number | null>(null);

    const run = async () => {
        setBusy(true);
        setError(null);
        try {
            const res = await api.query(sql);
            setOutput(JSON.stringify(res.result, null, 2));
            setDurationMs(res.durationMs);
        } catch (err) {
            setOutput(null);
            setDurationMs(null);
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div>
            <header>
                <h3 style={{ margin: "0 0 4px" }}>SQL console</h3>
                <span className="meta">
                    read-only - the daemon accepts SELECT, RETURN, and INFO statements
                </span>
            </header>
            <textarea
                value={sql}
                onChange={(e) => setSql(e.target.value)}
                rows={4}
                spellCheck={false}
                style={{ width: "100%", fontFamily: "monospace", margin: "8px 0" }}
                aria-label="SurrealQL query"
            />
            <div className="actions" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button type="button" className="badge keep" onClick={() => void run()} disabled={busy}>
                    {busy ? "Running…" : "Run"}
                </button>
                {durationMs !== null ? <span className="meta">{durationMs}ms</span> : null}
            </div>
            {error ? <div className="error">Error: {error}</div> : null}
            {output !== null ? (
                <pre style={{ overflow: "auto", maxHeight: 480, marginTop: 12 }}>{output}</pre>
            ) : null}
        </div>
    );
}
