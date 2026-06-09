/**
 * Wire-format types shared between the dashboard server (Bun.serve) and the
 * dashboard SPA. Keep these stable - both sides depend on them.
 */

import type { SessionId } from "./session-id.ts";

export type { SessionId } from "./session-id.ts";

export type TriageDecision = "keep" | "archive" | "review";

export interface SkillRow {
    readonly name: string;
    readonly scope: string;
    readonly description: string | null;
    readonly dir_path: string | null;
    readonly bytes: number | null;
    readonly total_inv: number;
    readonly inv_7d: number;
    readonly inv_30d: number;
    readonly last_used: string | null;
    readonly last_project: string | null;
    readonly corrections: number;
    readonly proposals: number;
    readonly commits_after: number;
    readonly taste_score: number;
}

export interface SkillTriageNote {
    readonly skill_name: string;
    readonly decision: TriageDecision;
    readonly reason: string | null;
    readonly decided_at: string;
}

export interface SkillTriageEntry extends SkillRow {
    /** Suggested action based on the score breakdown. */
    readonly recommendation: TriageDecision;
    /** One-line why for the recommendation. */
    readonly recommendation_reason: string;
    /** User's saved decision, if any. */
    readonly decision: SkillTriageNote | null;
}

export interface SkillTriageResponse {
    readonly generatedAt: string;
    readonly skills: ReadonlyArray<SkillTriageEntry>;
}

export interface SkillRecentInvocation {
    readonly ts: string;
    readonly project: string | null;
    readonly turn_has_error?: boolean;
}

export interface SkillProposalEvidence {
    readonly ts: string;
    readonly project: string | null;
    readonly context_excerpt?: string | null;
}

export interface SkillPair {
    readonly partner: string;
    readonly count: number;
    readonly last_seen: string | null;
}

export interface SkillDetailPayload {
    readonly name: string;
    readonly scope: string | null;
    readonly description: string | null;
    readonly dir_path: string | null;
    readonly invocations: {
        readonly total: number;
        readonly d7: number;
        readonly d30: number;
        readonly last: string | null;
    };
    readonly recent: ReadonlyArray<SkillRecentInvocation>;
    readonly corrections: ReadonlyArray<SkillRecentInvocation>;
    readonly proposals: ReadonlyArray<SkillProposalEvidence>;
    readonly paired: ReadonlyArray<SkillPair>;
}

/** On-disk state of a skill's SKILL.md file.
 *  - `active`   - SKILL.md present; the agent harness loads it.
 *  - `disabled` - renamed to SKILL.md.archived; harness skips it (reversible).
 *  - `missing`  - no on-disk file (plugin synthetic, codex tool, stale path). */
export type SkillSourceState = "active" | "disabled" | "missing";

/** Wire format for `GET /api/skills/:name/source` - the skill's SKILL.md
 *  content plus whether ax may rewrite it on disk. */
export interface SkillSourcePayload {
    readonly name: string;
    readonly scope: string;
    readonly dir_path: string | null;
    /** Absolute path to SKILL.md (or the .archived variant when disabled). */
    readonly file_path: string | null;
    /** Raw YAML frontmatter text (between the `---` fences), if any. */
    readonly frontmatter: string | null;
    /** Markdown body after the frontmatter. */
    readonly body: string | null;
    readonly state: SkillSourceState;
    /** True when ax may disable/restore this skill on disk - user-owned
     *  scopes only. Plugin/builtin/codex skills are read-only. */
    readonly editable: boolean;
    /** Set when the file existed but could not be read. */
    readonly error: string | null;
}

// ---------------------------------------------------------------------------
// Tool failure view
// ---------------------------------------------------------------------------

export type ToolFailureRecommendation = "fix" | "watch" | "ignore";

export interface ToolFailureRow {
    readonly label: string;
    readonly failure_count: number;
    readonly last_seen: string | null;
    readonly last_error_text: string | null;
    readonly last_project: string | null;
    readonly distinct_sessions: number;
    readonly total_calls: number;
    readonly failure_rate: number;
    readonly exit_codes: ReadonlyArray<number>;
}

export interface ToolFailureEntry extends ToolFailureRow {
    readonly recommendation: ToolFailureRecommendation;
    readonly recommendation_reason: string;
}

export interface ToolFailuresResponse {
    readonly generatedAt: string;
    readonly failures: ReadonlyArray<ToolFailureEntry>;
}

export interface ToolFailureSample {
    readonly ts: string;
    readonly exit_code: number | null;
    readonly error_text: string | null;
    readonly output_excerpt: string | null;
    readonly command_text: string | null;
    readonly project: string | null;
    readonly session_id: SessionId | null;
    readonly cwd: string | null;
}

export interface ToolFailureDetailPayload {
    readonly label: string;
    readonly samples: ReadonlyArray<ToolFailureSample>;
}

// ---------------------------------------------------------------------------
// Workflow view: how does my work look this week, and is it converging?
// ---------------------------------------------------------------------------

