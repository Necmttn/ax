/**
 * Interactive routing-class tuner: browse existing classes, author new ones,
 * debounced live backtest against dispatch history, save/remove via the
 * routing write API (gated to live daemon connections).
 */
import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, studioConnection } from "../api.ts";

// ---------------------------------------------------------------------------
// Local shapes (api methods return unknown - cast here)
// ---------------------------------------------------------------------------

interface RoutingClass {
    id: string;
    pattern: string;
    flags?: string;
    suggest: string;
    reason: string;
    origin?: string;
    exclude?: string[];
}

interface StoredRoutingTable {
    version: number;
    classes: RoutingClass[];
    agentTypes?: Record<string, string>;
}

interface BacktestRow {
    description: string | null;
    childModel: string | null;
    costUsd: number;
    estSavingsUsd: number;
}

interface BacktestResult {
    matched: BacktestRow[];
    excluded: BacktestRow[];
    missed: BacktestRow[];
    estSavingsUsd: number;
    matchedCount: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RoutingTuner() {
    const isLive = studioConnection.isLive();
    const queryClient = useQueryClient();

    const { data: tableRaw, isLoading: tableLoading } = useQuery({
        queryKey: ["routing-table"],
        queryFn: () => api.routingTable(),
    });
    const table = tableRaw as StoredRoutingTable | null | undefined;

    // Form state
    const [pattern, setPattern] = useState("");
    const [flags, setFlags] = useState("i");
    const [suggest, setSuggest] = useState("sonnet");
    const [excludeStr, setExcludeStr] = useState("");
    const [days, setDays] = useState(30);
    const [customId, setCustomId] = useState("");
    const [reason, setReason] = useState("");

    // Selected row for edit
    const [selectedId, setSelectedId] = useState<string | null>(null);

    // Backtest state
    const [backtestResult, setBacktestResult] = useState<BacktestResult | null>(null);
    const [backtestLoading, setBacktestLoading] = useState(false);

    // Action status
    const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
    const [removeStatus, setRemoveStatus] = useState<"idle" | "removing" | "done" | "error">("idle");

    const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Debounced live backtest
    useEffect(() => {
        if (!pattern.trim()) { setBacktestResult(null); return; }
        if (debounceTimer.current) clearTimeout(debounceTimer.current);
        debounceTimer.current = setTimeout(() => {
            setBacktestLoading(true);
            const body: Parameters<typeof api.routingBacktest>[0] = { pattern, suggest, days };
            if (flags.trim()) body.flags = flags;
            if (excludeStr.trim()) body.exclude = excludeStr.split(",").map((s) => s.trim()).filter(Boolean);
            api.routingBacktest(body)
                .then((res) => { setBacktestResult(res as BacktestResult); })
                .catch(() => { setBacktestResult(null); })
                .finally(() => { setBacktestLoading(false); });
        }, 600);
        return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current); };
    }, [pattern, flags, suggest, excludeStr, days]);

    // Load selected class into form
    useEffect(() => {
        if (!selectedId || !table) return;
        const cls = table.classes.find((c) => c.id === selectedId);
        if (!cls) return;
        setPattern(cls.pattern);
        setFlags(cls.flags ?? "i");
        setSuggest(cls.suggest);
        setExcludeStr((cls.exclude ?? []).join(", "));
        setCustomId(cls.id);
        setReason(cls.reason ?? "");
    }, [selectedId, table]);

    const handleSave = () => {
        if (!pattern.trim() || !isLive) return;
        setSaveStatus("saving");
        const body: Parameters<typeof api.routingUpsertClass>[0] = {
            id: customId.trim() || selectedId || `custom-${Date.now()}`,
            pattern,
            suggest,
        };
        if (flags.trim()) body.flags = flags;
        if (reason.trim()) body.reason = reason;
        if (excludeStr.trim()) body.exclude = excludeStr.split(",").map((s) => s.trim()).filter(Boolean);
        api.routingUpsertClass(body)
            .then(() => {
                void queryClient.invalidateQueries({ queryKey: ["routing-table"] });
                setSaveStatus("saved");
                setTimeout(() => setSaveStatus("idle"), 2000);
            })
            .catch(() => { setSaveStatus("error"); setTimeout(() => setSaveStatus("idle"), 2000); });
    };

    const handleRemove = (id: string) => {
        if (!isLive) return;
        setRemoveStatus("removing");
        api.routingRemoveClass(id)
            .then(() => {
                void queryClient.invalidateQueries({ queryKey: ["routing-table"] });
                if (selectedId === id) { setSelectedId(null); setPattern(""); setCustomId(""); }
                setRemoveStatus("done");
                setTimeout(() => setRemoveStatus("idle"), 1500);
            })
            .catch(() => { setRemoveStatus("error"); setTimeout(() => setRemoveStatus("idle"), 1500); });
    };

    const inputStyle: React.CSSProperties = {
        padding: "4px 8px", fontSize: 13,
        border: "1px solid var(--line, #cfd8d4)", borderRadius: 3,
        background: "var(--panel, #fff)", color: "inherit",
    };

    return (
        <div>
            <h3 style={{ margin: "20px 0 8px", fontSize: "0.85em", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Routing tuner{!isLive && (
                    <span style={{ opacity: 0.5, fontWeight: 400, textTransform: "none", marginLeft: 8 }}>
                        (connect to a live daemon to save)
                    </span>
                )}
            </h3>

            {/* Existing classes table */}
            {tableLoading
                ? <p style={{ opacity: 0.5, fontSize: 13 }}>Loading routing table…</p>
                : table?.classes && table.classes.length > 0
                    ? (
                        <div style={{ marginBottom: 12, overflowX: "auto" }}>
                            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                                <thead>
                                    <tr>
                                        {["id", "pattern", "suggest", "origin"].map((h) => (
                                            <th key={h} style={{ textAlign: "left", padding: "2px 8px 2px 0", opacity: 0.6, fontWeight: 500 }}>{h}</th>
                                        ))}
                                        {isLive && <th />}
                                    </tr>
                                </thead>
                                <tbody>
                                    {table.classes.map((cls) => (
                                        <tr key={cls.id}
                                            onClick={() => setSelectedId(selectedId === cls.id ? null : cls.id)}
                                            style={{
                                                cursor: "pointer",
                                                background: selectedId === cls.id ? "var(--track, #e4ebe8)" : "transparent",
                                            }}>
                                            <td style={{ padding: "3px 8px 3px 0", fontFamily: "monospace", fontSize: 11 }}>{cls.id}</td>
                                            <td style={{ padding: "3px 8px 3px 0", fontFamily: "monospace", fontSize: 11, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cls.pattern}</td>
                                            <td style={{ padding: "3px 8px 3px 0", color: "var(--blue, #2567a8)" }}>{cls.suggest}</td>
                                            <td style={{ padding: "3px 8px 3px 0", opacity: 0.5, fontSize: 11 }}>{cls.origin ?? "default"}</td>
                                            {isLive && (
                                                <td style={{ padding: "3px 0" }}>
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); handleRemove(cls.id); }}
                                                        style={{ ...inputStyle, padding: "1px 6px", cursor: "pointer", background: "transparent" }}>
                                                        {removeStatus === "removing" ? "…" : "✕"}
                                                    </button>
                                                </td>
                                            )}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )
                    : <p style={{ opacity: 0.5, fontSize: 13 }}>No routing table loaded.</p>
            }

            {/* Pattern editor */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 60px 120px", gap: 8, marginBottom: 8 }}>
                <div>
                    <label style={{ fontSize: 12, opacity: 0.6, display: "block", marginBottom: 2 }}>Pattern (regex)</label>
                    <input value={pattern} onChange={(e) => setPattern(e.target.value)}
                        placeholder="e.g. summarize|translate"
                        style={{ ...inputStyle, width: "100%" }} />
                </div>
                <div>
                    <label style={{ fontSize: 12, opacity: 0.6, display: "block", marginBottom: 2 }}>Flags</label>
                    <input value={flags} onChange={(e) => setFlags(e.target.value)}
                        placeholder="i"
                        style={{ ...inputStyle, width: "100%" }} />
                </div>
                <div>
                    <label style={{ fontSize: 12, opacity: 0.6, display: "block", marginBottom: 2 }}>Suggest model</label>
                    <select value={suggest} onChange={(e) => setSuggest(e.target.value)}
                        style={{ ...inputStyle, width: "100%" }}>
                        <option value="haiku">haiku</option>
                        <option value="sonnet">sonnet</option>
                    </select>
                </div>
            </div>

            <div style={{ marginBottom: 8 }}>
                <label style={{ fontSize: 12, opacity: 0.6, display: "block", marginBottom: 2 }}>Exclude patterns (comma-separated)</label>
                <input value={excludeStr} onChange={(e) => setExcludeStr(e.target.value)}
                    placeholder="e.g. review, audit"
                    style={{ ...inputStyle, width: "100%" }} />
            </div>

            <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 10 }}>
                <div>
                    <label style={{ fontSize: 12, opacity: 0.6, display: "block", marginBottom: 2 }}>Days</label>
                    <input type="number" value={days} onChange={(e) => setDays(Number(e.target.value))}
                        style={{ ...inputStyle, width: 64 }} />
                </div>
                {isLive && (
                    <>
                        <div style={{ flex: 1 }}>
                            <label style={{ fontSize: 12, opacity: 0.6, display: "block", marginBottom: 2 }}>ID</label>
                            <input value={customId} onChange={(e) => setCustomId(e.target.value)}
                                placeholder="class-id"
                                style={{ ...inputStyle, width: "100%" }} />
                        </div>
                        <div style={{ flex: 2 }}>
                            <label style={{ fontSize: 12, opacity: 0.6, display: "block", marginBottom: 2 }}>Reason</label>
                            <input value={reason} onChange={(e) => setReason(e.target.value)}
                                placeholder="optional reason"
                                style={{ ...inputStyle, width: "100%" }} />
                        </div>
                    </>
                )}
            </div>

            {/* Backtest results */}
            {backtestLoading && <p style={{ opacity: 0.5, fontSize: 13 }}>Running backtest…</p>}
            {backtestResult && !backtestLoading && (
                <div style={{ marginBottom: 12, fontSize: 13 }}>
                    <div style={{ display: "flex", gap: 16, marginBottom: 6, flexWrap: "wrap" }}>
                        <span><strong>{backtestResult.matchedCount}</strong> matched</span>
                        <span><strong>{backtestResult.excluded.length}</strong> excluded</span>
                        <span><strong>{backtestResult.missed.length}</strong> missed (expensive inherit)</span>
                        <span style={{ color: "var(--green, #16845e)" }}>
                            est. <strong>${backtestResult.estSavingsUsd.toFixed(4)}</strong> savings
                        </span>
                    </div>
                    {backtestResult.matched.length > 0 && (
                        <details style={{ marginBottom: 4 }}>
                            <summary style={{ cursor: "pointer", opacity: 0.7, fontSize: 12 }}>
                                Matched ({backtestResult.matched.length})
                            </summary>
                            <div style={{ paddingLeft: 12, maxHeight: 140, overflowY: "auto" }}>
                                {backtestResult.matched.slice(0, 20).map((r, i) => (
                                    <div key={i} style={{ fontSize: 12, padding: "2px 0", opacity: 0.8, fontFamily: "monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                        {r.description ?? "(no description)"}
                                        <span style={{ color: "var(--green, #16845e)", marginLeft: 8 }}>
                                            −${r.estSavingsUsd.toFixed(4)}
                                        </span>
                                    </div>
                                ))}
                                {backtestResult.matched.length > 20 && (
                                    <div style={{ fontSize: 11, opacity: 0.5 }}>…and {backtestResult.matched.length - 20} more</div>
                                )}
                            </div>
                        </details>
                    )}
                    {backtestResult.excluded.length > 0 && (
                        <details style={{ marginBottom: 4 }}>
                            <summary style={{ cursor: "pointer", opacity: 0.7, fontSize: 12 }}>
                                Excluded ({backtestResult.excluded.length})
                            </summary>
                            <div style={{ paddingLeft: 12, maxHeight: 100, overflowY: "auto" }}>
                                {backtestResult.excluded.slice(0, 10).map((r, i) => (
                                    <div key={i} style={{ fontSize: 12, padding: "2px 0", opacity: 0.6, fontFamily: "monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                        {r.description ?? "(no description)"}
                                    </div>
                                ))}
                            </div>
                        </details>
                    )}
                    {backtestResult.missed.length > 0 && (
                        <details>
                            <summary style={{ cursor: "pointer", opacity: 0.7, fontSize: 12 }}>
                                Missed - expensive inherits pattern did not catch ({backtestResult.missed.length})
                            </summary>
                            <div style={{ paddingLeft: 12, maxHeight: 100, overflowY: "auto" }}>
                                {backtestResult.missed.slice(0, 10).map((r, i) => (
                                    <div key={i} style={{ fontSize: 12, padding: "2px 0", opacity: 0.6, fontFamily: "monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                        {r.description ?? "(no description)"}
                                        {r.childModel && <span style={{ opacity: 0.5, marginLeft: 6 }}>({r.childModel})</span>}
                                    </div>
                                ))}
                            </div>
                        </details>
                    )}
                </div>
            )}

            {/* Save / label */}
            {isLive && (
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <button onClick={handleSave}
                        disabled={!pattern.trim() || saveStatus === "saving"}
                        style={{
                            padding: "5px 14px", fontSize: 13, cursor: "pointer",
                            background: "var(--green, #16845e)", color: "#fff",
                            border: "none", borderRadius: 4, opacity: !pattern.trim() ? 0.5 : 1,
                        }}>
                        {saveStatus === "saving" ? "Saving…" : saveStatus === "saved" ? "Saved ✓" : saveStatus === "error" ? "Error" : "Save class"}
                    </button>
                    {selectedId && (
                        <span style={{ fontSize: 12, opacity: 0.6 }}>editing: {selectedId}</span>
                    )}
                </div>
            )}
        </div>
    );
}
