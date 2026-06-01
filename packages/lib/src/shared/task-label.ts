/**
 * Shared seam for deriving a session's human-readable task label.
 *
 * A "task label" is the first organic-task user turn excerpt for a session -
 * the line that tells a human what the session was actually about. It used to
 * be computed per-row inside the graph-explorer `FILE_ATTENTION_SQL`, which
 * meant ~13 correlated `turn`-table subqueries per result row (see GitHub
 * issue #77). It is now precomputed once per session during the
 * `session-health` ingest stage and stored on `session_health.task_label`.
 *
 * The boilerplate-marker list below is the single source of truth: both the
 * ingest derivation and any remaining query reference must use it so the
 * filter never drifts. Markers are matched case-insensitively against the
 * lowercased excerpt (callers lowercase once).
 */

/**
 * Lowercased substrings that mark a user turn as wrapper/boilerplate rather
 * than an organic task. A turn whose lowercased `text_excerpt` contains ANY of
 * these is skipped when picking the task label.
 *
 * This list MUST stay in sync with the `string::lowercase(...) CONTAINS ...`
 * filters that previously lived inline in `FILE_ATTENTION_SQL`.
 */
export const TASK_LABEL_BOILERPLATE_MARKERS: ReadonlyArray<string> = [
    "<local-command",
    "base directory for this skill:",
    "base directory for this plugin:",
    "<environment_context>",
    "<instructions>",
    "# agents.md instructions",
    "# claude.md",
    "review all changed files for reuse",
    "session-scoped stop hook",
    "this session is being continued",
];

/**
 * `intent_kind` values that count as an organic, human-authored task for the
 * tier-1 task-label pick. Tier 2 drops this filter.
 */
export const TASK_LABEL_ORGANIC_INTENTS: ReadonlyArray<string> = [
    "organic_task",
    "preference",
    "correction",
];

/** A turn shape sufficient to pick a task label. */
export interface TaskLabelTurn {
    readonly role?: string | null;
    readonly seq?: number | null;
    readonly message_kind?: string | null;
    readonly intent_kind?: string | null;
    readonly text_excerpt?: string | null;
}

const isBoilerplate = (excerpt: string): boolean => {
    const lower = excerpt.toLowerCase();
    return TASK_LABEL_BOILERPLATE_MARKERS.some((marker) => lower.includes(marker));
};

const isOrganicTaskTurn = (turn: TaskLabelTurn): boolean =>
    turn.role === "user" &&
    turn.message_kind === "task" &&
    typeof turn.text_excerpt === "string" &&
    turn.text_excerpt.length > 0 &&
    !isBoilerplate(turn.text_excerpt);

/**
 * Pick the task label for a session from its turns. Mirrors the two-tier
 * fallback that previously lived in `FILE_ATTENTION_SQL`:
 *
 *  - tier 1: first `role="user" AND message_kind="task"` turn whose
 *    `intent_kind` is organic and whose excerpt is non-empty / non-boilerplate,
 *    ordered by `seq ASC`.
 *  - tier 2: same, without the `intent_kind` filter.
 *
 * Returns `null` when no qualifying turn exists; callers fall back to
 * `session.project` then the session id.
 */
export function deriveTaskLabel(turns: ReadonlyArray<TaskLabelTurn>): string | null {
    const bySeq = [...turns].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    for (const turn of bySeq) {
        if (isOrganicTaskTurn(turn) && TASK_LABEL_ORGANIC_INTENTS.includes(turn.intent_kind ?? "")) {
            return (turn.text_excerpt as string).trim() || null;
        }
    }
    for (const turn of bySeq) {
        if (isOrganicTaskTurn(turn)) {
            return (turn.text_excerpt as string).trim() || null;
        }
    }
    return null;
}
