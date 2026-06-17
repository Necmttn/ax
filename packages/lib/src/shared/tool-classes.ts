import { surrealString } from "./surql.ts";

// ---------------------------------------------------------------------------
// Canonical tool-name / command classification - the ONE source of truth
// consumed by all three classifiers that used to drift independently:
//
//  - ingest    (`apps/axctl/src/ingest/tool-file-evidence.ts`)  - file
//    read/search/edit evidence edges written at ingest time.
//  - timeline  (`apps/axctl/src/timeline/providers.ts`)         - unified
//    event kinds for the session timeline.
//  - metrics   (`apps/axctl/src/metrics/*`, #170)               - edit/read
//    predicates + SurrealQL filter fragments for session_metrics.
//
// Claude has dedicated Edit/Write/Read/Grep tools; Codex/Pi edit via
// `apply_patch` (as a tool name OR as the base command of an `exec_command`)
// and read/search via shell commands carried on the stored
// `tool_call.command_norm` column. Cursor uses `edit_file`/`apply_diff`.
//
// THE sed DECISION: `command_norm` stores only the base command (argv0) - no
// flags - so `sed -n '1,40p' file` (a read) and `sed -i 's/a/b/' file` (an
// in-place edit) are indistinguishable here. Paging reads dominate in
// practice, so sed is classified as a READ everywhere a metric boundary
// depends on it (cold-start reads, time-to-first-edit, session LOC, file
// evidence). The session timeline keeps sed as an edit HINT - the explicit,
// named exception `CODEX_TIMELINE_EDIT_HINT_COMMANDS` below - because there
// a false "file_edit" only over-ranks one card, while a moved metric boundary
// silently corrupts session_metrics. Do not add a third independent set.
//
// HANG SAFETY: these are pure predicates over already-fetched `tool_call`
// rows ({name, command_norm} are stored columns) - no graph derefs. The SQL
// filter fragments below are meant to be ANDed onto a `session IN [...]`
// bounded read (`tool_call_session_ts` index), never used as the sole bound.
// ---------------------------------------------------------------------------

/** Shape of the stored `tool_call` columns the predicates classify over. */
export interface ToolClassInput {
    readonly name: string;
    readonly command_norm?: string | null;
}

/**
 * Map a fetched `tool_call` row (loosely typed query result) onto the
 * {@link ToolClassInput} the predicates expect.
 */
export const toolClassInputOf = (
    row: { readonly name?: unknown; readonly command_norm?: unknown },
): ToolClassInput => ({
    name: String(row.name ?? ""),
    command_norm: typeof row.command_norm === "string" ? row.command_norm : null,
});

/** Lowercased tool names that mean "this edited a file" across providers. */
export const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set([
    "edit", "write", "multiedit", "notebookedit", // claude (+ pi/opencode lowercase)
    "apply_patch", // codex patch tool
    "edit_file", "apply_diff", // cursor
]);
/**
 * Base commands (command_norm) of a shell call that is really a file edit.
 * NOTE: sed is deliberately NOT here - see "THE sed DECISION" above.
 */
export const EDIT_COMMANDS: ReadonlySet<string> = new Set([
    "apply_patch", "tee", "patch", "dd",
]);

/** Lowercased tool names whose calls read a file's contents. */
// `read_file`/`read_file_v2` are cursor's (versioned) read tools (#162).
export const FILE_READ_TOOL_NAMES: ReadonlySet<string> = new Set(["read", "read_file", "read_file_v2"]);
/** Lowercased tool names whose calls search across files. */
// `codebase_search`/`glob_file_search` are cursor's search tools (#162).
export const FILE_SEARCH_TOOL_NAMES: ReadonlySet<string> = new Set(["grep", "glob", "codebase_search", "glob_file_search"]);
/** Read + search tool names merged (metrics treat both as "reads"). */
export const READ_TOOL_NAMES: ReadonlySet<string> = new Set([
    ...FILE_READ_TOOL_NAMES, ...FILE_SEARCH_TOOL_NAMES,
]);

