/**
 * Utilization panel - minimal view of GET /api/usage.
 * Shows: active days, total invocations, top commands, origin split, never-used commands.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.ts";
import type { UsageRollupSchema } from "@ax/lib/shared/api-contract";

type TopCommand = UsageRollupSchema["topCommands"][number];

function CommandTable({ commands }: { readonly commands: readonly TopCommand[] }) {
    if (commands.length === 0) return <p className="meta">No invocations in this window</p>;
    return (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9em" }}>
            <tbody>
                {commands.map((cmd) => (
                    <tr key={cmd.command}>
                        <td style={{ padding: "3px 8px 3px 0", fontFamily: "monospace" }}>
                            ax {cmd.command}
                        </td>
                        <td style={{ padding: "3px 8px", color: "var(--muted)" }}>
                            {cmd.count}×
                        </td>
                        <td style={{ padding: "3px 0", color: "var(--muted)", fontSize: "0.85em" }}>
                            last {new Date(cmd.last_used).toLocaleDateString()}
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

export function UsageRoute() {
    const { data, isLoading, error } = useQuery({
        queryKey: ["usage"],
        queryFn: () => api.usage(),
    });

    if (isLoading) return <section className="panel"><p>Loading…</p></section>;
    if (error || !data) {
        return (
            <section className="panel">
                <header><h2>Utilization</h2></header>
                <p className="meta">{error instanceof Error ? error.message : "Failed to load"}</p>
            </section>
        );
    }

    return (
        <section className="panel">
            <header>
                <h2>Utilization</h2>
                <span className="meta">{data.windowDays}d window</span>
            </header>

            <div style={{ display: "flex", gap: "32px", margin: "8px 0 16px" }}>
                <div>
                    <div style={{ fontSize: "1.6em", fontWeight: 600 }}>{data.activeDays}</div>
                    <div className="meta">active days</div>
                </div>
                <div>
                    <div style={{ fontSize: "1.6em", fontWeight: 600 }}>{data.total}</div>
                    <div className="meta">total invocations</div>
                </div>
                <div>
                    <div style={{ fontSize: "1.6em", fontWeight: 600 }}>
                        {data.originSplit.agent} / {data.originSplit.tty}
                    </div>
                    <div className="meta">agent / tty</div>
                </div>
            </div>

            {data.topCommands.length > 0 && (
                <>
                    <h3 style={{ margin: "12px 0 6px", fontSize: "0.85em", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                        Top commands
                    </h3>
                    <CommandTable commands={data.topCommands} />
                </>
            )}

            {(data.topCommandsByOrigin.tty.length > 0 || data.topCommandsByOrigin.agent.length > 0) && (
                <>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "18px", marginTop: "14px" }}>
                        <section>
                            <h3 style={{ margin: "0 0 6px", fontSize: "0.85em", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                                Interactive
                            </h3>
                            <CommandTable commands={data.topCommandsByOrigin.tty} />
                        </section>
                        <section>
                            <h3 style={{ margin: "0 0 6px", fontSize: "0.85em", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                                Agent/background
                            </h3>
                            <CommandTable commands={data.topCommandsByOrigin.agent} />
                        </section>
                    </div>
                </>
            )}

            {data.unusedSurface.length > 0 && (
                <>
                    <h3 style={{ margin: "16px 0 6px", fontSize: "0.85em", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                        Never used in this window
                    </h3>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                        {data.unusedSurface.map((cmd) => (
                            <code
                                key={cmd}
                                style={{
                                    padding: "2px 8px",
                                    background: "var(--track)",
                                    borderRadius: "4px",
                                    fontSize: "0.85em",
                                }}
                            >
                                ax {cmd}
                            </code>
                        ))}
                    </div>
                </>
            )}

            {data.reliability.length > 0 && (
                <>
                    <h3 style={{ margin: "16px 0 6px", fontSize: "0.85em", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                        Reliability (commands with failures)
                    </h3>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9em" }}>
                        <tbody>
                            {data.reliability.map((r) => (
                                <tr key={r.command}>
                                    <td style={{ padding: "3px 8px 3px 0", fontFamily: "monospace" }}>
                                        ax {r.command}
                                    </td>
                                    <td style={{ padding: "3px 8px", color: "var(--muted)" }}>
                                        {r.failures}/{r.runs} failed
                                    </td>
                                    <td style={{ padding: "3px 0", color: "var(--muted)", fontSize: "0.85em" }}>
                                        {(r.failureRate * 100).toFixed(0)}%
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </>
            )}
        </section>
    );
}

// Re-export the type for api.ts consumers.
export type { UsageRollupSchema };