export interface WorkflowWeekBucket {
    readonly week: string;          // ISO 8601 year-week, e.g. "2026-W19"
    readonly counts: ReadonlyArray<{ readonly label: string; readonly count: number }>;
}

export interface WorkflowConvergencePoint {
    readonly week: string;
    /** Jaccard similarity vs prior week's top-K set, 0..1. null for first week. */
    readonly jaccard: number | null;
    readonly topK: ReadonlyArray<string>;
    readonly newcomers: ReadonlyArray<string>;
    readonly dropouts: ReadonlyArray<string>;
}

export interface WorkflowSessionShape {
    readonly week: string;
    readonly session_count: number;
}

export interface SessionShapeAggregate {
    /** Compressed phase sequence, e.g. "P→E→R→M". */
    readonly shape: string;
    /** Phase letters as an array, e.g. ["P","E","R","M"]. */
    readonly phases: ReadonlyArray<"plan" | "execute" | "review" | "merge">;
    readonly session_count: number;
    readonly example_session_ids: ReadonlyArray<SessionId>;
}

export interface SessionOverview {
    readonly id: SessionId;
    readonly project: string | null;
    readonly cwd: string | null;
    readonly model: string | null;
    readonly source: "claude" | "codex" | string;
    readonly started_at: string | null;
    readonly ended_at: string | null;
}

export interface SessionTopSkill {
    readonly skill: string;
    readonly count: number;
    readonly last_used: string | null;
}

export interface SessionToolCall {
    readonly label: string;
    readonly count: number;
    readonly failures: number;
    readonly last_used: string | null;
}

export interface SessionLink {
    readonly session_id: SessionId;
    readonly project: string | null;
    readonly started_at: string | null;
    readonly nickname: string | null;
    readonly tool: string | null;
    readonly ts: string | null;
}

export interface SessionAgentDelegation {
    readonly id: string;
    readonly ts: string;
    readonly subagent_type: string | null;
    readonly description: string | null;
    readonly prompt_excerpt: string | null;
    readonly output_excerpt: string | null;
    readonly phase: "plan" | "execute" | "review" | "merge" | "other";
}

export interface SessionTokenUsageDetail {
    readonly model: string | null;
    readonly prompt_tokens: number | null;
    readonly completion_tokens: number | null;
    readonly cache_creation_input_tokens: number | null;
    readonly cache_read_input_tokens: number | null;
    readonly estimated_tokens: number;
    readonly estimated_input_cost_usd?: number | null;
    readonly estimated_output_cost_usd?: number | null;
    readonly estimated_cache_creation_cost_usd?: number | null;
    readonly estimated_cache_read_cost_usd?: number | null;
    readonly estimated_cost_usd: number | null;
    readonly pricing_source: string | null;
}

export interface TurnTokenUsageDetail extends SessionTokenUsageDetail {
    readonly seq: number;
    readonly fresh_input_tokens: number | null;
    readonly usage_source: string;
    readonly usage_quality: string;
}

export interface SessionDetailPayload {
    readonly overview: SessionOverview | null;
    readonly top_skills: ReadonlyArray<SessionTopSkill>;
    readonly tool_calls: ReadonlyArray<SessionToolCall>;
    readonly children: ReadonlyArray<SessionLink>;
    readonly parent: SessionLink | null;
    readonly agent_delegations: ReadonlyArray<SessionAgentDelegation>;
    readonly token_usage: SessionTokenUsageDetail | null;
}

// ---------------------------------------------------------------------------
// Multi-session compare view (swimlane P0 - summary metrics)
// ---------------------------------------------------------------------------

/** Per-session health aggregate read from the `session_health` table. The
 *  noise axis (tool_errors + user_corrections + interruptions) is the
 *  "cleaner" signal the compare view ranks on. */
export interface SessionHealthSummary {
    readonly turns: number;
    readonly tool_calls: number;
    readonly tool_errors: number;
    readonly user_corrections: number;
    readonly interruptions: number;
    readonly subagent_dispatches: number;
    readonly task_label: string | null;
}

/** One turn in a session's timeline, with the per-turn trifecta attached.
 *  Only populated when the compare is requested with per-turn detail (P1). */
export interface SessionCompareTurn {
    readonly seq: number;
    readonly role: string | null;
    readonly ts: string | null;
    /** Wall-clock gap to the previous turn, ms. Null for the first turn or when
     *  a timestamp is missing. NOT model latency - transcripts carry no request
     *  duration. */
    readonly gap_ms: number | null;
    readonly est_tokens: number | null;
    readonly est_cost_usd: number | null;
    readonly has_error: boolean;
}

