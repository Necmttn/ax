import type { CheckpointSnapshotDto, ProposalDto } from "@ax/lib/shared/dashboard-types";
import { fmtTs } from "@ax/lib/shared/formatters";

/**
 * Experiments - past bets paying off. The deck above is futures; this is
 * the ledger of accepted improvements with their measured effect. The
 * trace strip is the argument: baseline frequency, then opportunities at
 * +3/+10/+30 sessions. A bar shrinking to zero is a confirmed win.
 */

const VERDICT_ACCENT: Record<string, string> = {
    adopted: "green",
    no_longer_needed: "green",
    partial: "gold",
    ignored: "muted",
    regressed: "rose",
};

/** Friendlier label for the internal verdict names. */
const VERDICT_LABEL: Record<string, string> = {
    adopted: "adopted",
    no_longer_needed: "normalized",
    partial: "partial",
    ignored: "ignored",
    regressed: "regressed",
};

interface TracePoint {
    readonly label: string;
    readonly opportunities: number;
    readonly addressed: number;
}

const tracePoints = (p: ProposalDto): TracePoint[] => {
    const points: TracePoint[] = [
        { label: "baseline", opportunities: p.frequency, addressed: 0 },
    ];
    for (const cp of p.experiment?.checkpoints ?? []) {
        if (cp.measured) {
            points.push({
                label: String(cp.kind),
                opportunities: cp.measured.opportunities,
                addressed: cp.measured.addressed,
            });
        }
    }
    return points;
};

function TraceStrip({ points, accent }: { readonly points: TracePoint[]; readonly accent: string }) {
    const max = Math.max(...points.map((pt) => pt.opportunities), 1);
    const lastIsZero = points.length > 1 && points[points.length - 1]!.opportunities === 0;
    return (
        <span
            className={`experiment-trace${lastIsZero ? " is-win" : ""}`}
            title={points.map((pt) => `${pt.label}: ${pt.opportunities} opportunities, ${pt.addressed} addressed`).join(" · ")}
        >
            {points.map((pt, i) => {
                const oppH = Math.max(8, Math.round((pt.opportunities / max) * 100));
                const addrH = pt.opportunities > 0
                    ? Math.round((pt.addressed / pt.opportunities) * oppH)
                    : 0;
                return (
                    <i key={i} style={{ height: pt.opportunities === 0 ? "4%" : `${oppH}%` }}>
                        {addrH > 0 ? (
                            <span
                                className={`experiment-trace-addr accent-${accent}`}
                                style={{ height: `${Math.round((addrH / Math.max(oppH, 1)) * 100)}%` }}
                            />
                        ) : null}
                    </i>
                );
            })}
        </span>
    );
}

const stateOf = (p: ProposalDto): { accent: string; badge: string; note: string } => {
    const exp = p.experiment;
    const verdict = exp?.locked_verdict ?? null;
    const checkpoints = (exp?.checkpoints ?? []).filter((c) => c.measured);
    if (verdict) {
        const accent = VERDICT_ACCENT[verdict] ?? "blue";
        const last = checkpoints[checkpoints.length - 1];
        const lastOpp = last?.measured?.opportunities ?? null;
        const note = verdict === "no_longer_needed"
            ? "pattern resolved · no longer firing"
            : verdict === "regressed"
            ? "pattern returned · review artifact"
            : lastOpp !== null
            ? `${lastOpp} occurrences in the last window · was ${p.frequency}x before`
            : "verdict locked";
        return { accent, badge: VERDICT_LABEL[verdict] ?? verdict, note };
    }
    if (checkpoints.length === 0) {
        return { accent: "blue", badge: "pending", note: "waiting for sessions…" };
    }
    const suggested = exp?.latest_checkpoint?.suggested;
    return {
        accent: suggested === "regressed" ? "rose" : "blue",
        badge: `${checkpoints.length}/3 checkpoints`,
        note: suggested ? `suggested: ${suggested}` : "measuring…",
    };
};

export function ExperimentsSection({
    proposals,
    onOpen,
}: {
    readonly proposals: ReadonlyArray<ProposalDto>;
    readonly onOpen: (sig: string) => void;
}) {
    const experiments = proposals.filter(
        (p) => p.status === "accepted" && p.experiment != null,
    );
    return (
        <section className="experiments-section">
            <div className="experiments-lead">
                <span className="next-action-eyebrow" style={{ color: "var(--green)" }}>
                    $ experiments
                </span>
                <h3 className="experiments-headline">
                    {experiments.length > 0
                        ? `${experiments.length} past bet${experiments.length === 1 ? "" : "s"}, measured`
                        : "Past bets, measured"}
                </h3>
                <span className="experiments-count">
                    checkpoints at +3 / +10 / +30 sessions
                </span>
            </div>
            {experiments.length === 0 ? (
                <div className="experiments-empty">
                    <p className="experiments-empty-head">No bets placed yet.</p>
                    <p className="proposal-prose" style={{ color: "var(--muted)" }}>
                        Accept an improvement from the deck above - ax measures whether the
                        fix actually changed your sessions over the next 30. A trace bar
                        that shrinks to zero is a confirmed win.
                    </p>
                </div>
            ) : (
                <div className="experiments-list">
                    {experiments.map((p) => {
                        const st = stateOf(p);
                        const exp = p.experiment!;
                        const artifact = exp.artifact_path?.split("/").pop() ?? null;
                        return (
                            <button
                                type="button"
                                key={p.dedupe_sig}
                                className={`experiment-card accent-${st.accent}${
                                    st.accent === "green" ? " state-win" : st.accent === "rose" ? " state-regressed" : ""
                                }`}
                                onClick={() => onOpen(p.dedupe_sig)}
                            >
                                <span className="experiment-card-meta">
                                    <span className="experiment-card-eyebrow">
                                        {p.form} · accepted {exp.scaffolded_at ? fmtTs(exp.scaffolded_at) : fmtTs(exp.created_at)}
                                    </span>
                                    <span className="experiment-card-title">{p.title}</span>
                                    {artifact ? (
                                        <span className="experiment-card-artifact">{artifact}</span>
                                    ) : null}
                                </span>
                                <span className="experiment-card-trace">
                                    <TraceStrip points={tracePoints(p)} accent={st.accent} />
                                    <span className="experiment-trace-caption">{st.note}</span>
                                </span>
                                <span className={`badge ${st.accent === "green" ? "keep" : st.accent === "rose" ? "archive" : "review"}`}>
                                    {st.badge}
                                </span>
                            </button>
                        );
                    })}
                </div>
            )}
        </section>
    );
}
