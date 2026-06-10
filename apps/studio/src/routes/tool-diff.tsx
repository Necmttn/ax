import { MultiFileDiff } from "@pierre/diffs/react";
import type { MultiFileDiffProps } from "@pierre/diffs/react";
import type { DiffPair } from "./edit-diff.ts";

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

export default function ToolDiff({ pairs }: { pairs: ReadonlyArray<DiffPair> }) {
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