export interface SessionCompareEntry {
    readonly session_id: SessionId;
    readonly source: "claude" | "codex" | string;
    readonly model: string | null;
    readonly project: string | null;
    readonly started_at: string | null;
    readonly ended_at: string | null;
    /** ended_at - started_at, ms. Null when either bound is missing. This is
     *  wall-clock, NOT model latency (transcripts carry no request duration). */
    readonly duration_ms: number | null;
    readonly token_usage: SessionTokenUsageDetail | null;
    readonly health: SessionHealthSummary | null;
    /** Count of `produced` edges (session → commit). */
    readonly commit_count: number;
    /** tool_errors + user_corrections + interruptions. Null if no health row. */
    readonly noise_score: number | null;
    /** Per-turn timeline, ordered by seq. Present only when per-turn detail was
     *  requested; undefined in the summary-only (P0) payload. */
    readonly turns?: ReadonlyArray<SessionCompareTurn>;
}

/** Winning session id per axis. Null when undecidable (no data, or a tie). */
export interface SessionCompareWinners {
    readonly fastest: SessionId | null;
    readonly cheapest: SessionId | null;
    readonly fewest_tokens: SessionId | null;
    readonly cleanest: SessionId | null;
}

export interface SessionComparePayload {
    /** Shared task_label when every compared session agrees; null otherwise. */
    readonly task_label: string | null;
    readonly sessions: ReadonlyArray<SessionCompareEntry>;
    readonly winners: SessionCompareWinners;
    /** Requested ids that failed to validate or resolve to a session. */
    readonly not_found: ReadonlyArray<string>;
}

export interface SessionSkillRoleGroup {
    readonly role: string | null;
    readonly skills: ReadonlyArray<{ readonly skill: string; readonly count: number }>;
}

/** One context-compaction boundary recorded for a session. Sourced from the
 *  `compaction` table; one row per compaction event across all harnesses. */
export interface SessionCompaction {
    readonly harness: string;
    readonly ts: string;
    readonly strategy: string;
    readonly trigger: string | null;
    readonly tokens_before: number | null;
    readonly kept_count: number | null;
    readonly summary: string | null;
}

export interface SessionViewPayload {
    readonly session: SessionDetailPayload;
    readonly expanded_subagents: ReadonlyArray<SessionDetailPayload>;
    readonly by_role: ReadonlyArray<SessionSkillRoleGroup> | null;
    readonly compactions: ReadonlyArray<SessionCompaction>;
}

export interface WorkflowEpisode {
    readonly parent_session_id: SessionId;
    readonly project: string | null;
    readonly started_at: string | null;
    readonly child_count: number;
    readonly distinct_nicknames: number;
}

export interface EpisodeNode {
    readonly session_id: SessionId;
    readonly role: "parent" | "child";
    readonly project: string | null;
    readonly source: string | null;
    readonly started_at: string | null;
    readonly ended_at: string | null;
    readonly duration_ms: number | null;
    readonly phase: "plan" | "execute" | "review" | "merge" | "other" | "mixed";
    readonly top_skills: ReadonlyArray<{ readonly skill: string; readonly count: number }>;
    readonly invocation_count: number;
}

export interface EpisodeTimelinePayload {
    readonly parent_session_id: SessionId;
    readonly project: string | null;
    readonly started_at: string | null;
    readonly ended_at: string | null;
    readonly duration_ms: number | null;
    readonly node_count: number;
    readonly nodes: ReadonlyArray<EpisodeNode>;
    readonly shape: string;
}

export interface EpisodeShapeAggregate {
    readonly shape: string;
    readonly phases: ReadonlyArray<"plan" | "execute" | "review" | "merge">;
    readonly episode_count: number;
    readonly example_parent_ids: ReadonlyArray<SessionId>;
    readonly avg_children: number;
}

export interface WorkflowResponse {
    readonly generatedAt: string;
    readonly weeksLookback: number;
    readonly topK: number;
    readonly skills: ReadonlyArray<WorkflowWeekBucket>;
    readonly tools: ReadonlyArray<WorkflowWeekBucket>;
    readonly sessionShape: ReadonlyArray<WorkflowSessionShape>;
    readonly convergence: ReadonlyArray<WorkflowConvergencePoint>;
    readonly shapes: ReadonlyArray<SessionShapeAggregate>;
    readonly shapesTotal: number;
    readonly episodes: ReadonlyArray<WorkflowEpisode>;
    readonly episode_shapes: ReadonlyArray<EpisodeShapeAggregate>;
    readonly episode_shapes_total: number;
    readonly narrative: string;
}

export interface ProjectTopSkill {
    readonly skill: string;
    readonly count: number;
    readonly last_used: string | null;
}

export interface ProjectFailure {
    readonly label: string;
    readonly failure_count: number;
    readonly distinct_sessions: number;
    readonly last_seen: string | null;
}

export interface ProjectRecentSession {
    readonly session_id: SessionId;
    readonly source: string | null;
    readonly started_at: string | null;
    readonly ended_at: string | null;
    readonly model: string | null;
}

export interface ProjectEpisode {
    readonly parent_session_id: SessionId;
    readonly started_at: string | null;
    readonly child_count: number;
    readonly distinct_nicknames: number;
}

