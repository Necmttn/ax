/** Rightmost triage signal: clean (green) / friction N (red) / – (no data).
 *  Instrument readout, not a loud pill - colour lives in a single status dot,
 *  the label stays neutral mono so a column of these reads calm. The friction
 *  count is the one emphasised glyph (it's the signal worth noticing). */
export function SignalBadge({ signal, friction }: {
    readonly signal: "clean" | "friction" | null;
    readonly friction: number | null;
}) {
    if (signal === null) return <span style={{ color: "var(--dim)", fontSize: 10 }}>–</span>;
    const warn = signal === "friction";
    return (
        <span style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontFamily: "var(--mono)",
            fontSize: 10.5,
            letterSpacing: "0.04em",
            color: "var(--sec)",
            whiteSpace: "nowrap",
        }}>
            <span
                aria-hidden="true"
                style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: warn ? "var(--red)" : "var(--green)",
                    flex: "none",
                }}
            />
            {warn ? (
                <>friction <b style={{ color: "var(--pri)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{friction ?? ""}</b></>
            ) : "clean"}
        </span>
    );
}
