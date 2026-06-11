import type { SessionInsightsPayload } from "@ax/lib/shared/dashboard-types";

const PHASE_COLOR: Record<string, string> = {
    plan: "var(--sx-phase-plan)",
    execute: "var(--sx-phase-exec)",
    exec: "var(--sx-phase-exec)",
    review: "var(--sx-phase-review)",
};

const fmtMs = (ms: number): string =>
    ms < 60_000 ? `${Math.round(ms / 1000)}s`
        : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m`
            : `${(ms / 3_600_000).toFixed(1)}h`;

const timeOf = (ts: string | null): number | null => {
    if (!ts) return null;
    const t = new Date(ts).getTime();
    return Number.isFinite(t) ? t : null;
};

const pctOf = (t: number, t0: number, span: number): number =>
    Math.min(100, Math.max(0, ((t - t0) / span) * 100));

/** Band 1 story strip: phase segments, friction ticks, commit markers, and
 * subagent lanes on one session-time axis. Idle is the uncovered track. */
export function StoryBar({ insights, startedAt, endedAt }: {
    readonly insights: SessionInsightsPayload;
    readonly startedAt: string | null;
    readonly endedAt: string | null;
}) {
    const phaseStarts = insights.phases.map((p) => timeOf(p.start_ts)).filter((t): t is number => t !== null);
    const phaseEnds = insights.phases.map((p) => timeOf(p.end_ts)).filter((t): t is number => t !== null);
    const start = timeOf(startedAt) ?? (phaseStarts.length > 0 ? Math.min(...phaseStarts) : null);
    const end = timeOf(endedAt) ?? (phaseEnds.length > 0 ? Math.max(...phaseEnds) : null);
    if (start === null || end === null || end <= start) return null;

    const span = end - start;
    const pct = (ts: string | null): number | null => {
        const t = timeOf(ts);
        return t === null ? null : pctOf(t, start, span);
    };

    const phaseTotals = new Map<string, number>();
    for (const p of insights.phases) {
        if (Number.isFinite(p.duration_ms) && p.duration_ms > 0) {
            phaseTotals.set(p.phase, (phaseTotals.get(p.phase) ?? 0) + p.duration_ms);
        }
    }
    const covered = Array.from(phaseTotals.values()).reduce((sum, ms) => sum + ms, 0);
    const idleMs = Math.max(0, span - covered);
    const reverted = insights.commits.filter((c) => c.reverted).length;
    const landed = insights.commits.length - reverted;
    const hasLanes = insights.subagent_spans.some((s) => s.started_at !== null);
    const visibleFriction = insights.friction_ticks.slice(0, 18);
    const visibleSubagents = insights.subagent_spans.filter((s) => s.started_at !== null).slice(0, 28);

    return (
        <div style={{ maxWidth: 720, minWidth: 0 }}>
            <div style={{
                fontSize: 9,
                color: "var(--sx-ink-500)",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                fontWeight: 600,
                marginBottom: 6,
            }}>
                Story
            </div>
            <div style={{ position: "relative", width: "100%", height: hasLanes ? 24 : 18 }}>
                <span style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    height: 7,
                    background: "var(--sx-phase-idle)",
                }} />
                {insights.phases.map((p, i) => {
                    const left = pct(p.start_ts);
                    const right = pct(p.end_ts);
                    if (left === null || right === null) return null;
                    return (
                        <span
                            key={`${p.phase}-${i}`}
                            title={`${p.phase} ${fmtMs(p.duration_ms)}`}
                            style={{
                                position: "absolute",
                                top: 0,
                                height: 7,
                                left: `${left}%`,
                                width: `${Math.max(0.5, right - left)}%`,
                                background: PHASE_COLOR[p.phase] ?? "var(--sx-phase-exec)",
                            }}
                        />
                    );
                })}
                {visibleFriction.map((f, i) => {
                    const left = pct(f.ts);
                    if (left === null) return null;
                    return (
                        <span
                            key={`f${i}`}
                            title={f.kind}
                            style={{
                                position: "absolute",
                                top: -2,
                                width: 2,
                                height: 12,
                                left: `${left}%`,
                                background: "var(--sx-red-700)",
                                opacity: 0.82,
                            }}
                        />
                    );
                })}
                {insights.commits.map((c, i) => {
                    const left = pct(c.ts);
                    if (left === null) return null;
                    return c.reverted ? (
                        <span
                            key={`c${i}`}
                            title={`${c.sha} (reverted)`}
                            style={{
                                position: "absolute",
                                top: 8,
                                left: `${left}%`,
                                transform: "translateX(-50%)",
                                color: "var(--sx-red-700)",
                                fontSize: 9,
                                fontWeight: 700,
                                lineHeight: 1,
                            }}
                        >
                            x
                        </span>
                    ) : (
                        <span
                            key={`c${i}`}
                            title={c.sha}
                            style={{
                                position: "absolute",
                                top: 10,
                                width: 6,
                                height: 6,
                                borderRadius: "50%",
                                left: `${left}%`,
                                transform: "translateX(-50%)",
                                background: "var(--sx-green-700)",
                            }}
                        />
                    );
                })}
                {visibleSubagents.map((s, i) => {
                    const left = pct(s.started_at);
                    if (left === null) return null;
                    const right = pct(s.ended_at) ?? 100;
                    return (
                        <span
                            key={`a${i}`}
                            title={s.id}
                            style={{
                                position: "absolute",
                                top: 19,
                                height: 4,
                                borderRadius: 2,
                                left: `${left}%`,
                                width: `${Math.max(1, right - left)}%`,
                                background: "var(--sx-violet-500)",
                                opacity: 0.72,
                            }}
                        />
                    );
                })}
            </div>
            <div style={{
                fontSize: 10,
                color: "var(--sx-ink-500)",
                marginTop: 4,
                lineHeight: 1.35,
                whiteSpace: "normal",
                overflowWrap: "anywhere",
            }}>
                {Array.from(phaseTotals.entries()).slice(0, 3).map(([k, v]) => `${k} ${fmtMs(v)}`).join(" · ")}
                {phaseTotals.size > 3 ? <span style={{ color: "var(--sx-ink-300)" }}> +{phaseTotals.size - 3} more</span> : null}
                {idleMs > 60_000 ? <span style={{ color: "var(--sx-ink-300)" }}> · idle {fmtMs(idleMs)}</span> : null}
                {insights.friction_ticks.length > 0
                    ? <span style={{ color: "var(--sx-red-700)" }}> · x{insights.friction_ticks.length} corrections</span>
                    : null}
                {insights.commits.length > 0
                    ? <span style={{ color: "var(--sx-green-700)" }}> · {landed} commits</span>
                    : null}
                {reverted > 0 ? <span style={{ color: "var(--sx-red-700)" }}> · x{reverted} reverted</span> : null}
                {insights.subagent_spans.length > 0
                    ? (
                        <span style={{ color: "var(--sx-violet-700)" }}>
                            {" · "}{insights.subagent_spans.length} subagents
                            {insights.delegation_ratio !== null ? ` (${Math.round(insights.delegation_ratio * 100)}% delegated)` : ""}
                        </span>
                    )
                    : null}
            </div>
        </div>
    );
}