export interface ProjectPagePayload {
    readonly project: string;
    readonly session_count: number;
    readonly first_session_at: string | null;
    readonly last_session_at: string | null;
    readonly sources: ReadonlyArray<{ readonly source: string; readonly count: number }>;
    readonly top_skills: ReadonlyArray<ProjectTopSkill>;
    readonly failures: ReadonlyArray<ProjectFailure>;
    readonly recent_sessions: ReadonlyArray<ProjectRecentSession>;
    readonly top_episodes: ReadonlyArray<ProjectEpisode>;
}

export interface SkillGraphNode {
    readonly name: string;
    readonly weight: number;
    readonly last_seen: string | null;
}

export interface SkillGraphEdge {
    readonly source: string;
    readonly target: string;
    readonly count: number;
    readonly last_seen: string | null;
}

export interface SkillGraphPayload {
    readonly min_count: number;
    readonly limit: number;
    readonly node_count: number;
    readonly edge_count: number;
    readonly max_edge_count: number;
    readonly nodes: ReadonlyArray<SkillGraphNode>;
    readonly edges: ReadonlyArray<SkillGraphEdge>;
}

export type GraphExplorerMode =
    | "skill-pairs"
    | "file-attention"
    | "ask-outcome"
    | "phase-balance"
    | "delivery"
    | "patterns";

export type GraphNodeKind =
    | "skill"
    | "file"
    | "session"
    | "message"
    | "commit"
    | "pull_request"
    | "pattern"
    | "phase";

export type GraphPanelKind = "summary" | "evidence" | "timeline" | "pattern";

export type GraphMetricValue = string | number | boolean | null;

export interface GraphExplorerNode {
    readonly id: string;
    readonly label: string;
    readonly kind: GraphNodeKind;
    readonly weight: number;
    readonly tone: string;
    readonly subtitle?: string;
    readonly metrics?: Readonly<Record<string, GraphMetricValue>>;
}

export interface GraphExplorerEdge {
    readonly source: string;
    readonly target: string;
    readonly relation: string;
    readonly weight: number;
    readonly tone: string;
    readonly dashed?: boolean;
    readonly label?: string;
    readonly metrics?: Readonly<Record<string, GraphMetricValue>>;
}

export interface GraphExplorerPanel {
    readonly title: string;
    readonly kind: GraphPanelKind;
    readonly rows: ReadonlyArray<{
        readonly label: string;
        readonly value: string;
        readonly detail?: string;
    }>;
}

export interface GraphExplorerStoryCard {
    readonly session_id: string;
    readonly title: string;
    readonly project: string | null;
    readonly outcome_status: string;
    readonly delivery_status: string | null;
    readonly review_pain: string | null;
    readonly pr_size: string | null;
    readonly pr_title: string | null;
    readonly files_touched: number;
    readonly top_files: ReadonlyArray<string>;
    readonly produced_commits: number;
    readonly merged_to_main: boolean;
    readonly duration_ms: number | null;
    readonly hands_free_ms: number | null;
    readonly user_turns: number;
    readonly assistant_turns: number;
    readonly corrections: number;
    readonly interruptions: number;
    readonly why_score: number;
    readonly why_reason: string;
}

export interface GraphExplorerPayload {
    readonly generatedAt: string;
    readonly mode: GraphExplorerMode;
    readonly query: string | null;
    readonly nodes: ReadonlyArray<GraphExplorerNode>;
    readonly edges: ReadonlyArray<GraphExplorerEdge>;
    readonly story_cards: ReadonlyArray<GraphExplorerStoryCard>;
    readonly panels: ReadonlyArray<GraphExplorerPanel>;
    readonly warnings: ReadonlyArray<string>;
}

// ==== Session Canvas (infinite-canvas, semantic-zoom session lineage) ====
// Nodes = sessions; edges = spawn lineage (parent -> subagent). `size` is the
// session's visual weight = context-token volume (session_token_usage.
// estimated_tokens) - the real "how much context did this burn" signal,
// cross-provider. `turns` (conversational user+assistant turns) is kept as a
// secondary display number. `epochs` = compaction count (1 = no compaction);
// `compactions` carries the preTokens at each boundary for epoch notches.
export interface SessionCanvasNode {
    readonly id: string;
    readonly label: string;
    readonly project: string | null;
    readonly source: string;            // 'claude' | 'codex' | ...
    readonly started_at: string | null;
    readonly ended_at: string | null;
    readonly size: number;              // context tokens (estimated_tokens)
    readonly turns: number;             // conversational (user+assistant) turns
    readonly epochs: number;            // compaction epochs (1 = uncompacted)
    readonly compactions: ReadonlyArray<{ pre_tokens: number; trigger: string }>;
    readonly context_pressure: string;  // 'low' | 'medium' | 'high' | 'unknown'
    readonly corrections: number;
    readonly tone: string;              // success | warning | neutral
    readonly is_subagent: boolean;
    readonly subagent_count: number;    // direct children spawned by this session
    // Fractions [0..1] of the session's [started_at, ended_at] during which the
    // main agent was blocked waiting on a subagent (merged child intervals).
    // Drives the swimlane pill's inline work/wait rail.
    readonly wait_segments: ReadonlyArray<{ readonly start: number; readonly end: number }>;
}

