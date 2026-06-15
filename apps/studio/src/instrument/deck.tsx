/** The agent-authored recap deck (ax wrapped publish cards) as instrument
 *  cards. Each card keys a channel colour AND alternates its viz (bars / line /
 *  dot-cells / segbar / ring) so the deck reads like a nullframe instrument
 *  wall rather than a wall of identical bar charts. */
import type { WrappedCardDto } from "@ax/lib/shared/dashboard-types";
import { Segbar } from "./viz.tsx";

const ACCENTS = ["green", "blue", "gold", "violet", "rose"] as const;
const N = 24;

function* seededBars(seed: string, count: number): Generator<number> {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
    for (let i = 0; i < count; i++) {
        h ^= h << 13; h ^= h >>> 17; h ^= h << 5; h >>>= 0;
        yield 14 + (h % 86);
    }
}
/** Resample a series to `count` points (0..100). */
const resample = (s: ReadonlyArray<number>, count: number): number[] => {
    const max = Math.max(...s, 1);
    if (s.length >= count) {
        const step = s.length / count;
        return Array.from({ length: count }, (_, i) => 8 + Math.round((s[Math.floor(i * step)] / max) * 92));
    }
    return Array.from({ length: count }, (_, i) => 8 + Math.round((s[Math.floor((i / count) * s.length)] / max) * 92));
};
const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);

// ---- viz variants (all key off var(--card-accent)) -------------------------

const Bars = ({ v }: { v: number[] }) => (
    <div className="wr-bars" aria-hidden="true">{v.map((b, i) => <i key={i} style={{ height: `${b}%` }} />)}</div>
);

const Line = ({ v }: { v: number[] }) => {
    const pts = v.map((b, i) => `${(i / (v.length - 1)) * 100},${30 - (b / 100) * 27}`).join(" ");
    return (
        <svg className="wr-line" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
            <polygon points={`0,30 ${pts} 100,30`} fill="var(--card-accent)" opacity="0.16" />
            <polyline points={pts} fill="none" stroke="var(--card-accent)" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
        </svg>
    );
};

const Cells = ({ v }: { v: number[] }) => (
    <div className="wr-cells" aria-hidden="true">
        {v.map((b, i) => {
            const lvl = b > 72 ? 1 : b > 48 ? 0.7 : b > 26 ? 0.42 : 0.18;
            return <i key={i} style={{ background: `color-mix(in srgb, var(--card-accent) ${Math.round(lvl * 100)}%, var(--surface))` }} />;
        })}
    </div>
);

const Seg = ({ v }: { v: number[] }) => (
    <div className="wr-seg-wrap" aria-hidden="true"><Segbar total={26} on={Math.max(2, Math.round((avg(v) / 100) * 26))} tone="card" /></div>
);

const Ring = ({ v }: { v: number[] }) => {
    const frac = Math.min(1, Math.max(0.06, avg(v) / 100));
    const C = 2 * Math.PI * 15;
    return (
        <div className="wr-ring" aria-hidden="true">
            <svg viewBox="0 0 36 36">
                <circle cx="18" cy="18" r="15" className="bg" />
                <circle cx="18" cy="18" r="15" className="fg" strokeDasharray={C} strokeDashoffset={C * (1 - frac)} />
            </svg>
        </div>
    );
};

const VARIANTS = [Bars, Line, Cells, Seg, Ring] as const;

function DeckCard({ card, index }: { card: WrappedCardDto; index: number }) {
    const accent = ACCENTS[index % ACCENTS.length];
    const grounded = (card.series?.length ?? 0) >= 2;
    const v = grounded ? resample(card.series ?? [], N) : [...seededBars(card.headline, N)];
    const Viz = VARIANTS[index % VARIANTS.length];
    return (
        <article className={`rdx-card acc-${accent} wr-card`} style={{ animationDelay: `${(index % 8) * 0.05}s` }}>
            <div className="wr-viz" title={grounded ? (card.series_label ?? undefined) : undefined}><Viz v={v} /></div>
            <span className="wr-q">$ {card.question}</span>
            <h3 className="wr-head">{card.headline}</h3>
            <p className="wr-body">{card.body}</p>
            {card.sensitivity === "sensitive" ? <span className="nf-flag">private</span> : null}
        </article>
    );
}

export function RecapDeck({ cards }: { cards: ReadonlyArray<WrappedCardDto> }) {
    if (cards.length === 0) return null;
    return (
        <section className="wr-section">
            <div className="wr-kicker rdx-label">the recap · {cards.length} cards</div>
            <div className="wr-deck">
                {cards.map((c, i) => <DeckCard key={`${c.position}-${c.headline}`} card={c} index={i} />)}
            </div>
        </section>
    );
}
