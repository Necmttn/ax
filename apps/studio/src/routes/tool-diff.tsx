import { getFiletypeFromFileName, getSharedHighlighter } from "@pierre/diffs";
import { File, MultiFileDiff } from "@pierre/diffs/react";
import type { FileProps, MultiFileDiffProps } from "@pierre/diffs/react";
import { useEffect, useState } from "react";
import type { DiffPair, ReadView } from "./edit-diff.ts";

const THEMES = ["github-light", "pierre-dark"];

/**
 * Gate rendering until the shared shiki highlighter has this card's themes +
 * languages attached. The library's components tokenize synchronously on
 * mount and - with the worker pool disabled - never retry when the
 * highlighter isn't ready yet, leaving a permanently empty card on first
 * page load. Preloading makes the first render the successful one.
 */
function useHighlighterReady(fileNames: ReadonlyArray<string>): boolean {
    const [ready, setReady] = useState(false);
    const key = fileNames.join("\n");
    useEffect(() => {
        let alive = true;
        const langs = Array.from(new Set(fileNames.map((n) => getFiletypeFromFileName(n))));
        getSharedHighlighter({ themes: THEMES, langs })
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

/**
 * Syntax-highlighted diff rendering for edit-class tool calls, one
 * MultiFileDiff per extracted pair. Loaded via React.lazy from tool-row so
 * @pierre/diffs (and its bundled shiki) stays out of the main chunk.
 *
 * Worker pool is disabled: the daemon serves the built bundle as static
 * files and emitting the lib's highlight workers through vite is not
 * guaranteed; pairs are snippet-sized so main-thread highlighting is fine.
 */
const OPTIONS: MultiFileDiffProps<undefined>["options"] = {
    diffStyle: "unified",
    themeType: "light",
    theme: { light: "github-light", dark: "pierre-dark" },
    disableFileHeader: true,
    overflow: "wrap",
};

/** Read results rendered through the same component as the edit diffs - one
 *  renderer, one theme, one gutter. Identical old/new contents + expandUnchanged
 *  renders the file as pure context lines. The library always numbers from 1,
 *  so the gutter only shows for whole-file reads; offset reads hide it (the
 *  card header already shows offset/limit). */
const READ_OPTIONS: FileProps<undefined>["options"] = {
    themeType: "light",
    theme: { light: "github-light", dark: "pierre-dark" },
    disableFileHeader: true,
    overflow: "wrap",
};

export function ToolFileView({ view }: { view: ReadView }) {
    const ready = useHighlighterReady([view.fileName]);
    if (!ready) return null;
    return (
        <div
            data-testid="tool-card-file"
            style={{ margin: "0 0 4px", maxHeight: 320, overflow: "auto", border: "1px solid var(--line)", borderRadius: 6 }}
        >
            <File
                file={{ name: view.fileName, contents: view.contents }}
                options={{ ...READ_OPTIONS, disableLineNumbers: view.startLine !== 1 }}
                disableWorkerPool
            />
        </div>
    );
}

export default function ToolDiff({ pairs }: { pairs: ReadonlyArray<DiffPair> }) {
    const ready = useHighlighterReady(pairs.map((p) => p.fileName));
    if (!ready) return null;
    return (
        <div
            data-testid="tool-card-diff"
            style={{ display: "flex", flexDirection: "column", gap: 4, margin: "0 0 4px", maxHeight: 320, overflow: "auto" }}
        >
            {pairs.map((p, i) => (
                <div
                    key={`${p.fileName}-${i}`}
                    style={{ border: "1px solid var(--line)", borderRadius: 6, overflow: "hidden" }}
                >
                    <MultiFileDiff
                        oldFile={{ name: p.fileName, contents: p.oldText }}
                        newFile={{ name: p.fileName, contents: p.newText }}
                        options={OPTIONS}
                        disableWorkerPool
                    />
                </div>
            ))}
        </div>
    );
}