// Per-session orchestration drill-in: the main rail + every subagent it spawned,
// with real timing so the UI can show fan-out / parallel / sequential + wait%.
export interface SessionOrchestrationSubagent {
    readonly id: string;
    readonly nickname: string | null;
    readonly task: string | null;       // the subagent's first user turn = what it was asked to do
    readonly started_at: string | null;
    readonly ended_at: string | null;
    readonly tone: string;              // quick | long (by duration) | unknown
    readonly duration_ms: number | null;
}

// Lightweight session summary for the canvas detail card. DB-ONLY (no
// transcript file read/parse) so it returns in ~ms instead of the 20-60s the
// full inspect endpoint can take when it has to walk the filesystem to locate
// a transcript. Same facts the card shows - no data loss.
export interface SessionSummary {
    readonly session_id: string;
    readonly task: string | null;          // first user turn (what it was asked)
    readonly first_ask: string | null;
    readonly last_assistant: string | null;
    readonly correction: string | null;
    readonly turns: number;                // conversational (user+assistant)
    readonly tokens: number | null;
    readonly cost_usd: number | null;
    readonly model: string | null;
    readonly subagents: number;
    readonly tools: ReadonlyArray<{ readonly name: string; readonly count: number }>;
}

export interface SessionOrchestration {
    readonly session_id: string;
    readonly label: string;
    readonly started_at: string | null;
    readonly ended_at: string | null;
    readonly wait_pct: number;          // 0..1 share of session blocked on subagents
    readonly subagents: ReadonlyArray<SessionOrchestrationSubagent>;
}

export interface SessionCanvasEdge {
    readonly source: string;
    readonly target: string;
    readonly relation: string;          // 'spawned'
    readonly label: string | null;      // subagent nickname when present
}

export interface SessionCanvasPayload {
    readonly generatedAt: string;
    readonly nodes: ReadonlyArray<SessionCanvasNode>;
    readonly edges: ReadonlyArray<SessionCanvasEdge>;
    readonly warnings: ReadonlyArray<string>;
}

export interface RecallHit {
    readonly turn_id: string;
    readonly session_id: SessionId;
    readonly project: string | null;
    readonly source: string | null;
    readonly role: string | null;
    readonly ts: string | null;
    readonly snippet: string;
}

export interface RecallCommitHit {
    readonly commit_id: string;     // record id
    readonly sha: string;
    readonly repo: string | null;   // stable repo key (repo field on commit)
    readonly repository: string | null; // record id of repository node, if linked
    readonly ts: string | null;
    readonly snippet: string;       // commit message (highlighted)
    readonly score: number;
}

export interface RecallSkillHit {
    readonly skill_id: string;
    readonly name: string;
    readonly description: string | null;
    readonly snippet: string;       // matched portion
    readonly score: number;
}

export interface RecallResponse {
    readonly q: string;
    readonly hits: ReadonlyArray<RecallHit>;     // turns, unchanged
    readonly commits: ReadonlyArray<RecallCommitHit>;  // empty when not requested
    readonly skills: ReadonlyArray<RecallSkillHit>;    // empty when not requested
    /** Back-compat: true when more results exist beyond what was returned in
     *  any source - turns have more pages, OR commit/skill results were
     *  limit-capped. */
    readonly truncated: boolean;
    /** Sum of matched records across ALL requested sources (turn + commit +
     *  skill). When only turns are requested this equals the turn count
     *  (back-compat). Per-source breakdown is in `total_counts`. */
    readonly total_count: number;
    /** Per-source total counts. */
    readonly total_counts: {
        readonly turn: number;
        readonly commit: number;
        readonly skill: number;
    };
    /** The slice that was returned (applies to turns). */
    readonly window: { readonly offset: number; readonly limit: number };
}

// ---------------------------------------------------------------------------
// Agent Wrapped: personality-led usage recap
// ---------------------------------------------------------------------------

export type WrappedConfidence = "low" | "medium" | "high";
export type WrappedSensitivity = "public" | "aggregate" | "sensitive";

export interface WrappedPeriod {
    readonly label: string;
    readonly startedAt: string;
    readonly endedAt: string;
}

export interface WrappedEvidence {
    readonly kind: "session" | "tool" | "skill" | "project" | "query" | "insight";
    readonly label: string;
    readonly href?: string;
    readonly count?: number;
    readonly sensitive?: boolean;
}

export interface WrappedArchetype {
    readonly id: string;
    readonly label: string;
    readonly score: number;
    readonly confidence: WrappedConfidence;
    readonly publicLine: string;
    readonly internalExplanation: string;
    readonly evidence: ReadonlyArray<WrappedEvidence>;
}

export interface WrappedFact {
    readonly id: string;
    readonly title: string;
    readonly publicText: string;
    readonly internalText: string;
    readonly sensitivity: WrappedSensitivity;
    readonly evidence: ReadonlyArray<WrappedEvidence>;
}

