/**
 * Cost analytics route: spend split, dispatch candidates, main-thread
 * routability lens, and interactive routing-class tuner.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.ts";
import { SplitBar, BarRow } from "../components/cost-bars.tsx";
import { RoutingTuner } from "../components/routing-tuner.tsx";

// ---------------------------------------------------------------------------
// Local cast shapes (api methods return unknown - narrow here)
// ---------------------------------------------------------------------------

interface CostSplitRow {
    origin: "main" | "subagent";
    model: string;
    sessions: number;
    cost_usd: number;
    share_pct: number;
}
interface CostSplitResult {
    rows: CostSplitRow[];
    totals: { cost_usd: number; sessions: number };
}

interface CandidateRow {
    ts: string;
    description: string | null;
    agent_type: string | null;
    dispatch_model: string;
    child_model: string | null;
    child_cost_usd: number;
    routing_match: { classId: string; suggest: string };
    suggested_model: string;
    est_savings_usd: number;
}
interface CandidatesResult {
    candidates: CandidateRow[];
    total_est_savings_usd: number;
    top_classes: Array<{ classId: string; savings_usd: number }>;
}

interface RoutabilityClassRow {
    class: string;
    verdict: "routable" | "stays";
    runs: number;
    turns: number;
    mainCostUsd: number;
    tier: string | null;
    repricedUsd: number | null;
    estSavingsUsd: number | null;
}
interface RoutabilityResult {
    mainSpendUsd: number;
    routableUsd: number;
    routablePct: number;
    estSavingsUsd: number;
    rows: RoutabilityClassRow[];
    days: number;
    minRun: number;
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

const fmt = (n: number) =>
  n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const pct = (n: number) => `${n.toFixed(1)}%`;

// ---------------------------------------------------------------------------
// Section helpers
// ---------------------------------------------------------------------------

function SectionHead({ title, meta }: { title: string; meta?: string }) {
    return (
        <h3 style={{ margin: "20px 0 8px", fontSize: "0.85em", textTransform: "uppercase", letterSpacing: "0.05em", display: "flex", alignItems: "baseline", gap: 8 }}>
            {title}{meta && <span style={{ fontWeight: 400, opacity: 0.5, textTransform: "none", fontSize: "0.9em" }}>{meta}</span>}
        </h3>
    );
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export function CostRoute() {
    // --- 1. Spend split ---
    const splitQ = useQuery({
        queryKey: ["cost-split"],
        queryFn: () => api.costSplit(30),
    });
    const split = splitQ.data as CostSplitResult | undefined;

    // --- 2. Dispatch candidates ---
    const dispQ = useQuery({
        queryKey: ["cost-dispatches-cand"],
        queryFn: () => api.costDispatches(30, true),
    });
    const candidates = dispQ.data as CandidatesResult | undefined;

    // --- 3. Routability ---
    const routabilityQ = useQuery({
        queryKey: ["cost-routability"],
        queryFn: () => api.costRoutability(30, 1),
    });
    const routability = routabilityQ.data as RoutabilityResult | undefined;

    // Derived split values
    const mainCost = split?.rows.filter((r) => r.origin === "main").reduce((s, r) => s + r.cost_usd, 0) ?? 0;
    const subCost = split?.rows.filter((r) => r.origin === "subagent").reduce((s, r) => s + r.cost_usd, 0) ?? 0;
    const totalCost = (mainCost + subCost) || 1;
    const subagentRows = split?.rows.filter((r) => r.origin === "subagent") ?? [];
    const maxSubCost = Math.max(...subagentRows.map((r) => r.cost_usd), 1);

    return (
        <section className="panel">
            <header>
                <h2>Cost</h2>
                <span className="meta">30d window</span>
            </header>

            {/* ======================================================== */}
            {/* Section 1: Spend split                                    */}
            {/* ======================================================== */}
            <SectionHead title="Spend split" />

            {splitQ.isLoading && <p style={{ opacity: 0.5, fontSize: 13 }}>Loading…</p>}
            {splitQ.error && (
                <p style={{ color: "var(--red, #bd443b)", fontSize: 13 }}>
                    {splitQ.error instanceof Error ? splitQ.error.message : "Failed to load"}
                </p>
            )}
            {split && !splitQ.isLoading && (
                <>
                    <SplitBar segs={[
                        { label: "main", value: mainCost, color: "var(--blue, #2567a8)" },
                        { label: "subagent", value: subCost, color: "var(--rose, #b32650)" },
                    ]} />
                    <div style={{ display: "flex", gap: 28, margin: "8px 0 14px", flexWrap: "wrap" }}>
                        <div>
                            <div style={{ fontSize: "1.3em", fontWeight: 600 }}>{fmt(mainCost)}</div>
                            <div className="meta">main ({pct(100 * mainCost / totalCost)})</div>
                        </div>
                        <div>
                            <div style={{ fontSize: "1.3em", fontWeight: 600 }}>{fmt(subCost)}</div>
                            <div className="meta">subagent ({pct(100 * subCost / totalCost)})</div>
                        </div>
                        <div>
                            <div style={{ fontSize: "1.3em", fontWeight: 600 }}>{fmt(split.totals.cost_usd)}</div>
                            <div className="meta">total · {split.totals.sessions} sessions</div>
                        </div>
                    </div>
                    {subagentRows.length > 0 && (
                        <>
                            <div style={{ fontSize: "0.8em", opacity: 0.6, marginBottom: 4 }}>Subagent by model</div>
                            {subagentRows.map((r) => (
                                <BarRow key={r.model}
                                    label={r.model}
                                    value={r.cost_usd}
                                    max={maxSubCost}
                                    sub={`${fmt(r.cost_usd)} · ${r.sessions} sessions`}
                                    color="var(--rose, #b32650)" />
                            ))}
                        </>
                    )}
                    {split.rows.length === 0 && (
                        <p style={{ opacity: 0.5, fontSize: 13 }}>No cost data in the 30-day window.</p>
                    )}
                </>
            )}

            {/* ======================================================== */}
            {/* Section 2: Dispatch candidates                            */}
            {/* ======================================================== */}
            <SectionHead title="Dispatch candidates" meta="inherit + expensive + routable class" />

            {dispQ.isLoading && <p style={{ opacity: 0.5, fontSize: 13 }}>Loading…</p>}
            {dispQ.error && (
                <p style={{ color: "var(--red, #bd443b)", fontSize: 13 }}>
                    {dispQ.error instanceof Error ? dispQ.error.message : "Failed to load"}
                </p>
            )}
            {candidates && !dispQ.isLoading && (
                candidates.candidates.length === 0
                    ? <p style={{ opacity: 0.5, fontSize: 13 }}>No routable dispatch candidates in window.</p>
                    : (
                        <>
                            <div style={{ display: "flex", gap: 24, margin: "4px 0 10px", fontSize: 13, flexWrap: "wrap" }}>
                                <div><strong>{candidates.candidates.length}</strong> candidates</div>
                                <div style={{ color: "var(--green, #16845e)" }}>
                                    est. <strong>{fmt(candidates.total_est_savings_usd)}</strong> savings
                                </div>
                            </div>
                            {candidates.top_classes.length > 0 && (
                                <div style={{ marginBottom: 8, fontSize: 12, opacity: 0.7 }}>
                                    Top classes: {candidates.top_classes.map((c) => `${c.classId} (${fmt(c.savings_usd)})`).join(" · ")}
                                </div>
                            )}
                            <div style={{ overflowX: "auto" }}>
                                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                                    <thead>
                                        <tr>
                                            {["description", "child model", "suggested", "cost", "est. savings"].map((h) => (
                                                <th key={h} style={{ textAlign: "left", padding: "2px 8px 2px 0", opacity: 0.6, fontWeight: 500 }}>{h}</th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {candidates.candidates.slice(0, 15).map((c, i) => (
                                            <tr key={i}>
                                                <td style={{ padding: "3px 8px 3px 0", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                                    {c.description ?? c.agent_type ?? "-"}
                                                </td>
                                                <td style={{ padding: "3px 8px 3px 0", fontFamily: "monospace", fontSize: 11 }}>{c.child_model ?? "?"}</td>
                                                <td style={{ padding: "3px 8px 3px 0", color: "var(--blue, #2567a8)" }}>{c.suggested_model}</td>
                                                <td style={{ padding: "3px 8px 3px 0" }}>{fmt(c.child_cost_usd)}</td>
                                                <td style={{ padding: "3px 0", color: "var(--green, #16845e)" }}>{fmt(c.est_savings_usd)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                                {candidates.candidates.length > 15 && (
                                    <p style={{ fontSize: 12, opacity: 0.5, margin: "4px 0 0" }}>…and {candidates.candidates.length - 15} more</p>
                                )}
                            </div>
                        </>
                    )
            )}

            {/* ======================================================== */}
            {/* Section 3: Main-thread routability                        */}
            {/* ======================================================== */}
            <SectionHead title="Main-thread routability" meta="Claude main-agent cost only" />

            {routabilityQ.isLoading && <p style={{ opacity: 0.5, fontSize: 13 }}>Loading…</p>}
            {routabilityQ.error && (
                <p style={{ color: "var(--red, #bd443b)", fontSize: 13 }}>
                    {routabilityQ.error instanceof Error ? routabilityQ.error.message : "Failed to load"}
                </p>
            )}
            {routability && !routabilityQ.isLoading && (
                routability.mainSpendUsd === 0
                    ? <p style={{ opacity: 0.5, fontSize: 13 }}>No Claude main-agent spend in window.</p>
                    : (
                        <>
                            <div style={{ display: "flex", gap: 28, margin: "4px 0 10px", flexWrap: "wrap" }}>
                                <div>
                                    <div style={{ fontSize: "1.3em", fontWeight: 600 }}>{pct(routability.routablePct)}</div>
                                    <div className="meta">routable</div>
                                </div>
                                <div>
                                    <div style={{ fontSize: "1.3em", fontWeight: 600, color: "var(--green, #16845e)" }}>{fmt(routability.estSavingsUsd)}</div>
                                    <div className="meta">est. savings</div>
                                </div>
                                <div>
                                    <div style={{ fontSize: "1.3em", fontWeight: 600 }}>{fmt(routability.mainSpendUsd)}</div>
                                    <div className="meta">main spend ({routability.days}d)</div>
                                </div>
                            </div>
                            <SplitBar segs={[
                                { label: "routable", value: routability.routableUsd, color: "var(--gold, #a66d10)" },
                                { label: "stays main", value: routability.mainSpendUsd - routability.routableUsd, color: "var(--blue, #2567a8)" },
                            ]} />
                            {routability.rows.length > 0 && (
                                <div style={{ overflowX: "auto", marginTop: 8 }}>
                                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                                        <thead>
                                            <tr>
                                                {["class", "verdict", "runs", "turns", "main cost", "tier", "est. savings"].map((h) => (
                                                    <th key={h} style={{ textAlign: "left", padding: "2px 8px 2px 0", opacity: 0.6, fontWeight: 500 }}>{h}</th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {routability.rows.map((r) => (
                                                <tr key={r.class}>
                                                    <td style={{ padding: "3px 8px 3px 0", fontFamily: "monospace" }}>{r.class}</td>
                                                    <td style={{ padding: "3px 8px 3px 0", color: r.verdict === "routable" ? "var(--gold, #a66d10)" : "var(--muted, #66706b)" }}>{r.verdict}</td>
                                                    <td style={{ padding: "3px 8px 3px 0" }}>{r.runs}</td>
                                                    <td style={{ padding: "3px 8px 3px 0" }}>{r.turns}</td>
                                                    <td style={{ padding: "3px 8px 3px 0" }}>{fmt(r.mainCostUsd)}</td>
                                                    <td style={{ padding: "3px 8px 3px 0", color: "var(--blue, #2567a8)" }}>{r.tier ?? "-"}</td>
                                                    <td style={{ padding: "3px 0", color: "var(--green, #16845e)" }}>
                                                        {r.estSavingsUsd != null ? fmt(r.estSavingsUsd) : "-"}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </>
                    )
            )}

            {/* ======================================================== */}
            {/* Section 4: Routing tuner (interactive)                   */}
            {/* ======================================================== */}
            <RoutingTuner />
        </section>
    );
}
