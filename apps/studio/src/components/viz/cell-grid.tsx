import { useEffect, useRef } from "react";

/**
 * Contribution-style cell grid. Adapted from nullframe's ContributionsCard
 * (MIT, github.com/m1ckc3s/nullframe): a grid of cells that slam in on a
 * diagonal stagger, then a random lit cell "glims" (flashes bright) on an
 * interval so a static heatmap reads as live. Levels 0-4 map to luminance
 * ramps defined in CSS.
 *
 * `levels` is row-major; `cols` sets the column count and the grid wraps.
 * The glim loop only touches lit cells (level >= 2) and pauses when the tab
 * is hidden or prefers-reduced-motion is set.
 */
export function CellGrid({
    levels,
    cols,
    cell = 11,
    gap = 3,
    glim = true,
}: {
    readonly levels: ReadonlyArray<number>;
    readonly cols: number;
    readonly cell?: number;
    readonly gap?: number;
    readonly glim?: boolean;
}) {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!glim) return;
        const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        if (reduced) return;
        const el = ref.current;
        if (!el) return;
        const iv = window.setInterval(() => {
            if (document.hidden) return;
            const kids = el.children;
            if (!kids.length) return;
            const k = kids[(Math.random() * kids.length) | 0] as HTMLElement;
            if (!/lvl-[234]/.test(k.className)) return;
            k.classList.add("glim");
            window.setTimeout(() => k.classList.remove("glim"), 420);
        }, 650);
        return () => window.clearInterval(iv);
    }, [glim, levels.length]);

    return (
        <div
            ref={ref}
            className="ax-cell-grid"
            aria-hidden="true"
            style={{
                gridTemplateColumns: `repeat(${cols}, ${cell}px)`,
                gridAutoRows: `${cell}px`,
                gap: `${gap}px`,
            }}
        >
            {levels.map((lvl, i) => {
                const col = i % cols;
                const row = Math.floor(i / cols);
                return (
                    <i
                        key={i}
                        className={lvl ? `lvl-${Math.min(4, lvl)}` : ""}
                        style={{ animationDelay: `${0.2 + (col + row) * 0.018}s` }}
                    />
                );
            })}
        </div>
    );
}
