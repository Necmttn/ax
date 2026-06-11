/** Per-turn token-burn sparkline for a sessions-list row. Bars are neutral
 *  gray; only buckets above the user's 30d p90 (server-provided) go amber -
 *  so amber appearing in the table at all marks an outlier row. */
export function BurnSpark({ buckets, p90 }: {
    readonly buckets: ReadonlyArray<number> | null;
    readonly p90: number | null;
}) {
    if (!buckets || buckets.length === 0) {
        return <span style={{ color: "var(--sx-ink-300)" }}>–</span>;
    }
    const max = Math.max(...buckets, 1);
    const outliers = p90 === null ? 0 : buckets.filter((b) => b > p90).length;
    const label = `token burn sparkline, ${buckets.length} buckets, peak ${Math.round(max)} tokens${p90 === null ? "" : `, ${outliers} above 30 day p90`}`;
    return (
        <span
            style={{ display: "inline-flex", alignItems: "flex-end", gap: 1, height: 14 }}
            role="img"
            aria-label={label}
        >
            {buckets.map((b, i) => (
                <i
                    key={i}
                    aria-hidden
                    style={{
                        display: "block",
                        width: 3,
                        borderRadius: "1px 1px 0 0",
                        height: Math.max(2, Math.round((b / max) * 14)),
                        background: p90 !== null && b > p90 ? "var(--sx-amber-500)" : "var(--sx-ink-300)",
                    }}
                />
            ))}
        </span>
    );
}
