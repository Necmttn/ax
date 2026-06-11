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
    /** Chars added/removed across this file's edits - Edit counts
     *  new_string/old_string, Write counts content as added (the replaced
     *  previous content is unknowable from the call alone). */
    readonly charsAdded: number;
    readonly charsRemoved: number;
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
    charsAdded: number;
    charsRemoved: number;
    firstSeq: number;
    lastSeq: number;
    firstWriteTool: string | null;
}

const strLen = (v: unknown): number => (typeof v === "string" ? v.length : 0);

/** Char delta of one write call. Edit/MultiEdit replace old with new; Write
 *  and NotebookEdit supply whole new content with no old side on the call. */
function charDelta(call: ToolCallDto): { added: number; removed: number } {
    const input = call.input ?? {};
    if (call.name === "Edit") {
        return { added: strLen(input.new_string), removed: strLen(input.old_string) };
    }
    if (call.name === "MultiEdit" && Array.isArray(input.edits)) {
        let added = 0;
        let removed = 0;
        for (const e of input.edits) {
            if (typeof e === "object" && e !== null) {
                added += strLen((e as Record<string, unknown>).new_string);
                removed += strLen((e as Record<string, unknown>).old_string);
            }
        }
        return { added, removed };
    }
    if (call.name === "NotebookEdit") {
        return { added: strLen(input.new_source), removed: 0 };
    }
    return { added: strLen(input.content), removed: 0 };
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
                touch = {
                    absPath: abs,
                    reads: 0,
                    writes: 0,
                    errors: 0,
                    charsAdded: 0,
                    charsRemoved: 0,
                    firstSeq: turn.seq,
                    lastSeq: turn.seq,
                    firstWriteTool: null,
                };
                byPath.set(abs, touch);
            }
            if (spec.op === "read") touch.reads++;
            else {
                touch.writes++;
                if (!call.has_error) {
                    // A failed edit changed nothing - only count applied deltas.
                    const delta = charDelta(call);
                    touch.charsAdded += delta.added;
                    touch.charsRemoved += delta.removed;
                }
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
        charsAdded: t.charsAdded,
        charsRemoved: t.charsRemoved,
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

// --- per-file change story (review view) ------------------------------------

/** One touch of a file, in session order. Write-ops carry the hunk content;
 *  reads are kept as thin markers so the story shows when the agent looked
 *  before it leapt. */
export interface FileStoryEvent {
    readonly turnSeq: number;
    readonly callIndex: number;
    readonly tool: string;
    readonly op: "read" | "write";
    /** Replaced text (Edit/MultiEdit). null for Write/NotebookEdit/reads. */
    readonly oldString: string | null;
    /** Inserted text (Edit new_string, Write content, NotebookEdit new_source). */
    readonly newString: string | null;
    readonly hasError: boolean;
}

/**
 * Synthesize a unified-diff patch for one replace-block hunk so a real diff
 * renderer (@pierre/diffs) can draw it. Line numbers are synthetic - tool
 * calls carry fragments, not file offsets - so the renderer should hide them.
 */
export function buildHunkPatch(path: string, oldString: string | null, newString: string | null): string {
    const oldLines = oldString ? oldString.split("\n") : [];
    const newLines = newString ? newString.split("\n") : [];
    const header = `@@ -${oldLines.length === 0 ? "0,0" : `1,${oldLines.length}`} +${newLines.length === 0 ? "0,0" : `1,${newLines.length}`} @@`;
    const body = [
        ...oldLines.map((l) => `-${l}`),
        ...newLines.map((l) => `+${l}`),
    ].join("\n");
    return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${header}\n${body}\n`;
}

/**
 * The ordered change story of one file: every tool call that touched
 * `absPath`, expanded so a MultiEdit contributes one event per inner edit.
 */
export function buildFileStory(turns: ReadonlyArray<InspectTurnDto>, absPath: string): FileStoryEvent[] {
    const events: FileStoryEvent[] = [];
    for (const turn of turns) {
        (turn.tool_calls ?? []).forEach((call, callIndex) => {
            const spec = FILE_TOOLS[call.name];
            if (!spec || pathOf(call, spec.keys) !== absPath) return;
            const base = { turnSeq: turn.seq, callIndex, tool: call.name, hasError: call.has_error };
            if (spec.op === "read") {
                events.push({ ...base, op: "read", oldString: null, newString: null });
                return;
            }
            const input = call.input ?? {};
            if (call.name === "MultiEdit" && Array.isArray(input.edits)) {
                for (const e of input.edits) {
                    const edit = typeof e === "object" && e !== null ? (e as Record<string, unknown>) : {};
                    events.push({
                        ...base,
                        op: "write",
                        oldString: typeof edit.old_string === "string" ? edit.old_string : null,
                        newString: typeof edit.new_string === "string" ? edit.new_string : null,
                    });
                }
                return;
            }
            events.push({
                ...base,
                op: "write",
                oldString: typeof input.old_string === "string" ? input.old_string : null,
                newString: typeof input.new_string === "string"
                    ? input.new_string
                    : typeof input.content === "string"
                    ? input.content
                    : typeof input.new_source === "string"
                    ? input.new_source
                    : null,
            });
        });
    }
    return events;
}
