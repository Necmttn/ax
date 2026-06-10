import type { InspectTurnDto, ToolCallDto } from "@ax/lib/shared/dashboard-types";

/** Aggregated activity on one file across a session's tool calls. */
export interface FileTouch {
    /** Display path - relative to the model's common root. */
    readonly path: string;
    /** Original (absolute) path as it appeared in tool inputs. */
    readonly absPath: string;
    readonly reads: number;
    readonly writes: number;
    readonly errors: number;
    /** Turn seq of the first call touching this file - the jump target. */
    readonly firstSeq: number;
    readonly lastSeq: number;
    /** Pierre-trees git status to badge the row with; null = read-only. */
    readonly status: "added" | "modified" | null;
}

export interface FilesTouchedModel {
    /** Common directory prefix stripped from every display path ("" if none). */
    readonly root: string;
    /** One entry per file, in first-touch order. */
    readonly files: ReadonlyArray<FileTouch>;
    readonly totalReads: number;
    readonly totalWrites: number;
}

/** file-path-carrying tools → which input keys hold the path + op kind. */
const FILE_TOOLS: Record<string, { keys: ReadonlyArray<string>; op: "read" | "write" }> = {
    Read: { keys: ["file_path", "path"], op: "read" },
    Write: { keys: ["file_path", "path"], op: "write" },
    Edit: { keys: ["file_path", "path"], op: "write" },
    MultiEdit: { keys: ["file_path", "path"], op: "write" },
    NotebookEdit: { keys: ["notebook_path", "file_path"], op: "write" },
};

function pathOf(call: ToolCallDto, keys: ReadonlyArray<string>): string | null {
    if (!call.input) return null;
    for (const k of keys) {
        const v = call.input[k];
        if (typeof v === "string" && v.length > 0) return v;
    }
    return null;
}

/** Longest common directory prefix (whole segments) across the given paths.
 *  Returns "" when there is a single path (its parent dir would swallow the
 *  whole tree) or when paths share nothing past the filesystem root. */
export function commonDirPrefix(paths: ReadonlyArray<string>): string {
    if (paths.length < 2) return "";
    const split = paths.map((p) => p.split("/").slice(0, -1));
    let prefix = split[0] ?? [];
    for (const segs of split.slice(1)) {
        let i = 0;
        while (i < prefix.length && i < segs.length && prefix[i] === segs[i]) i++;
        prefix = prefix.slice(0, i);
        if (prefix.length === 0) break;
    }
    const joined = prefix.join("/");
    // A bare "" (absolute paths diverging at /) or "/" prefix strips nothing useful.
    return joined === "" || joined === "/" ? "" : joined;
}

interface MutableTouch {
    absPath: string;
    reads: number;
    writes: number;
    errors: number;
    firstSeq: number;
    lastSeq: number;
    firstWriteTool: string | null;
}

/**
 * Fold a session's turns into per-file activity. A file first touched by a
 * full-file `Write` reads as created ("added"); any other written file is
 * "modified"; read-only files carry no status badge. Display paths are
 * relative to the common directory prefix so the tree starts at the project,
 * not the filesystem root.
 */
export function buildFilesTouched(turns: ReadonlyArray<InspectTurnDto>): FilesTouchedModel {
    const byPath = new Map<string, MutableTouch>();
    for (const turn of turns) {
        for (const call of turn.tool_calls ?? []) {
            const spec = FILE_TOOLS[call.name];
            if (!spec) continue;
            const abs = pathOf(call, spec.keys);
            if (!abs) continue;
            let touch = byPath.get(abs);
            if (!touch) {
                touch = { absPath: abs, reads: 0, writes: 0, errors: 0, firstSeq: turn.seq, lastSeq: turn.seq, firstWriteTool: null };
                byPath.set(abs, touch);
            }
            if (spec.op === "read") touch.reads++;
            else {
                touch.writes++;
                if (touch.firstWriteTool == null) {
                    // A Write with prior reads is an overwrite, not a creation.
                    touch.firstWriteTool = call.name === "Write" && touch.reads > 0 ? "Edit" : call.name;
                }
            }
            if (call.has_error) touch.errors++;
            touch.lastSeq = turn.seq;
        }
    }
    const touches = [...byPath.values()];
    const root = commonDirPrefix(touches.map((t) => t.absPath));
    const strip = root.length > 0 ? root.length + 1 : 0;
    const files = touches.map((t): FileTouch => ({
        path: (strip > 0 ? t.absPath.slice(strip) : t.absPath).replace(/^\//, ""),
        absPath: t.absPath,
        reads: t.reads,
        writes: t.writes,
        errors: t.errors,
        firstSeq: t.firstSeq,
        lastSeq: t.lastSeq,
        status: t.writes === 0 ? null : t.firstWriteTool === "Write" ? "added" : "modified",
    }));
    return {
        root,
        files,
        totalReads: files.reduce((acc, f) => acc + f.reads, 0),
        totalWrites: files.reduce((acc, f) => acc + f.writes, 0),
    };
}
