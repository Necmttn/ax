/* THROWAWAY prototype switcher: cycle variants + toggle dark/light. */
import { useEffect } from "react";

export type Theme = "dark" | "light";

export function Switcher({
    variants, current, onVariant, theme, onTheme,
}: {
    variants: ReadonlyArray<{ key: string; name: string }>;
    current: string;
    onVariant: (key: string) => void;
    theme: Theme;
    onTheme: (t: Theme) => void;
}) {
    const idx = Math.max(0, variants.findIndex((v) => v.key === current));
    const go = (d: number) => onVariant(variants[(idx + d + variants.length) % variants.length].key);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const el = document.activeElement;
            if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable)) return;
            if (e.key === "ArrowLeft") go(-1);
            else if (e.key === "ArrowRight") go(1);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    });
    const cur = variants[idx];
    return (
        <div className="rdx-switch">
            <button type="button" aria-label="previous variant" onClick={() => go(-1)}>←</button>
            <span className="lbl">{cur.key} - {cur.name}</span>
            <button type="button" aria-label="next variant" onClick={() => go(1)}>→</button>
            <span className="sep" />
            <button type="button" className="theme" onClick={() => onTheme(theme === "dark" ? "light" : "dark")}>
                {theme === "dark" ? "◐ dark" : "◑ light"}
            </button>
        </div>
    );
}
