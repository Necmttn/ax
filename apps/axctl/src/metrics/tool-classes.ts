import { surrealString } from "@ax/lib/shared/surql";

// ---------------------------------------------------------------------------
// Multi-provider tool-call classification for metrics (#170).
//
// Claude has dedicated Edit/Write/Read/Grep tools; Codex/Pi edit via
// `apply_patch` (as a tool name OR as the base command of an `exec_command`)
// and read/search via shell commands (`sed`, `rg`, ... carried on the stored
// `tool_call.command_norm` column). The classification here mirrors the
// file-evidence classifier the ingest pipeline already applies
// (`ingest/tool-file-evidence.ts` - READ/SEARCH names + commands) plus the
// timeline's codex shell-edit detection (`timeline/providers.ts`).
// `tool-classes.test.ts` cross-checks the read sets against
// `classifyToolFileEvidence` so the two cannot drift silently.
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

/** Lowercased tool names that mean "this edited a file" across providers. */
const EDIT_TOOL_NAMES = new Set([
    "edit", "write", "multiedit", "notebookedit", // claude (+ pi/opencode lowercase)
    "apply_patch", // codex patch tool
    "edit_file", "apply_diff", // cursor
]);
/** Base commands (command_norm) of a shell call that is really a file edit. */
const EDIT_COMMANDS = new Set(["apply_patch", "tee", "patch", "dd"]);

/** Lowercased tool names that mean "this read/searched a file". */
const READ_TOOL_NAMES = new Set(["read", "grep", "glob"]);
/** Base commands (command_norm) of a shell call that reads/searches files. */
const READ_COMMANDS = new Set([
    "cat", "sed", "nl", "head", "tail", "less", // reads
    "rg", "grep", "git grep", "fd", "find", // searches
]);

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
