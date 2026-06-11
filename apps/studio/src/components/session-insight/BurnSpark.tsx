/** Per-turn token-burn sparkline for a sessions-list row. Bars are neutral
 *  gray; only buckets above the user's 30d p90 go amber - so amber appearing
 *  in the table at all marks an outlier row.
 *
 *  Unit conversion: p90 is a per-turn average; each bucket is a SUM over
 *  ~(turnCount/buckets.length) turns. We scale the threshold by turns-per-bucket
 *  so a high-turn session doesn't spuriously amber every bar. */
export function BurnSpark({ buckets, p90, turnCount }: {
    readonly buckets: ReadonlyArray<number> | null;
    readonly p90: number | null;
    readonly turnCount: number | null;
}) {
    if (!buckets || buckets.length === 0) {
        return <span style={{ color: "var(--sx-ink-300)" }}>–</span>;
    }
    const max = Math.max(...buckets, 1);
    // Scale per-turn p90 up to per-bucket units before comparing to bucket sums.
    const turnsPerBucket = turnCount && buckets.length > 0 ? Math.max(1, turnCount / buckets.length) : 1;
    const threshold = p90 !== null ? p90 * turnsPerBucket : null;
    const outliers = threshold === null ? 0 : buckets.filter((b) => b > threshold).length;
    const label = `token burn sparkline, ${buckets.length} buckets, peak ${Math.round(max)} tokens${threshold === null ? "" : `, ${outliers} above 30 day p90`}`;
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
                        background: threshold !== null && b > threshold ? "var(--sx-amber-500)" : "var(--sx-ink-300)",
                    }}
                />
            ))}
        </span>
    );
}
