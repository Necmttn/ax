import { useMemo, useRef, useState, type CSSProperties } from "react";
import type { GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { InspectTurnDto } from "@ax/lib/shared/dashboard-types";
import { buildFilesTouched, type FilesTouchedModel, type FileTouch } from "./files-touched.ts";

const ROW_H = 26;
const TREE_MAX_H = 360;

/** Dashboard palette piped into the tree's shadow DOM via the documented
 *  `--trees-*-override` custom properties (they inherit across the boundary). */
const TREE_THEME = {
    "--trees-bg-override": "var(--panel)",
    "--trees-fg-override": "var(--ink)",
    "--trees-fg-muted-override": "var(--muted)",
    "--trees-accent-override": "var(--blue)",
    "--trees-border-color-override": "var(--line)",
    "--trees-selected-bg-override": "color-mix(in srgb, var(--blue) 12%, var(--panel))",
    "--trees-search-bg-override": "var(--page)",
    "--trees-search-fg-override": "var(--ink)",
    "--trees-status-added-override": "var(--green)",
    "--trees-git-added-color-override": "var(--green)",
    "--trees-status-modified-override": "var(--gold)",
    "--trees-git-modified-color-override": "var(--gold)",
} as CSSProperties;

const PANEL_STYLE: CSSProperties = {
    padding: "10px var(--strip-x)",
    background: "var(--panel)",
    borderBottom: "1px solid var(--line)",
    fontSize: 12,
};

const SUMMARY_STYLE: CSSProperties = {
    font: "700 10px/1.5 ui-monospace, monospace",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: "var(--muted)",
    cursor: "pointer",
};

export function filesTouchedStartsOpen(fileCount: number): boolean {
    return fileCount <= 40;
}

export function hasFileDirectoryCollision(paths: ReadonlyArray<string>): boolean {
    const files = new Set(paths);
    for (const path of paths) {
        const parts = path.split("/");
        for (let i = 1; i < parts.length; i += 1) {
            if (files.has(parts.slice(0, i).join("/"))) return true;
        }
    }
    return false;
}

function summaryLine(model: FilesTouchedModel): string {
    const edited = model.files.filter((f) => f.status != null).length;
    const parts = [
        `${model.files.length} file${model.files.length === 1 ? "" : "s"} touched`,
        edited > 0 ? `${edited} edited` : null,
        model.totalReads > 0 ? `${model.totalReads} read${model.totalReads === 1 ? "" : "s"}` : null,
    ];
    return parts.filter(Boolean).join(" · ");
}

/** 1234 → "1.2k": row decorations must stay glanceable next to the filename. */
export function compactChars(n: number): string {
    if (n < 1000) return String(n);
    const k = n / 1000;
    return `${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}k`;
}

/** The once-created tree model reads files through this lookup; the panel is
 *  keyed per session file upstream, so the data never changes under it.
 *  Edited files read as a diffstat (+chars −chars); read-only files as the
 *  read count. */
function decorationFor(model: FilesTouchedModel, path: string): { text: string; title: string } | null {
    const f = model.files.find((file) => file.path === path);
    if (!f) return null;
    const diffstat = f.charsAdded > 0 || f.charsRemoved > 0
        ? [
            f.charsAdded > 0 ? `+${compactChars(f.charsAdded)}` : null,
            f.charsRemoved > 0 ? `−${compactChars(f.charsRemoved)}` : null,
        ].filter(Boolean).join(" ")
        : null;
    const text = [
        diffstat ?? (f.writes > 0 ? `${f.writes}w` : f.reads > 0 ? `${f.reads}r` : null),
        f.errors > 0 ? "⚠" : null,
    ].filter(Boolean).join(" ");
    const title = [
        diffstat ? `${f.charsAdded.toLocaleString()} chars added, ${f.charsRemoved.toLocaleString()} removed` : null,
        f.writes > 0 ? `${f.writes} write call${f.writes === 1 ? "" : "s"}` : null,
        f.reads > 0 ? `${f.reads} read${f.reads === 1 ? "" : "s"}` : null,
        f.errors > 0 ? `${f.errors} failed call${f.errors === 1 ? "" : "s"}` : null,
        `first touched at turn ${f.firstSeq}`,
    ].filter(Boolean).join(" · ");
    return { text, title };
}

function FilesTouchedList({ model, onSelect }: {
    readonly model: FilesTouchedModel;
    readonly onSelect: (file: FileTouch) => void;
}) {
    return (
        <div style={{ display: "grid", gap: 4, marginTop: 8 }}>
            {model.files.map((file) => {
                const decoration = decorationFor(model, file.path);
                return (
                    <button
                        key={file.absPath}
                        type="button"
                        onClick={() => onSelect(file)}
                        title={decoration?.title}
                        style={{
                            display: "flex",
                            alignItems: "baseline",
                            gap: 8,
                            minWidth: 0,
                            padding: "5px 7px",
                            border: "1px solid var(--line)",
                            background: "var(--page)",
                            color: "var(--ink)",
                            cursor: "pointer",
                            textAlign: "left",
                            font: "11px/1.4 ui-monospace, monospace",
                        }}
                    >
                        <span style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {file.path}
                        </span>
                        {decoration?.text ? <span style={{ flex: "0 0 auto", color: "var(--muted)" }}>{decoration.text}</span> : null}
                    </button>
                );
            })}
        </div>
    );
}

function FilesTouchedTreeInner({ model, onSelect, initialSelectedPath, maxHeight = TREE_MAX_H }: {
    readonly model: FilesTouchedModel;
    /** Fired with the clicked file. The tree model is create-once; the latest
     *  callback is read through a ref so re-renders don't go stale. */
    readonly onSelect: (file: FileTouch) => void;
    readonly initialSelectedPath?: string;
    readonly maxHeight?: number;
}) {
    const onSelectRef = useRef(onSelect);
    onSelectRef.current = onSelect;
    const gitStatus = useMemo(
        (): GitStatusEntry[] =>
            model.files
                .filter((f) => f.status != null)
                .map((f) => ({ path: f.path, status: f.status as "added" | "modified" })),
        [model],
    );
    const { model: tree } = useFileTree({
        paths: model.files.map((f) => f.path),
        initialExpansion: "open",
        flattenEmptyDirectories: true,
        search: model.files.length >= 8,
        gitStatus,
        itemHeight: ROW_H,
        ...(initialSelectedPath ? { initialSelectedPaths: [initialSelectedPath] } : {}),
        renderRowDecoration: ({ row }) => (row.kind === "file" ? decorationFor(model, row.path) : null),
        onSelectionChange: (paths) => {
            const f = paths[0] ? model.files.find((file) => file.path === paths[0]) : undefined;
            if (f) onSelectRef.current(f);
        },
    });
    // Files + every distinct ancestor dir bounds the row count (flattening only
    // shrinks it) - enough to size small trees tight and cap big ones.
    const dirCount = new Set(
        model.files.flatMap((f) => {
            const segs = f.path.split("/").slice(0, -1);
            return segs.map((_, i) => segs.slice(0, i + 1).join("/"));
        }),
    ).size;
    const height = Math.min((model.files.length + dirCount) * ROW_H + 8, maxHeight);
    return (
        <FileTree
            model={tree}
            style={{ ...TREE_THEME, height, marginTop: 8, display: "block" }}
        />
    );
}

export function FilesTouchedTree(props: {
    readonly model: FilesTouchedModel;
    readonly onSelect: (file: FileTouch) => void;
    readonly initialSelectedPath?: string;
    readonly maxHeight?: number;
}) {
    if (hasFileDirectoryCollision(props.model.files.map((file) => file.path))) {
        return <FilesTouchedList model={props.model} onSelect={props.onSelect} />;
    }
    return <FilesTouchedTreeInner {...props} />;
}

/**
 * "Files touched" panel for a session transcript: every file the agent
 * read/edited/wrote, folded into one collapsible directory tree. Edited files
 * carry git-status badges (added/modified), each file row shows its
 * read/write counts, and clicking a file jumps the transcript to the first
 * turn that touched it.
 */
export function FilesTouchedPanel({ turns, onJump }: {
    readonly turns: ReadonlyArray<InspectTurnDto>;
    readonly onJump?: (seq: number) => void;
}) {
    const model = useMemo(() => buildFilesTouched(turns), [turns]);
    const [open, setOpen] = useState(() => filesTouchedStartsOpen(model.files.length));
    if (model.files.length === 0) return null;
    const jump = onJump ?? ((seq: number) => {
        window.location.hash = `turn-${seq}`;
    });
    return (
        <details
            style={PANEL_STYLE}
            open={open}
            onToggle={(event) => setOpen(event.currentTarget.open)}
        >
            <summary style={SUMMARY_STYLE}>
                {summaryLine(model)}
                {model.root ? <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}> · {model.root}</span> : null}
                <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}> - click a file to jump to where it was touched</span>
            </summary>
            {open ? <FilesTouchedTree model={model} onSelect={(f) => jump(f.firstSeq)} /> : null}
        </details>
    );
}
