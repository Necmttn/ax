import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { NextActionCard, NextActionKind } from "@ax/lib/shared/dashboard-types";
import { api } from "../api.ts";
import { CopyButton } from "./copy-button.tsx";

export interface NextActionsHandlers {
    /** open the proposal case file (detail) - accepting happens THERE,
     *  next to the plan rail and projected impact, not from the card. */
    readonly onReview: (sig: string) => void;
    readonly onVerdict: (sig: string, verdict: string) => void;
    /** true while any action mutation is in flight - disables all card buttons */
    readonly pending: boolean;
}

/** Eyebrow labels read as findings, not table names. */
const KIND_LABEL: Record<NextActionKind, string> = {
    proposal: "proposal",
    verdict: "verdict due",
    tool_failure: "failing tool",
    churn: "churn",
    routing: "routing savings",
    skill_hygiene: "skill hygiene",
};

/** Semantic accent per kind: money green, failure rose, decision gold. */
const KIND_ACCENT: Record<NextActionKind, string> = {
    routing: "green",
    proposal: "blue",
    verdict: "gold",
    tool_failure: "rose",
    churn: "violet",
    skill_hygiene: "gold",
};

/** Three rows of cards max before the registry below buries the page. */
const DECK_CAP = 6;

export function NextActionsPanel({ handlers }: { readonly handlers: NextActionsHandlers }) {
    const query = useQuery({
        queryKey: ["next-actions"],
        queryFn: () => api.nextActions(),
        staleTime: 60_000,
    });
    if (query.isLoading) return <div className="loading">Loading next actions&#8230;</div>;
    if (query.error) return <div className="error">next-actions: {String(query.error)}</div>;
    const cards = query.data?.cards ?? [];
    if (cards.length === 0) {
        return (
            <div className="next-actions-empty">
                Nothing actionable right now &#8212; the loop is clean.
            </div>
        );
    }
    const deck = cards.slice(0, DECK_CAP);
    const overflow = cards.length - deck.length;
    return (
        <>
            <div className="next-actions">
                {deck.map((card) => (
                    <NextActionCardView key={card.id} card={card} handlers={handlers} />
                ))}
            </div>
            {overflow > 0 ? (
                <div className="next-actions-note">+{overflow} more in the registry below</div>
            ) : null}
            {(query.data?.notes.length ?? 0) > 0 ? (
                <div className="next-actions-note">
                    {query.data!.notes.map((n) => `${n.source}: unavailable`).join(" \xB7 ")}
                </div>
            ) : null}
        </>
    );
}

/** Strip the dead "Decide proposal:" prefix - the eyebrow already says it. */
const cleanTitle = (title: string): string => title.replace(/^Decide proposal:\s*/i, "");

function NextActionCardView({
    card,
    handlers,
}: {
    readonly card: NextActionCard;
    readonly handlers: NextActionsHandlers;
}) {
    const a = card.inline_action;
    const acceptSig = a?.type === "accept" ? a.sig : null;
    const verdictSig = a?.type === "verdict" ? a.sig : null;
    const suggestedVerdict = a?.type === "verdict" ? a.suggested_verdict : null;
    // "decide" inline actions (skill hygiene) intentionally have no one-click
    // handler - role choice needs thought, so those cards offer copy + link only.

    const title = cleanTitle(card.title);
    // Every card gets exactly one serif line: the impact chip when present
    // (the value IS the headline), otherwise the title takes the hero slot.
    const heroIsTitle = card.impact_chip == null;
    const hero = card.impact_chip ?? title;

    return (
        <article className={`next-action-card accent-${KIND_ACCENT[card.kind] ?? "blue"}`}>
            <span className="next-action-eyebrow">$ {KIND_LABEL[card.kind] ?? card.kind}</span>
            <strong className={`next-action-hero${heroIsTitle ? " is-title" : ""}`}>{hero}</strong>
            <p className="next-action-problem">{card.evidence}</p>
            {heroIsTitle ? null : (
                <p className="next-action-fix">
                    <span className="next-action-fix-label">
                        fix &#8594;{card.fix_kind ? ` ${card.fix_kind}:` : ""}
                    </span>{" "}
                    {title}
                </p>
            )}
            <div className="next-action-foot">
                {acceptSig ? (
                    <button
                        type="button"
                        className="next-action-primary"
                        onClick={() => handlers.onReview(acceptSig)}
                    >
                        Review &#8594;
                    </button>
                ) : verdictSig && suggestedVerdict ? (
                    <button
                        type="button"
                        className="next-action-primary"
                        disabled={handlers.pending}
                        onClick={() => handlers.onVerdict(verdictSig, suggestedVerdict)}
                    >
                        {handlers.pending ? "…" : `Lock: ${suggestedVerdict}`}
                    </button>
                ) : card.link ? (
                    // card.link values come from the server-side builders,
                    // which only emit registered SPA paths
                    <Link to={card.link} className="next-action-primary">
                        Details &#8594;
                    </Link>
                ) : null}
                <CopyButton text={card.brief} label="copy brief" className="next-action-ghost" />
                {card.link && (acceptSig || verdictSig) ? (
                    <Link to={card.link} className="next-action-ghost">
                        details &#8594;
                    </Link>
                ) : null}
            </div>
        </article>
    );
}
