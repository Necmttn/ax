/**
 * hook-block-text: recover BLOCKED hook fires from Claude Code tool-result text.
 *
 * Why this exists (#743). ax used to learn about hook fires from exactly two
 * transcript shapes, both written by the harness as structured records:
 *
 *   - `data.type === "hook_progress"`   (streamed progress lines)
 *   - `attachment.type === "hook_success" | "hook_blocking_error"
 *      | "hook_additional_context"`     (terminal outcome attachments)
 *
 * Current Claude Code (2.1.x) emits NEITHER `hook_progress` NOR
 * `hook_blocking_error`. A hook that BLOCKS a tool call is recorded only as the
 * text of the tool_result the model receives:
 *
 *   PreToolUse:Bash hook error: [bun ~/.ax/hooks/enforce-worktree.ts # ax:74da7418]: BLOCKED: ...
 *
 * and (redundantly) on the entry's `toolUseResult` string. `hook_success`
 * attachments, meanwhile, appear only when the hook actually PRODUCED output.
 * The combination makes the most consequential guard shape - silent on pass,
 * blocking on fail - completely invisible in the graph: `ax hooks summary`
 * showed zero rows for guards the transcripts prove fired dozens of times.
 *
 * So this module parses that one line shape back into structured fires. It is
 * pure and string-in/values-out on purpose: the transcript parser owns keys,
 * upserts and dedupe (a text-derived fire and an attachment-derived fire for
 * the same (event, command) collapse onto the same invocation key).
 *
 * Scope is deliberately narrow: ONLY the `<Event>[:<Tool>] hook error: [<cmd>]:`
 * prefix. Non-blocking silent fires remain unobservable - the harness does not
 * write them anywhere, and inventing them would be fabrication, not recovery.
 */

/** Hook events Claude Code can name in a `... hook error:` line. */
const HOOK_EVENT_NAMES = [
    "PreToolUse",
    "PostToolUse",
    "UserPromptSubmit",
    "Stop",
    "SubagentStop",
    "SessionStart",
    "SessionEnd",
    "PreCompact",
    "Notification",
] as const;

export type HookBlockEventName = (typeof HOOK_EVENT_NAMES)[number];

/**
 * `PreToolUse:Bash hook error: [<command>]: ` - the whole prefix, with the
 * command captured. Tool suffix is optional (session-scoped events carry none).
 * The command is bounded to one line so a runaway `]`-free message can never
 * swallow the rest of the transcript.
 */
const HOOK_ERROR_RE = new RegExp(
    String.raw`(${HOOK_EVENT_NAMES.join("|")})(?::([A-Za-z_][\w.-]*))? hook error: \[([^\]\n]+)\]:`,
    "g",
);

/** One blocked hook fire recovered from tool-result text. */
export interface HookBlockFire {
    /** Harness event, e.g. "PreToolUse". */
    readonly eventName: HookBlockEventName;
    /** Tool the matcher fired on, e.g. "Bash"; null for session-scoped events. */
    readonly tool: string | null;
    /** `<event>:<tool>` when a tool is named, else `<event>` - matches the
     *  `hook_name` granularity the attachment path already writes. */
    readonly hookName: string;
    /** The hook command exactly as the harness printed it. */
    readonly command: string;
    /** Everything the hook said after the prefix, trimmed; "" when it said nothing. */
    readonly message: string;
}

/**
 * Extract every blocked-hook fire named in one tool-result text.
 *
 * Multiple hooks can block the same call, in which case the harness
 * concatenates their lines; each match's message runs to the start of the next
 * match (or to the end of the text).
 *
 * Returns `[]` for text that names no hook - the common case, so the cheap
 * `includes` pre-check keeps this off the hot path for ordinary tool output.
 */
export const parseHookBlocksFromText = (
    text: string | null | undefined,
): ReadonlyArray<HookBlockFire> => {
    if (!text || !text.includes(" hook error: [")) return [];
    const fires: HookBlockFire[] = [];
    const matches = [...text.matchAll(HOOK_ERROR_RE)];
    for (const [index, match] of matches.entries()) {
        const eventName = match[1] as HookBlockEventName | undefined;
        const command = match[3];
        if (!eventName || !command) continue;
        const tool = match[2] ?? null;
        const start = (match.index ?? 0) + match[0].length;
        const end = matches[index + 1]?.index ?? text.length;
        fires.push({
            eventName,
            tool,
            hookName: tool ? `${eventName}:${tool}` : eventName,
            command,
            message: text.slice(start, end).trim(),
        });
    }
    return fires;
};
