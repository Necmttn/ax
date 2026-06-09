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
    /** L2 segment this event belongs to (assigned during assembly). */
    readonly segment_id?: string;
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

/** Boundary signal that opened an L2 segment. */
export type SegmentBoundary = "session_start" | "ask" | "commit" | "compaction" | "time_gap";

/** L2 - a phase/iteration of the session. Carries FULL rollup counts even when
 *  L1 events were capped, so nothing is silently hidden. */
export interface TimelineSegment {
    readonly id: string;
    readonly index: number;
    readonly title: string;
    readonly boundary: SegmentBoundary;
    readonly start_seq: number | null;
    readonly end_seq: number | null;
    readonly started_at: string;
    readonly ended_at: string | null;
    readonly duration_ms: number | null;
    /** Full counts for everything that happened in the span (pre-cap). */
    readonly rollup: {
        readonly tool_calls: number;
        readonly file_edits: number;
        readonly files: number;
        readonly failures: number;
        readonly recovered: number;
        readonly skills: number;
        readonly decisions: number;
        readonly checkpoints: number;
        readonly corrections: number;
    };
    /** Total events in the span before L1 capping. */
    readonly event_count: number;
}

export interface SessionTimeline {
    readonly session_id: string;
    readonly highlights: SessionHighlights;
    /** L2 spine - always complete (one per phase/iteration). */
    readonly segments: ReadonlyArray<TimelineSegment>;
    /** L1 - the important events, ascending by ts, capped per segment + globally.
     *  Each carries `segment_id`. Full counts live on the segment rollups. */
    readonly events: ReadonlyArray<TimelineEvent>;
}
