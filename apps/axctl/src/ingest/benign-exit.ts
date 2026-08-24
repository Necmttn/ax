/**
 * "Did this nonzero exit actually mean failure?" - the single source of truth
 * for the ONE case a raw exit code lies about (#1022).
 *
 * `rg`/`grep`/`find`/`fd` exit 1 for "no matches", a legitimate, expected
 * outcome of a search that ran fine. Codex routes almost all shell activity
 * through one `exec_command` tool, so its parser stamps `tool_call.has_error`
 * from the exit code alone and that single tool name absorbs thousands of these
 * benign misses - inflating `ax insights friction` / `ax insights tools` by an
 * order of magnitude. `tool_call.has_error` stays the raw fact (the process DID
 * exit nonzero); this predicate is what the DERIVED surfaces
 * (friction_event/diagnostic_event, the insights failure views, command_outcome
 * `search_miss`) consult so they don't count a no-match as a failure.
 *
 * Inputs are pre-joined, lowercased strings so the two callers
 * (`classifyCommandOutcome`, `isFailedToolCall`) feed exactly what they already
 * have and the regexes are defined once.
 */

const SEARCH_TOOL_RE = /\b(rg|grep|find|fd)\b/;
const NO_MATCH_RE = /no matches|not found|0 results/;

/**
 * @param command  the command string (`command_norm` [+ `command_text`]), lowercased
 * @param exitCode the process exit code, or null when unknown
 * @param evidence  combined output/error text, lowercased
 */
export const isBenignSearchMiss = (
    command: string,
    exitCode: number | null | undefined,
    evidence: string,
): boolean => {
    if (!SEARCH_TOOL_RE.test(command)) return false;
    return exitCode === 1 || NO_MATCH_RE.test(evidence);
};