export interface WrappedUsageDay {
    readonly date: string;
    readonly sessions: number;
    readonly turns: number;
    readonly tokens: number | null;
}

export interface WrappedUsageOverview {
    readonly sessions: number;
    readonly messages: number;
    readonly totalTokens: number | null;
    readonly activeDays: number;
    readonly currentStreakDays: number;
    readonly longestStreakDays: number;
    readonly peakHour: number | null;
    readonly favoriteModel: string | null;
    readonly tokenComparison: string | null;
    readonly days: ReadonlyArray<WrappedUsageDay>;
}

export interface WrappedMetrics {
    readonly toolCalls: number;
    readonly toolFailures: number;
    readonly distinctTools: number;
    readonly distinctSkills: number;
    readonly repositories: number;
    readonly verificationCalls: number;
    readonly spawnedAgents: number;
}

export interface WrappedPrivacySummary {
    readonly publicSafe: boolean;
    readonly redactedFields: ReadonlyArray<string>;
}

export interface WrappedProfile {
    readonly generatedAt: string;
    readonly period: WrappedPeriod;
    readonly usage: WrappedUsageOverview;
    readonly primaryArchetype: WrappedArchetype;
    readonly secondaryArchetypes: ReadonlyArray<WrappedArchetype>;
    readonly facts: ReadonlyArray<WrappedFact>;
    readonly metrics: WrappedMetrics;
    readonly privacy: WrappedPrivacySummary;
}

export interface IngestEvent {
    readonly id?: string;
    readonly run?: string;
    readonly source: string;
    readonly stage: string;
    readonly level: "info" | "warn" | "error" | string;
    readonly message: string;
    readonly counts?: Record<string, number> | null;
    readonly raw?: unknown;
    readonly ts: string;
}

export interface SessionListRow {
    readonly id: SessionId;
    readonly project: string | null;
    readonly source: string;
    readonly cwd: string | null;
    readonly model: string | null;
    readonly started_at: string | null;
    readonly ended_at: string | null;
    /** True when a raw transcript pointer exists (session is inspectable). */
    readonly has_raw_file: boolean;
    readonly turn_count: number;
    /** Parent session id when this row was spawned by another session (e.g. a
     *  Claude subagent / Codex agent). Null for top-level sessions. Always
     *  null on rows returned from `/api/sessions` (roots-only). Populated on
     *  rows returned from `/api/sessions/:id/children`. */
    readonly parent_session: SessionId | null;
    /** Count of direct children (subagents) this session spawned. Used by the
     *  SPA to render an expand toggle without first fetching children. Only
     *  populated on roots returned from `/api/sessions`. */
    readonly direct_children_count?: number;
}

export interface SessionListResponse {
    /** Root sessions only - those with no inbound `spawned` edge. To get a
     *  root's children, call `/api/sessions/:id/children`. */
    readonly sessions: ReadonlyArray<SessionListRow>;
    /** Total root count for the active filter set (independent of window). */
    readonly total_count: number;
    /** The slice that was returned. Stays pinned to the first page on the
     *  SPA side when subsequent pages are appended to the same cache key. */
    readonly window: { readonly offset: number; readonly limit: number };
}

export interface SessionChildrenResponse {
    readonly parent_session: SessionId;
    readonly children: ReadonlyArray<SessionListRow>;
}

/** Session inspector: dissected turns with semantic span labels.
 *  Wire format for the `/api/sessions/:id/inspect` endpoint and the
 *  `/sessions/:id/inspect` SPA route. */
export type InspectSpanKind =
    | "user_input"
    | "assistant_text"
    | "tool_use"
    | "skill_context"
    | "system_context"
    | "wrapper_instruction"
    | "hook_injection"
    | "tool_result"
    | "subagent_notification"
    | "subagent_task"
    | "pasted_reference";

export interface InspectSpanDto {
    readonly kind: InspectSpanKind;
    readonly text: string;
    readonly label?: string;
}

export interface InspectContentAtomDto {
    readonly kind: string;
    readonly value: string;
    readonly normalized: string | null;
    readonly confidence: number;
    readonly raw: unknown;
}

export interface InspectContentBlockDto {
    readonly seq: number;
    readonly parent_seq: number | null;
    readonly kind: string;
    readonly role: string | null;
    readonly heading: string | null;
    readonly text: string | null;
    readonly text_excerpt: string | null;
    readonly start_offset: number | null;
    readonly end_offset: number | null;
    readonly confidence: number;
    readonly atoms: ReadonlyArray<InspectContentAtomDto>;
}

export interface InspectTurnContentDto {
    readonly document_id: string;
    readonly parser_id: string;
    readonly parser_version: string;
    readonly blockset_hash: string | null;
    readonly blocks: ReadonlyArray<InspectContentBlockDto>;
}

export type ToolCategory = "net" | "file" | "edit" | "sh" | "search" | "agent" | "other";

/** A single tool invocation surfaced in a transcript turn. Carries the RAW
 *  structured input so the renderer (not the producer) decides preview vs.
 *  expand - the presentation is never baked at the source. */
