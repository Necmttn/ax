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
    /**
     * Markers the harness writes to stand in for an ATTACHMENT (an image, a
     * pasted file). A turn whose excerpt is ONLY these markers is `context`:
     * nobody typed a word of it.
     *
     * This rule cannot be a prefix, which is exactly why it needs its own
     * field. `[Image: source: /path.png]` is machine text, but
     * `[Image #1] why is it gigantic?` is a HUMAN message that merely REFERENCES
     * an attachment - both start with `[Image`, so a prefix rule would have to
     * either keep both or drop both. The test has to be "is there anything left
     * after the markers are removed", and a length cutoff is NOT a substitute:
     * three stacked `[Image: source: ...]` markers come to 208 characters and
     * walk straight through any threshold set to catch one.
     */
    readonly attachmentMarkers: readonly RegExp[];
}

/**
 * True when `excerpt` contains at least one attachment marker and NOTHING else
 * but markers and whitespace.
 *
 * The "at least one" half is load-bearing: without it an empty excerpt strips
 * to an empty string and would be reported as marker-only, silently moving
 * every empty user turn from `task` to `context`.
 */
function isOnlyAttachmentMarkers(excerpt: string, markers: readonly RegExp[]): boolean {
    let matched = false;
    let rest = excerpt;
    for (const marker of markers) {
        // Callers hand us plain literals; re-create with `g` so a stray lastIndex
        // on a shared RegExp object can never make this stateful.
        const global = new RegExp(marker.source, "g");
        if (global.test(rest)) matched = true;
        rest = rest.replace(new RegExp(marker.source, "g"), "");
    }
    return matched && rest.trim() === "";
}

/**
 * Classify a user-turn excerpt into control / context / task.
 *
 *   - startsWith any `control` prefix  → "control"
 *   - else startsWith any `contextStartsWith` OR includes any `contextIncludes`
 *     → "context"
 *   - else only-attachment-markers → "context"
 *   - else "task"
 *
 * A null/empty excerpt is "task" (matches the pre-toolkit `textExcerpt?.` /
 * `textExcerpt && (...)` guards exactly).
 *
 * WHAT `task` MEANS, AND WHY THE TABLES BELOW GREW. `task` is the kind every
 * "what did the human ask for" surface keys off - the run-evidence `objective`,
 * directive mining, prompt search. It was measured on a real 1,355-row store
 * and 582 of those rows (43%) were machine text: `<task-notification>` blocks,
 * plugin adverts, interrupt markers, bare image markers. That is not a cosmetic
 * miscount - 18 of 395 sessions had their `ax runs evidence` OBJECTIVE reported
 * as a `<task-notification>` instead of the thing the human actually asked for.
 * A shape that reaches this function without a rule does not error; it is
 * reported as something a person typed. Add the rule.
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
    if (isOnlyAttachmentMarkers(excerpt, rules.attachmentMarkers)) return "context";
    return "task";
}

/**
 * `[Image: source: /path.png]` and `[Image: original 1290x2796, displayed at
 * 923x2000. ...]` - the two shapes Claude Code writes for an attached image.
 * The `:` is the whole discriminator against the human `[Image #1]` form.
 */
export const IMAGE_ATTACHMENT_MARKERS: readonly RegExp[] = [/\[Image: [^\]]*\]/];

/**
 * claude ≡ codex context table - proven byte-identical pre-refactor
 * (transcripts.ts 213-227 ≡ codex.ts 156-169).
 */
export const FULL_CONTEXT_RULES: UserTextRules = {
    // `control` is a user CONTROL ACTION recorded as a user turn - they invoked
    // a slash command, or they interrupted the run. It is not injected context,
    // and it is not something they asked for in words.
    // `<command-message>` is the PAIRED half of `<command-name>` - Claude Code
    // writes both for one slash-command invocation, and which one comes first
    // varies, so classifying only `<command-name>` catches the shape only when
    // it happens to lead. Found by diffing this classifier against an
    // independent implementation of the same filter: 3 rows, and the only real
    // disagreement between them.
    control: ["<command-name>", "<command-message>", "[Request interrupted"],
    contextStartsWith: [
        "# AGENTS.md instructions",
        "# CLAUDE.md",
        "<local-command-caveat>",
        "Base directory for this skill:",
        "Base directory for this plugin:",
        // Harness-injected blocks, each measured landing on a `task` turn on a
        // real store. Counts at the time of the fix, over 1,355 `task` rows:
        "<task-notification>", //     392 - by far the largest single leak
        "[SYSTEM NOTIFICATION", //     15
        "<recommended_plugins>", //    13
        "<user_action>", //             3
        "Stop hook feedback:", //       3
        "<skill name=", //              1 - auto-loaded skill body, not a request
        // `<command-name>` is already `control`; `<local-command-stdout>` and
        // friends are the OUTPUT of one, so they are context. The existing
        // `<local-command-caveat>` prefix above covers only the caveat.
        "<local-command-stdout>",
        "<local-command-stderr>",
        // A prefix rule needs per-harness EVIDENCE, not just "same class of
        // injection": it can misfire on human text that merely starts the same
        // way (e.g. `<env> should this element be renamed?` is a real
        // question). Prefixes that measured zero rows on the store were
        // removed here for exactly that false-positive risk with no measured
        // benefit - re-add each WITH evidence when the shape actually appears.
    ],
    contextIncludes: ["<environment_context>", "<INSTRUCTIONS>"],
    attachmentMarkers: IMAGE_ATTACHMENT_MARKERS,
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
    // The injection prefixes added to FULL_CONTEXT_RULES are deliberately NOT
    // mirrored here - they were measured on Claude/Codex transcripts and pi's
    // narrower table stays narrow per the note above.
    //
    // `attachmentMarkers` IS shared, and the asymmetry is the point: a prefix
    // rule can misfire on human text that merely happens to start the same way,
    // so it needs per-harness evidence. This rule cannot - it fires only when
    // the turn is nothing BUT markers, so there is no typed sentence it can
    // swallow in any harness.
    attachmentMarkers: IMAGE_ATTACHMENT_MARKERS,
};
