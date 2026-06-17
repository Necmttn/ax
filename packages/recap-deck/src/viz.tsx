/* Shared recap-deck viz primitives - nullframe grammar (MIT, m1ckc3s/nullframe).
   Theme-agnostic: colours come from CSS vars on the .rdx scope.
   Extracted verbatim from apps/studio/src/instrument/viz.tsx (Doto + Segbar). */

/** Dot-matrix numerals. */
export function Doto({ children, className = "" }: { children: React.ReactNode; className?: string }) {
    return <span className={`rdx-doto ${className}`}>{children}</span>;
}

/** Segmented bar - first `on` of `total` cells lit, staggered slam-in. */
export function Segbar({
    total, on, tone = "accent", wave = false, color, gradient = false,
}: { total: number; on: number; tone?: "accent" | "alert" | "green" | "pri" | "card"; wave?: boolean; color?: string; gradient?: boolean }) {
    // gradient: lit segments ramp from dark → full accent (nullframe heat bar).
    const base = color ?? "var(--accent)";
    const t = gradient ? "" : color ? "tint" : tone;
    return (
        <div className={`rdx-seg ${t} ${wave ? "wave" : ""}`} aria-hidden="true" style={color && !gradient ? ({ "--seg": color } as Record<string, string>) : undefined}>
            {Array.from({ length: total }, (_, i) => {
                const lit = i < on;
                const style: Record<string, string> = { animationDelay: `${0.2 + i * 0.04}s` };
                if (gradient && lit) {
                    const pct = Math.round(34 + 66 * (on <= 1 ? 1 : i / (on - 1)));
                    style.background = `color-mix(in srgb, ${base} ${pct}%, var(--surface))`;
                }
                return <i key={i} className={lit ? "on" : ""} style={style} />;
            })}
        </div>
    );
}
