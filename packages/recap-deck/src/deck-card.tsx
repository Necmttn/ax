/** Reusable, data-agnostic recap-deck card. The SINGLE source of the
 *  "wrapped" instrument card markup (extracted from the studio deck's
 *  `DeckCard`). Consumers (studio / landing / profile) own their own data
 *  plumbing and pass a resolved `VizSpec` + copy; this renders the same
 *  `rdx-card acc-* wr-card` instrument card studio uses. */
import type { ReactElement } from "react";
import { CardViz, type VizSpec } from "./card-viz.tsx";

export interface DeckCardProps {
    readonly accent: "green" | "blue" | "gold" | "violet" | "rose" | "alert";
    readonly spec: VizSpec;
    readonly question: string;
    readonly headline: React.ReactNode;
    readonly body?: React.ReactNode;
    readonly flag?: string;
    readonly index?: number;
}

export function DeckCard({ accent, spec, question, headline, body, flag, index = 0 }: DeckCardProps): ReactElement {
    return (
        <article className={`rdx-card acc-${accent} wr-card`} style={{ animationDelay: `${(index % 8) * 0.05}s` }}>
            <div className="wr-viz"><CardViz spec={spec} /></div>
            <span className="wr-q"><span aria-hidden="true">$ </span>{question}</span>
            <h3 className="wr-head">{headline}</h3>
            {body != null ? <p className="wr-body">{body}</p> : null}
            {flag ? <span className="nf-flag">{flag}</span> : null}
        </article>
    );
}
