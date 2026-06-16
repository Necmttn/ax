/**
 * User-turn message-kind classification - the ONE genuinely shared slice of
 * the per-parser `messageKind` functions.
 *
 * Role dispatch (tool_result detection, system/developer handling, assistant,
 * itemType fallthrough) is DELIBERATELY NOT folded here: it is genuinely
 * divergent across the 5 parsers (claude = tool_result-from-blocks; codex =
 * itemType function_call → tool_call; pi/opencode/cursor = role-string; claude
 * does not special-case system/developer while the others do). Each parser
 * keeps its own role-dispatch branch and calls `classifyUserText` ONLY for the
 * user branch.
 *
 * "config is data": the rule tables are exported constants, not Effect/Schema.
 */

export interface UserTextRules {
    /** Excerpt prefixes that mark a `control` turn (highest precedence). */
    readonly control: readonly string[];
    /** Excerpt prefixes that mark a `context` turn. */
    readonly contextStartsWith: readonly string[];
    /** Substrings anywhere in the excerpt that mark a `context` turn. */
    readonly contextIncludes: readonly string[];
}

/**
 * Classify a user-turn excerpt into control / context / task.
 *
 *   - startsWith any `control` prefix  → "control"
 *   - else startsWith any `contextStartsWith` OR includes any `contextIncludes`
 *     → "context"
 *   - else "task"
 *
 * A null/empty excerpt is "task" (matches the pre-toolkit `textExcerpt?.` /
 * `textExcerpt && (...)` guards exactly).
 */
export function classifyUserText(
    excerpt: string | null,
    rules: UserTextRules,
): "control" | "context" | "task" {
    if (excerpt === null) return "task";
    if (rules.control.some((prefix) => excerpt.startsWith(prefix))) return "control";
    if (
        rules.contextStartsWith.some((prefix) => excerpt.startsWith(prefix)) ||
        rules.contextIncludes.some((needle) => excerpt.includes(needle))
    ) {
        return "context";
    }
    return "task";
}

/**
 * claude ≡ codex context table - proven byte-identical pre-refactor
 * (transcripts.ts 213-227 ≡ codex.ts 156-169).
 */
export const FULL_CONTEXT_RULES: UserTextRules = {
    control: ["<command-name>"],
    contextStartsWith: [
        "# AGENTS.md instructions",
        "# CLAUDE.md",
        "<local-command-caveat>",
        "Base directory for this skill:",
        "Base directory for this plugin:",
    ],
    contextIncludes: ["<environment_context>", "<INSTRUCTIONS>"],
};

/**
 * pi context table - a STRICT SUBSET of {@link FULL_CONTEXT_RULES} that omits 3
 * startsWith prefixes (`<local-command-caveat>`, the two `Base directory for
 * this skill:/plugin:`). This narrower table is PRESERVED as-is - whether it is
 * intentional or stale drift is an open domain-owner question (see PR notes);
 * collapsing it to one shared table would change pi's classification behavior
 * and is a deferred follow-up.
 */
export const PI_CONTEXT_RULES: UserTextRules = {
    control: ["<command-name>"],
    contextStartsWith: ["# AGENTS.md instructions", "# CLAUDE.md"],
    contextIncludes: ["<environment_context>", "<INSTRUCTIONS>"],
};
