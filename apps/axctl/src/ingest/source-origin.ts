/**
 * Provider/subagent attribution on the `source` field of `session`,
 * `session_token_usage`, and `turn_token_usage`.
 *
 * Each harness writes a main-agent source (`claude`, `codex`, ...). Subagent
 * work gets a distinct `<provider>-subagent` source so it can be excluded from
 * main-agent denominators (routability, cost-split) and attributed as child
 * cost (`ax dispatches`). Claude subagents are derived from manifest files
 * (`derive-claude-subagents.ts`); Codex subagents are separate session files
 * tagged at parse from `session_meta.thread_source === "subagent"`.
 */

/** All subagent `source` values, in provider order. */
export const SUBAGENT_SOURCES = ["claude-subagent", "codex-subagent"] as const;

/** SQL list literal for `... source IN [...]` predicates. */
export const SUBAGENT_SOURCES_SQL = `['claude-subagent', 'codex-subagent']`;

/** All `source` values that count as Codex spend (main + subagent). */
export const CODEX_SOURCES_SQL = `['codex', 'codex-subagent']`;

/** True when a `source` marks subagent (sub-task) work rather than main-agent. */
export function isSubagentSource(source: string | null | undefined): boolean {
    return source === "claude-subagent" || source === "codex-subagent";
}

/** Coarse origin used by cost-split / dispatch lenses. */
export function originOfSource(source: string | null | undefined): "main" | "subagent" {
    return isSubagentSource(source) ? "subagent" : "main";
}

/**
 * The `source` for a Codex session given its `session_meta.thread_source`.
 * Codex emits `thread_source: "user"` for the main conversation and
 * `"subagent"` for spawned agents (separate session files with a
 * `parent_thread_id`).
 */
export function codexSourceForThread(threadSource: string | null | undefined): "codex" | "codex-subagent" {
    return threadSource === "subagent" ? "codex-subagent" : "codex";
}
