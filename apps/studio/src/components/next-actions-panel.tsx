import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { NextActionCard } from "@ax/lib/shared/dashboard-types";
import { api } from "../api.ts";
import { CopyButton } from "./copy-button.tsx";

export interface NextActionsHandlers {
    readonly onAccept: (sig: string) => void;
    readonly onVerdict: (sig: string, verdict: string) => void;
    readonly pending: boolean;
}

const KIND_LABEL: Record<string, string> = {
    proposal: "proposal",
    verdict: "verdict due",
    tool_failure: "tool failure",
    churn: "churn",
    routing: "routing $",
    skill_hygiene: "skill hygiene",
};

export function NextActionsPanel({ handlers }: { readonly handlers: NextActionsHandlers }) {
    const query = useQuery({ queryKey: ["next-actions"], queryFn: () => api.nextActions() });
    if (query.isLoading) return <div className="loading">Loading next actions&#8230;</div>;
    if (query.error) return <div className="error">next-actions: {String(query.error)}</div>;
    const cards = query.data?.cards ?? [];
    if (cards.length === 0) {
        return <div className="empty">Nothing actionable right now &#8212; loop is clean.</div>;
    }
    return (
        <div className="next-actions">
            {cards.map((card) => (
                <NextActionCardView key={card.id} card={card} handlers={handlers} />
            ))}
            {(query.data?.notes.length ?? 0) > 0 ? (
                <div className="meta">
                    {query.data!.notes.map((n) => `${n.source}: unavailable`).join(" \xB7 ")}
                </div>
            ) : null}
        </div>
    );
}

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
    return (
        <article className="panel next-action-card">
            <header>
                <span className={`badge ${card.kind === "verdict" ? "archive" : "review"}`}>
                    {KIND_LABEL[card.kind] ?? card.kind}
                </span>
                <h4 style={{ margin: 0 }}>{card.title}</h4>
            </header>
            <p className="meta">{card.evidence}</p>
            <div className="actions" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <CopyButton text={card.brief} />
                {acceptSig ? (
                    <button
                        type="button"
                        className="badge keep"
                        disabled={handlers.pending}
                        onClick={() => handlers.onAccept(acceptSig)}
                    >
                        Accept &amp; scaffold
                    </button>
                ) : null}
                {verdictSig && suggestedVerdict ? (
                    <button
                        type="button"
                        className="badge keep"
                        disabled={handlers.pending}
                        onClick={() => handlers.onVerdict(verdictSig, suggestedVerdict)}
                    >
                        Lock: {suggestedVerdict}
                    </button>
                ) : null}
                {card.link ? (
                    <Link to={card.link} className="badge review">
                        details &#8594;
                    </Link>
                ) : null}
            </div>
        </article>
    );
}
