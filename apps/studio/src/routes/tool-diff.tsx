import { File, MultiFileDiff } from "@pierre/diffs/react";
import type { FileProps, MultiFileDiffProps } from "@pierre/diffs/react";
import type { DiffPair, ReadView } from "./edit-diff.ts";
import { useHighlighterReady } from "./use-highlighter-ready.ts";

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
