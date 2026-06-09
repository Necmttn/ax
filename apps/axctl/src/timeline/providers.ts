/**
 * Provider-aware event classification. The normalized `tool_call`/`turn` tables
 * are shared, but their SEMANTICS differ per harness:
 *  - claude/claude-subagent: dedicated Edit/Write tools; `Bash` carries
 *    command_norm; `invoked` is a REAL Skill-tool stream.
 *  - codex: no edit tool - edits ride inside `exec_command` (sed/tee/heredoc/
 *    apply_patch); `invoked` is a `codex:<tool>` shadow of every call (fake).
 *  - pi/opencode/cursor: `invoked` is likewise a `<provider>:<tool>` shadow.
 * So tool/edit/skill classification must be keyed on the session `source`.
 * Evidence: docs/design/session-timeline-plan.md.
 */

export type UnifiedKind = "tool" | "file_edit" | "skill" | "subagent" | "noise";
export type Importance = "high" | "med" | "low";

export interface ClassifiedTool {
    readonly kind: UnifiedKind;
    readonly importance: Importance;
}

export type ProviderSource =
    | "claude"
    | "claude-subagent"
    | "codex"
    | "pi"
    | "opencode"
    | "cursor"
    | (string & {});

const isClaudeLike = (source: ProviderSource): boolean =>
    source === "claude" || source === "claude-subagent";

/** Lowercased tool names that mean "this edited a file" across claude/pi/opencode. */
const EDIT_TOOL_NAMES = new Set([
    "edit", "write", "multiedit", "notebookedit", // claude
    "edit_file", "apply_diff", // cursor
]);
const SUBAGENT_TOOL_NAMES = new Set([
    "task", // claude / opencode
    "spawn_agent", "wait_agent", "close_agent", "resume_agent", // codex
]);
const READ_NOISE_NAMES = new Set([
    "read", "glob", "grep", "ls", "notebookread",
    "read_file", "read_file_v2", "glob_file_search", "codebase_search", "list_dir",
    "view_image",
]);
const SHELL_EXEC_NAMES = new Set([
    "bash", "exec_command", "run_terminal_command", "run_terminal_command_v2",
]);
const META_NAMES = new Set([
    "todowrite", "taskcreate", "taskupdate", "taskstop", "exitplanmode",
    "update_plan", "get_goal", "update_goal", "create_goal", "write_stdin", "send_input",
]);

/** Base command (command_norm) of a codex `exec_command` that is really a file edit. */
const CODEX_EDIT_COMMANDS = new Set(["sed", "tee", "patch", "dd", "apply_patch"]);
/** Substrings in an exec command that indicate an in-place file write. */
const CODEX_EDIT_HINTS = ["apply_patch", "<<'eof'", "<<eof", "> /", ">> /", "tee "];

export interface ClassifyInput {
    readonly name: string;
    readonly command_norm: string | null;
    /** Raw command / input text, used only for codex exec edit detection. */
    readonly command_text: string | null;
}

/** Map one tool_call to a unified kind + importance, given the session source. */
export function classifyTool(source: ProviderSource, t: ClassifyInput): ClassifiedTool {
    const lname = t.name.toLowerCase();

    if (SUBAGENT_TOOL_NAMES.has(lname)) return { kind: "subagent", importance: "high" };
    if (EDIT_TOOL_NAMES.has(lname)) return { kind: "file_edit", importance: "high" };

    // codex/pi/opencode/cursor edit through the shell - inspect the command.
    if (SHELL_EXEC_NAMES.has(lname)) {
        const cmd = (t.command_norm ?? "").toLowerCase();
        const text = (t.command_text ?? "").toLowerCase();
        const isEdit =
            CODEX_EDIT_COMMANDS.has(cmd) ||
            CODEX_EDIT_HINTS.some((h) => text.includes(h));
        return isEdit ? { kind: "file_edit", importance: "high" } : { kind: "tool", importance: "high" };
    }

    if (READ_NOISE_NAMES.has(lname)) return { kind: "noise", importance: "low" };
    if (lname === "skill") return { kind: "skill", importance: "high" };
    if (META_NAMES.has(lname)) return { kind: "tool", importance: "med" };
    if (lname.startsWith("mcp__")) return { kind: "tool", importance: "med" };

    // unknown tool: surface it, but low importance so ranking can drop it.
    return { kind: "tool", importance: "low" };
}

/**
 * Whether an `invoked` skill row is a REAL skill. Only claude/claude-subagent
 * have genuine Skill-tool invocations; the others emit a `<provider>:<tool>`
 * shadow 1:1 with every tool call, which must be ignored.
 */
export function isRealSkill(source: ProviderSource, skillName: string): boolean {
    if (!isClaudeLike(source)) return false;
    return skillName.length > 0;
}