/** Base commands (command_norm) of a shell call that reads a file. */
export const FILE_READ_COMMANDS: ReadonlySet<string> = new Set([
    "cat", "sed", "nl", "head", "tail", "less", // sed: see "THE sed DECISION"
]);
/** Base commands (command_norm) of a shell call that searches files. */
export const FILE_SEARCH_COMMANDS: ReadonlySet<string> = new Set([
    "rg", "grep", "git grep", "fd", "find",
]);
/** Read + search commands merged (metrics treat both as "reads"). */
export const READ_COMMANDS: ReadonlySet<string> = new Set([
    ...FILE_READ_COMMANDS, ...FILE_SEARCH_COMMANDS,
]);

/**
 * EXPLICIT NAMED EXCEPTION - timeline rendering only. The codex timeline
 * flags sed `exec_command`s as a file-edit hint (an `-i` edit is common
 * enough in codex transcripts that hiding it reads worse than over-ranking
 * a paging read). Everything metric-shaped must use {@link EDIT_COMMANDS} /
 * {@link isEditTool} instead, where sed stays a READ. Derived from
 * EDIT_COMMANDS so the two can never drift - sed is the only divergence.
 */
export const CODEX_TIMELINE_EDIT_HINT_COMMANDS: ReadonlySet<string> = new Set([
    ...EDIT_COMMANDS, "sed",
]);

/**
 * Substrings of a raw (lowercased) exec command text that indicate an
 * in-place file write - the timeline's second codex edit heuristic, applied
 * to `command_text` (full text, unlike `command_norm`).
 */
export const CODEX_EDIT_TEXT_HINTS: readonly string[] = [
    "apply_patch", "<<'eof'", "<<eof", "> /", ">> /", "tee ",
];

const norm = (value: string | null | undefined): string => value?.trim().toLowerCase() ?? "";

/** Did this tool_call edit a file? (Claude Edit/Write, codex apply_patch, shell tee/patch/dd.) */
export const isEditTool = (input: ToolClassInput): boolean =>
    EDIT_TOOL_NAMES.has(norm(input.name)) || EDIT_COMMANDS.has(norm(input.command_norm));

/**
 * Did this tool_call read or search a file? (Claude Read/Grep/Glob, shell
 * cat/sed/rg/...). Edit classification wins on the (theoretical) overlap, so
 * a call is never both.
 */
export const isReadTool = (input: ToolClassInput): boolean =>
    !isEditTool(input) &&
    (READ_TOOL_NAMES.has(norm(input.name)) || READ_COMMANDS.has(norm(input.command_norm)));

/** apply_patch carried either as the tool name (codex) or inside an exec command. */
export const isApplyPatchCall = (input: ToolClassInput): boolean =>
    norm(input.name) === "apply_patch" || norm(input.command_norm) === "apply_patch";

const CANONICAL_EDIT_NAMES: Record<string, string> = {
    edit: "Edit",
    write: "Write",
    multiedit: "MultiEdit",
    notebookedit: "NotebookEdit",
};

/**
 * Map provider-cased edit tool names ("edit", "write" from pi/opencode) onto
 * the Claude casing `editDelta` switches on. Unknown names pass through.
 */
export const canonicalEditToolName = (name: string): string =>
    CANONICAL_EDIT_NAMES[norm(name)] ?? name;

const sqlList = (values: Iterable<string>): string =>
    [...values].map((v) => surrealString(v)).join(", ");

/**
 * SurrealQL filter fragment matching edit-class tool_calls. MUST be ANDed
 * onto a `session IN [...]` bounded WHERE (see hang-safety note above).
 * `command_norm` is compared as stored (the shell tokenizer emits the literal
 * argv0, lowercase in practice); NONE never matches an IN-list.
 */
export const editToolSqlFilter: string =
    `(string::lowercase(name) IN [${sqlList(EDIT_TOOL_NAMES)}]`
    + ` OR command_norm IN [${sqlList(EDIT_COMMANDS)}])`;

/** SurrealQL filter fragment matching edit-class OR read/search-class tool_calls. */
export const editOrReadToolSqlFilter: string =
    `(string::lowercase(name) IN [${sqlList(new Set([...EDIT_TOOL_NAMES, ...READ_TOOL_NAMES]))}]`
    + ` OR command_norm IN [${sqlList(new Set([...EDIT_COMMANDS, ...READ_COMMANDS]))}])`;
