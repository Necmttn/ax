/**
 * Session timeline - the "highlight" zoom level between the raw transcript and
 * the one-line summary. An ordered stream of *important* events (not every
 * turn) plus session-level highlights, all derived from already-ingested data
 * with NO LLM inference. See `derive.ts` for the rules and `service.ts` for the
 * Effect service that feeds a session id and returns this shape.
 */

export type TimelineEventKind =
    | "decision" // a plan/choice the agent stated (plan_snapshot)
    | "tool_call" // a notable tool run
    | "file_edit" // a file created/modified
    | "skill_invocation" // a skill was invoked
    | "failure" // a tool error / something broke
    | "correction" // the user redirected the agent
    | "checkpoint" // a milestone (commit, tests green)
    | "outcome"; // the end result (raw last-assistant text; LLM seam for a gloss)

export type TimelineRefType = "turn" | "file" | "tool" | "skill" | "subagent" | "commit";

export interface TimelineRef {
    readonly type: TimelineRefType;
    readonly id: string;
}

export interface TimelineEvent {
    readonly kind: TimelineEventKind;
    /** ISO timestamp; the primary ordering key. */
    readonly ts: string;
    /** Anchor turn seq (for `#turn-N` linking); null when not turn-anchored. */
    readonly seq: number | null;
    /** One-line, human-readable. Raw data (command/path/error) - never LLM-authored. */
    readonly title: string;
    /** Optional secondary line (output excerpt, error text, commit message…). */
    readonly detail?: string;
    readonly status?: "ok" | "error";
    /** Cross-links into the raw transcript / artifacts. */
    readonly refs: ReadonlyArray<TimelineRef>;
    /**
     * For `failure` events: the seq of the event that RESOLVED it (heuristic,
     * LLM-free). Null when no recovery was found within the window.
     */
    readonly recovered_by_seq?: number | null;
}

export interface SessionHighlights {
    readonly started_at: string | null;
    readonly ended_at: string | null;
    readonly duration_ms: number | null;
    readonly model: string | null;
    readonly project: string | null;
    readonly repository: string | null;
    readonly turns: number;
    readonly user_turns: number;
    readonly assistant_turns: number;
    readonly tool_calls: number;
    readonly tool_errors: number;
    readonly files_changed: number;
    readonly skills_used: number;
    readonly corrections: number;
    readonly interruptions: number;
    readonly cost_usd: number | null;
    readonly estimated_tokens: number | null;
    /** Count of each event kind actually surfaced in `events`. */
    readonly event_counts: Readonly<Record<TimelineEventKind, number>>;
}

export interface SessionTimeline {
    readonly session_id: string;
    readonly highlights: SessionHighlights;
    /** Important events, ascending by ts. */
    readonly events: ReadonlyArray<TimelineEvent>;
}
