/** Rightmost triage badge: clean (green) / friction N (red) / – (no data). */
export function SignalBadge({ signal, friction }: {
    readonly signal: "clean" | "friction" | null;
    readonly friction: number | null;
}) {
    if (signal === null) return <span style={{ color: "var(--sx-ink-300)" }}>–</span>;
    const warn = signal === "friction";
    return (
        <span style={{
            fontSize: 10,
            fontWeight: 600,
            padding: "1px 6px",
            borderRadius: 2,
            background: warn ? "var(--sx-red-100)" : "var(--sx-green-100)",
            color: warn ? "var(--sx-red-700)" : "var(--sx-green-700)",
        }}>
            {warn ? `friction ${friction ?? ""}` : "clean"}
        </span>
    );
}