export interface ToolCallDto {
    readonly seq: number;
    readonly name: string;
    readonly category: ToolCategory;
    /** Raw structured args. null for shell-style tools whose only arg is `command`. */
    readonly input: Record<string, unknown> | null;
    /** Shell-style fallback (Bash etc.) when there is no structured input. */
    readonly command: string | null;
    readonly output_excerpt: string | null;
    readonly has_error: boolean;
    readonly tokens: number | null;
}

export interface InspectTurnDto {
    /** Sequence within session, 0-indexed in JSONL message order. */
    readonly seq: number;
    /** JSONL framing role: 'user' | 'assistant'. */
    readonly role: string;
    /** Dominant span kind - what the content actually IS, regardless of framing. */
    readonly semantic_role: InspectSpanKind;
    readonly ts: string | null;
    readonly char_count: number;
    /** Canonical turn text that parser offsets are anchored to. */
    readonly raw_text?: string;
    readonly spans: ReadonlyArray<InspectSpanDto>;
    readonly token_usage?: TurnTokenUsageDetail | null;
    readonly content?: InspectTurnContentDto | null;
    readonly tool_calls?: ReadonlyArray<ToolCallDto>;
}

export interface SpawnMeta {
    /** 'codex' | 'claude'. */
    readonly provider: string;
    /** codex: explorer | implementer | ... · claude: subagent_type. */
    readonly agent_type: string | null;
    /** codex spawn_agent flag. */
    readonly fork_context: boolean | null;
    /** codex: low | medium | high. */
    readonly reasoning_effort: string | null;
    /** First ~200 chars of the brief / prompt the parent sent in. */
    readonly brief: string | null;
}

export interface SpawnedChild {
    readonly session_id: SessionId;
    readonly ts: string | null;
    readonly tool: string | null;       // 'spawn_agent' | 'Task' | ...
    readonly nickname: string | null;
    /** Sequence of the parent turn that fired this spawn (best-effort match
     *  by ts proximity). Null if no matching turn within the session. */
    readonly anchor_turn_seq: number | null;
    /** Args extracted from the parent's tool_use call. Null if we couldn't
     *  match the call (e.g. spawn happened off-JSONL or args weren't parseable). */
    readonly meta: SpawnMeta | null;
    /** Subagent run metrics, resolved from the child session's normalized
     *  records. All nullable: a failed/missing stats query degrades to null so
     *  the inspector still renders the marker (just without the metric row). */
    readonly turns: number | null;
    readonly tool_calls: number | null;
    readonly est_tokens: number | null;
    readonly cost_usd: number | null;
    readonly duration_ms: number | null;
}

/** A single PreToolUse hook decision row, surfaced alongside turns so the
 *  inspector can show where ax contributed context vs stayed silent.
 *
 *  These rows are NOT in the JSONL transcript - they come from the
 *  `hook_fire` SurrealDB table and are spliced into the turn stream client-
 *  side, positioned by ts immediately BEFORE the tool call they gated. */
export interface HookFireDto {
    /** Per-payload monotonic index, used for stable DOM ids on the SPA side. */
    readonly idx: number;
    readonly ts: string;
    /** pre-edit | read | write | search | unknown */
    readonly event: string;
    readonly file_path: string;
    /** True when ax actually injected an `<ax_file_memory>` block into the
     *  agent's context (the next assistant turn saw it). */
    readonly inject: boolean;
    /** high_signal | suppressed_path | no_prior_sessions | low_signal_only | no_files */
    readonly reason: string;
    readonly latency_ms: number;
    /** Clipped titles of the prior sessions whose memory landed in the
     *  context. Empty when inject=false. */
    readonly injected_titles: ReadonlyArray<string>;
}

export interface SessionInspectPayload {
    readonly session_id: SessionId;
    readonly source_path: string;
    /** Canonical project key for this session (post git-stage canonicalization),
     *  or null when the session never linked to a repository. The SPA labels it
     *  via `sessionProjectLabel(project, cwd)`. */
    readonly project: string | null;
    /** Working directory the session ran in - the inspect header's fallback
     *  label when `project` is absent or points at a bare container dir. */
    readonly cwd: string | null;
    readonly total_chars: number;
    /** All-session totals across every turn, NOT just the returned slice. */
    readonly totals_by_kind: Partial<Record<InspectSpanKind, number>>;
    /** Real session-level provider token/cost totals when ingested. Per-turn
     *  and per-block cost attribution in the SPA is estimated from this. */
    readonly token_usage: SessionTokenUsageDetail | null;
    /** Total number of turns in the session (the returned `turns` slice may
     *  be a window - see `turn_window`). */
    readonly total_turns: number;
    /** The window of turns included in this response. */
    readonly turn_window: { readonly offset: number; readonly limit: number };
    readonly turns: ReadonlyArray<InspectTurnDto>;
    /** Parent session id when this session was spawned by another (codex
     *  spawn_agent, claude Task). Null for top-level sessions. */
    readonly parent_session: SessionId | null;
    /** Codex assigns short names like "Pauli", "Turing" to spawned subagents. */
    readonly parent_nickname: string | null;
    /** Subagents this session spawned, in order. Empty for leaf sessions. */
    readonly children: ReadonlyArray<SpawnedChild>;
    /** PreToolUse hook decisions whose ts falls within the loaded turn
     *  window's ts range. Server pre-filters by window so the SPA can splice
     *  them inline without an extra round-trip. Each fire's `idx` is stable
     *  within this payload and unique across pages (server uses the row's
     *  ts-ordered position in the whole session). */
    readonly hook_fires: ReadonlyArray<HookFireDto>;
    /** Total hook_fire rows across the whole session (independent of the
     *  loaded window). Lets the SPA show "23 hook decisions in this session"
     *  even when only a page worth has shipped. */
    readonly total_hook_fires: number;
}

