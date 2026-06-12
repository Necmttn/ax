import { getFiletypeFromFileName, getSharedHighlighter } from "@pierre/diffs";
import { useEffect, useState } from "react";

export const DIFF_THEMES = ["github-light", "pierre-dark"];

/**
 * Gate rendering until the shared shiki highlighter has this card's themes +
 * languages attached. The library's components tokenize synchronously on
 * mount and - with the worker pool disabled - never retry when the
 * highlighter isn't ready yet, leaving a permanently empty card on first
 * page load. Preloading makes the first render the successful one.
 */
export function useHighlighterReady(fileNames: ReadonlyArray<string>): boolean {
    const [ready, setReady] = useState(false);
    const key = fileNames.join("\n");
    useEffect(() => {
        let alive = true;
        const langs = Array.from(new Set(fileNames.map((n) => getFiletypeFromFileName(n))));
        getSharedHighlighter({ themes: DIFF_THEMES, langs })
            // Render regardless of preload failure - the components fall back
            // to plain text once the highlighter exists in any state.
            .catch(() => undefined)
            .then(() => {
                if (alive) setReady(true);
            });
        return () => {
            alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);
    return ready;
}
