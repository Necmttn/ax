import type { CheckpointSnapshotDto, ProposalDto } from "@ax/lib/shared/dashboard-types";
import { fmtTs } from "@ax/lib/shared/formatters";

/**
 * Experiments - past bets paying off. The deck above is futures; this is
 * the ledger of accepted improvements with their measured effect. The
 * trace strip is the argument: baseline frequency, then opportunities at
 * +3/+10/+30 sessions. A bar at zero means the window had nothing to measure -
 * insufficient data, not a confirmed win (#1134); the human places the verdict.
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

/**
 * The strip carries the counts and nothing else (#1134).
 *
 * It used to add `is-win` whenever the last bar sat at zero, celebrating the
 * one reading that is NOT a result: zero opportunities means the window had
 * nothing to measure - no trigger fired, or no detector watched for one - and
 * that is insufficient data, not a confirmed win. The only verdict styling left
 * is the human's: `accent` carries the locked verdict's colour.
 */
function TraceStrip({ points, accent }: { readonly points: TracePoint[]; readonly accent: string }) {
    const max = Math.max(...points.map((pt) => pt.opportunities), 1);
    return (
        <span
            className="experiment-trace"
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

/**
 * Why the current recommendation is missing, in the user's words (#1134).
 *
 * `measuring…` used to cover all of these, which read as "give it time" for
 * states time cannot fix: a form with no detector, an experiment that retired,
 * evidence that has to be re-derived. The DTO's `current_reason` distinguishes
 * them, and each gets its own line here.
 */
const REASON_NOTE: Record<string, string> = {
    no_opportunities: "insufficient data · no opportunities in the window",
    detector_unavailable: "detector unavailable",
    artifact_unavailable: "insufficient data · no installed artifact recorded",
    refresh_required: "insufficient data · evidence needs derivation",
    not_started: "artifact not installed yet",
    retired: "retired",
    regressed: "marked regressed",
    not_accepted: "proposal not accepted",
};

/** The badge/note/accent one experiment card renders. Exported as a pure
 *  function so the state machine is testable without a DOM. */
export const experimentDisplayState = (
    p: ProposalDto,
): { accent: string; badge: string; note: string } => {
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
        const reason = exp?.current_reason ?? null;
        const pending = reason === null || reason === "no_checkpoint"
            ? "waiting for sessions…"
            : REASON_NOTE[reason] ?? "insufficient data";
        return { accent: "blue", badge: "pending", note: pending };
    }
    const suggested = exp?.latest_checkpoint?.suggested ?? null;
    const badge = `${checkpoints.length}/3 checkpoints`;
    if (suggested === null) {
        // Neutral styling: an unavailable measurement is not a bad result.
        const reason = exp?.current_reason ?? null;
        return {
            accent: "muted",
            badge,
            note: reason === null ? "insufficient data" : REASON_NOTE[reason] ?? "insufficient data",
        };
    }
    return {
        accent: suggested === "regressed" ? "rose" : "blue",
        badge,
        // Invocation counts show the artifact was PRESENT when the trigger
        // fired. They do not show that the work got better.
        note: `suggested: ${suggested} · observed use`,
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
                        Accept an improvement from the deck above - ax tracks how often
                        the artifact was there when its trigger fired, over the next 30
                        sessions. A window with nothing to measure reports insufficient
                        data; you place the verdict.
                    </p>
                </div>
            ) : (
                <div className="experiments-list">
                    {experiments.map((p) => {
                        const st = experimentDisplayState(p);
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
