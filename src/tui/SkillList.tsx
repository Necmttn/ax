import type { SkillRow } from "./hooks/useSkills.ts";

export type SortKey =
    | "taste_score"
    | "inv_30d"
    | "inv_7d"
    | "total_inv"
    | "last_used"
    | "name";

interface Props {
    readonly rows: ReadonlyArray<SkillRow>;
    readonly selectedIndex: number;
    readonly sortKey: SortKey;
    readonly reversed: boolean;
    readonly loading: boolean;
    readonly emptyMessage: string;
}

const COL_WIDTHS = {
    name: 28,
    scope: 10,
    score: 6,
    n7: 4,
    n30: 5,
    total: 6,
    last: 7,
} as const;

const pad = (s: string, n: number): string =>
    s.length >= n ? s.slice(0, n - 1) + "…" : s.padEnd(n);
const padR = (s: string, n: number): string =>
    s.length >= n ? s.slice(0, n) : s.padStart(n);

const fmtLastUsed = (iso: string | null): string => {
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

const sortKeyLabel = (k: SortKey): string =>
    k === "taste_score"
        ? "score"
        : k === "inv_30d"
          ? "30d"
          : k === "inv_7d"
            ? "7d"
            : k === "total_inv"
              ? "total"
              : k === "last_used"
                ? "last"
                : "name";

const fmtScore = (n: number): string =>
    Number.isInteger(n) ? String(n) : n.toFixed(1);

/**
 * Sortable, navigable skill list. Renders the in-memory filtered + sorted
 * rows the parent passes in; navigation/sort state lives in the parent so
 * the detail pane can react to selection changes without re-mounting.
 */
export function SkillList({
    rows,
    selectedIndex,
    sortKey,
    reversed,
    loading,
    emptyMessage,
}: Props) {
    const titleArrow = reversed ? "▲" : "▼";
    const title = ` skills · sort: ${sortKeyLabel(sortKey)} ${titleArrow} `;

    const header =
        pad("name", COL_WIDTHS.name) +
        " " +
        pad("scope", COL_WIDTHS.scope) +
        " " +
        padR("score", COL_WIDTHS.score) +
        " " +
        padR("7d", COL_WIDTHS.n7) +
        " " +
        padR("30d", COL_WIDTHS.n30) +
        " " +
        padR("tot", COL_WIDTHS.total) +
        " " +
        padR("last", COL_WIDTHS.last);

    if (loading) {
        return (
            <box title={title} style={{ border: true, flexGrow: 1 }}>
                <text fg="#7aa2f7">Loading…</text>
            </box>
        );
    }

    if (rows.length === 0) {
        return (
            <box title={title} style={{ border: true, flexGrow: 1 }}>
                <text fg="#a9b1d6">{emptyMessage}</text>
            </box>
        );
    }

    return (
        <box
            title={title}
            style={{
                border: true,
                flexGrow: 1,
                flexDirection: "column",
                paddingLeft: 1,
                paddingRight: 1,
            }}
        >
            <text fg="#7aa2f7">{header}</text>
            <text fg="#414868">
                {"─".repeat(
                    COL_WIDTHS.name +
                        COL_WIDTHS.scope +
                        COL_WIDTHS.score +
                        COL_WIDTHS.n7 +
                        COL_WIDTHS.n30 +
                        COL_WIDTHS.total +
                        COL_WIDTHS.last +
                        6,
                )}
            </text>
            {rows.map((row, idx) => {
                const isSelected = idx === selectedIndex;
                const line =
                    pad(row.name, COL_WIDTHS.name) +
                    " " +
                    pad(row.scope, COL_WIDTHS.scope) +
                    " " +
                    padR(fmtScore(Number(row.taste_score ?? 0)), COL_WIDTHS.score) +
                    " " +
                    padR(String(row.inv_7d), COL_WIDTHS.n7) +
                    " " +
                    padR(String(row.inv_30d), COL_WIDTHS.n30) +
                    " " +
                    padR(String(row.total_inv), COL_WIDTHS.total) +
                    " " +
                    padR(fmtLastUsed(row.last_used), COL_WIDTHS.last);
                return isSelected ? (
                    <text
                        key={`${row.scope}/${row.name}`}
                        fg="#1a1b26"
                        bg="#7aa2f7"
                    >
                        {line}
                    </text>
                ) : (
                    <text key={`${row.scope}/${row.name}`} fg="#c0caf5">
                        {line}
                    </text>
                );
            })}
        </box>
    );
}
