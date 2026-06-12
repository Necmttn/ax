/**
 * Token scale - turns an unrelatable token total into physical reality:
 * tokens → words → novels → shelf-stack height → landmark multiples.
 * Rendered as a monospace conversion chain, a bookshelf strip (house
 * trace-bar material), and a row of Eiffel towers.
 *
 * Rough constants, deliberately conservative and stated in the UI:
 *   ~0.75 words per token, ~90k words per novel, ~2.4 cm spine per book.
 */

export interface TokenScaleFacts {
    readonly tokens: number;
    readonly words: number;
    readonly novels: number;
    readonly stackMeters: number;
    readonly eiffels: number;
}

const WORDS_PER_TOKEN = 0.75;
const WORDS_PER_NOVEL = 90_000;
const SPINE_METERS = 0.024;
const EIFFEL_METERS = 330;

export const tokenScale = (tokens: number): TokenScaleFacts => {
    const words = tokens * WORDS_PER_TOKEN;
    const novels = words / WORDS_PER_NOVEL;
    const stackMeters = novels * SPINE_METERS;
    return { tokens, words, novels, stackMeters, eiffels: stackMeters / EIFFEL_METERS };
};

const compact = (n: number): string =>
    new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);

const km = (meters: number): string =>
    meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;

const SHELF_SPINES = 44;
const TOWER_CAP = 16;

/** Deterministic spine heights so the shelf doesn't flicker. */
const spineHeight = (i: number): number => 55 + ((i * 2654435761) % 41);

export function TokenScale({ tokens }: { readonly tokens: number | null }) {
    if (tokens === null || tokens < 1_000_000) return null;
    const s = tokenScale(tokens);
    const towers = Math.max(1, Math.min(TOWER_CAP, Math.floor(s.eiffels)));
    return (
        <div className="token-scale" aria-label="Token total in physical terms">
            <span className="token-scale-chain">
                {compact(s.tokens)} tokens → {compact(s.words)} words → {compact(s.novels)} novels
                → a {km(s.stackMeters)} stack → {s.eiffels >= 1 ? `${s.eiffels.toFixed(1)}× the Eiffel Tower` : `${Math.round((s.stackMeters / EIFFEL_METERS) * 100)}% of the Eiffel Tower`}
            </span>
            <div className="token-scale-shelf" aria-hidden="true">
                {Array.from({ length: SHELF_SPINES }, (_, i) => (
                    <i key={i} style={{ height: `${spineHeight(i)}%` }} />
                ))}
            </div>
            <div className="token-scale-towers" aria-hidden="true">
                {Array.from({ length: towers }, (_, i) => (
                    <EiffelGlyph key={i} />
                ))}
                {s.eiffels > towers ? (
                    <span className="token-scale-tower-overflow">×{s.eiffels.toFixed(1)}</span>
                ) : null}
            </div>
            <span className="token-scale-note">
                everything you and your agents wrote and read, printed and stacked
                · ~{Math.round(WORDS_PER_TOKEN * 100) / 100} words/token, {compact(WORDS_PER_NOVEL)}-word novels
            </span>
        </div>
    );
}

function EiffelGlyph() {
    return (
        <svg viewBox="0 0 24 40" className="token-scale-tower">
            <path
                d="M12 1 L13 9 L16 22 Q16.5 25 21 30 L23 31 L23 33 L17 33 Q14.5 28 12 28 Q9.5 28 7 33 L1 33 L1 31 L3 30 Q7.5 25 8 22 L11 9 Z M9.5 17 L14.5 17 M8.6 22 L15.4 22 Q12 26.5 8.6 22 Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
            />
        </svg>
    );
}