// ============================================================================
// Experiment loop (/improve route) - see
// docs/superpowers/plans/2026-05-25-experiment-loop-cleanup-and-rebuild.md
// ============================================================================

export type ProposalForm = "skill" | "subagent" | "hook" | "guidance" | "automation";
export type ProposalStatus = "open" | "accepted" | "rejected" | "superseded";
// New session-based kinds (+3s | +10s | +30s) per issue #83.
// Legacy day-based kinds (t+7 | t+30 | t+90) remain valid for historical rows.
export type CheckpointKindDto = "+3s" | "+10s" | "+30s" | "t+7" | "t+30" | "t+90";
export type CheckpointVerdictDto =
    | "adopted"
    | "ignored"
    | "regressed"
    | "no_longer_needed"
    | "partial";

export interface SkillProposalPayload {
    readonly trigger_pattern: string;
    readonly suspected_gap: string;
    readonly proposed_behavior: string;
    readonly expected_impact: string | null;
}

export interface SubagentProposalPayload {
    readonly bounded_role: string;
    readonly delegation_trigger: string;
    readonly example_task_patterns: ReadonlyArray<string>;
}

export interface HookProposalPayload {
    readonly event_name: string;
    readonly target_tool: string | null;
    readonly hook_command: string;
    readonly recovery_path: string | null;
    readonly smoke_test_command: string | null;
    readonly disable_command: string | null;
    readonly failure_mode: string | null;
}

export interface GuidanceProposalPayload {
    readonly file_target: string;
    readonly section: string | null;
    readonly suggested_text: string;
}

export interface AutomationProposalPayload {
    readonly trigger_signal: string;
    readonly schedule: string | null;
    readonly action: string;
    readonly recovery_path: string | null;
    readonly smoke_test_command: string | null;
    readonly disable_command: string | null;
    readonly failure_mode: string | null;
}

export interface CheckpointSnapshotDto {
    readonly kind: CheckpointKindDto | string;
    readonly suggested: CheckpointVerdictDto | string | null;
    readonly user_verdict: CheckpointVerdictDto | string | null;
    readonly measured: {
        readonly opportunities: number;
        readonly addressed: number;
        readonly ratio: number;
        readonly built: boolean;
    } | null;
    readonly observed_at: string;
}

export type ExperimentStatus =
    | "task_emitted"
    | "scaffolded"
    | "regressed"
    | "retired";

export interface ExperimentDto {
    readonly id: string;
    readonly artifact_path: string | null;
    readonly status: ExperimentStatus | string | null;
    readonly task_path: string | null;
    readonly locked_verdict: CheckpointVerdictDto | string | null;
    readonly created_at: string;
    readonly scaffolded_at: string | null;
    readonly latest_checkpoint: CheckpointSnapshotDto | null;
}

export interface ProposalDto {
    readonly id: string;
    readonly form: ProposalForm | string;
    readonly title: string;
    readonly hypothesis: string;
    readonly dedupe_sig: string;
    readonly frequency: number;
    readonly confidence: string;
    readonly status: ProposalStatus | string;
    readonly reject_reason: string | null;
    readonly created_at: string;
    readonly skill_payload?: SkillProposalPayload | null;
    readonly subagent_payload?: SubagentProposalPayload | null;
    readonly hook_payload?: HookProposalPayload | null;
    readonly guidance_payload?: GuidanceProposalPayload | null;
    readonly automation_payload?: AutomationProposalPayload | null;
    readonly experiment?: ExperimentDto | null;
}

export interface ImprovePayload {
    readonly proposals: ReadonlyArray<ProposalDto>;
}

export type ImproveActionStatus =
    | "ok"
    | "not_found"
    | "wrong_status"
    | "unsupported_form"
    | "missing_payload"
    | "scaffold_exists"
    | "verdict_locked"
    | "invalid_verdict";

export interface ImproveActionResponse {
    readonly status: ImproveActionStatus;
    readonly proposal_id?: string;
    readonly experiment_id?: string;
    readonly artifact_path?: string;
    readonly task_path?: string;
    readonly message?: string;
}
