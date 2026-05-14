/**
 * Isomorphic display formatters. No node:/bun: imports - shared by CLI, TUI,
 * server, and browser SPA.
 */

/** Thousand-separator integer formatter (`12,345`). */
export const fmtCount = (value: number | null | undefined): string => {
    const n = Number(value ?? 0);
    return Number.isFinite(n) ? n.toLocaleString("en-US") : "0";
};

/** Score is an integer when whole, one decimal otherwise (`12,345` or `12.5`). */
export const fmtScore = (value: number | null | undefined): string => {
    const n = Number(value ?? 0);
    if (!Number.isFinite(n)) return "0";
    return Number.isInteger(n) ? n.toLocaleString("en-US") : n.toFixed(1);
};

/** Coarse "how long ago" - `today` / `1d` / `12d` / `4mo` / `2y` / `never`. */
export const fmtLastUsed = (iso: string | null | undefined): string => {
    if (!iso) return "never";
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return "?";
    const days = Math.floor((Date.now() - t) / (1000 * 60 * 60 * 24));
    if (days <= 0) return "today";
    if (days === 1) return "1d";
    if (days < 30) return `${days}d`;
    if (days < 365) return `${Math.floor(days / 30)}mo`;
    return `${Math.floor(days / 365)}y`;
};

/** UTC date + minute, used in detail panels (`2026-05-12 07:15`). */
export const fmtTs = (iso: string | null | undefined): string => {
    if (!iso) return "never";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "?";
    return d.toISOString().slice(0, 16).replace("T", " ");
};
