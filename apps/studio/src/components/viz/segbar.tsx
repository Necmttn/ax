/**
 * Segmented bar - a row of cells where the first `on` light up. Adapted from
 * nullframe's segbar (MIT, github.com/m1ckc3s/nullframe): cells slam in with a
 * back-eased scale and a per-cell stagger. Used for battery/streak/scale-style
 * readouts on the wrapped board. CSS-only animation (no Motion dep); the
 * `ax-seg-in` keyframe is killed under prefers-reduced-motion.
 */
type SegbarColor = "ink" | "green" | "orange" | "accent";

export function Segbar({
    total,
    on,
    color = "ink",
    baseDelay = 0.4,
    wave = false,
}: {
    readonly total: number;
    readonly on: number;
    readonly color?: SegbarColor;
    /** Seconds before the first cell animates in. */
    readonly baseDelay?: number;
    /** Lit cells breathe with a brightness wave (streak flavour). */
    readonly wave?: boolean;
}) {
    return (
        <div className={`ax-segbar ${color} ${wave ? "wave" : ""}`} aria-hidden="true">
            {Array.from({ length: total }, (_, i) => (
                <i
                    key={i}
                    className={i < on ? "on" : ""}
                    style={{ animationDelay: `${baseDelay + i * 0.045}s` }}
                />
            ))}
        </div>
    );
}
