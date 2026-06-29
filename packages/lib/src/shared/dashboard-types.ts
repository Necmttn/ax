/**
 * Wire-format types shared between the dashboard server (Bun.serve) and the
 * dashboard SPA. Keep these stable - both sides depend on them.
 */

import type { SessionId } from "./session-id.ts";

export type { SessionId } from "./session-id.ts";

// ---------------------------------------------------------------------------
// Re-exported from api-contract.ts (single source of truth).
// These were formerly hand-written interfaces here; they now derive from the
// Effect Schema structs in api-contract so the two never silently drift.
// ---------------------------------------------------------------------------
export type {
    RecallHit,
    RecallCommitHit,
    RecallSkillHit,
    RecallResponse,
    ToolFailureSample,
    ToolFailureDetailPayload,
    ToolFailuresResponse,
    SkillGraphNode,
    SkillGraphEdge,
    SkillGraphPayload,
    EpisodeNode,
    EpisodeTimelinePayload,
    WorkflowEpisode,
    WorkflowResponse,
    SessionListRow,
    SessionListResponse,
    SessionChildrenResponse,
    SessionSummary,
    SessionOrchestration,
    SessionHealthSummary,
    SessionCompareTurn,
    SessionCompareEntry,
    SessionComparePayload,
    SessionCompareWinners,
    SessionCanvasNode,
    SessionCanvasEdge,
    SessionCanvasPayload,
    SkillTriageNote,
    SkillTriageEntry,
    SkillTriageResponse,
    SkillDetailPayload,
    SkillSourcePayload,
} from "./api-contract.ts";

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

/** On-disk state of a skill's SKILL.md file.
 *  - `active`   - SKILL.md present; the agent harness loads it.
 *  - `disabled` - renamed to SKILL.md.archived; harness skips it (reversible).
 *  - `missing`  - no on-disk file (plugin synthetic, codex tool, stale path). */
export type SkillSourceState = "active" | "disabled" | "missing";

/** Wire format for `GET /api/skills/:name/source` - the skill's SKILL.md
 *  content plus whether ax may rewrite it on disk. */

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

/** One turn in a session's timeline, with the per-turn trifecta attached.
 *  Only populated when the compare is requested with per-turn detail (P1). */

/** Winning session id per axis. Null when undecidable (no data, or a tie). */

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
    readonly source_confidence?: string | null;
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

export interface EpisodeShapeAggregate {
    readonly shape: string;
    readonly phases: ReadonlyArray<"plan" | "execute" | "review" | "merge">;
    readonly episode_count: number;
    readonly example_parent_ids: ReadonlyArray<SessionId>;
    readonly avg_children: number;
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

/** Agent-authored Wrapped recap card (ax wrapped publish). */
export interface WrappedCardDto {
    /** eyebrow question, e.g. "Which archetype are you?" */
    readonly question: string;
    /** the big line - headlines carry the card */
    readonly headline: string;
    readonly body: string;
    /** 'sensitive' cards are dropped from the public preview */
    readonly sensitivity: string;
    readonly position: number;
    /** optional REAL data series grounding the card (drawn as its bar strip) */
    readonly series?: ReadonlyArray<number>;
    readonly series_label?: string | null;
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
    /** agent-authored recap cards; absent/empty until `ax wrapped publish` */
    readonly cards?: ReadonlyArray<WrappedCardDto>;
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

/** Wire format for `/api/sessions/:id/insights` - the expandable insight
 *  panel on the sessions list. All sections optional-by-emptiness: a session
 *  with no data for a section gets an empty array / null, and the SPA hides
 *  that cell. */
export interface SessionInsightsPayload {
    readonly session: SessionId;
    readonly phases: ReadonlyArray<{
        readonly phase: string;
        readonly start_ts: string;
        readonly end_ts: string;
        readonly duration_ms: number;
    }>;
    readonly friction_ticks: ReadonlyArray<{ readonly ts: string; readonly kind: string }>;
    readonly commits: ReadonlyArray<{ readonly ts: string; readonly sha: string; readonly reverted: boolean }>;
    readonly subagent_spans: ReadonlyArray<{
        readonly id: SessionId;
        readonly started_at: string | null;
        readonly ended_at: string | null;
    }>;
    readonly checks: ReadonlyArray<{
        readonly kind: string;
        readonly runs: ReadonlyArray<{ readonly ts: string; readonly ok: boolean }>;
    }>;
    readonly loc: {
        readonly added: number;
        readonly removed: number;
    } | null;
    readonly durability: number | null;
    readonly delegation_ratio: number | null;
    readonly skills: ReadonlyArray<{ readonly name: string; readonly ts: string }>;
    /** Context-fill curve, ≤60 points; t = ms offset from session start,
     *  pct = estimated context fill 0..1 (prompt+cache tokens / window). */
    readonly context_curve: ReadonlyArray<{ readonly t: number; readonly pct: number }>;
    readonly compactions: ReadonlyArray<{ readonly ts: string; readonly t: number }>;
    /** Always present; individual ratios are null when this session or the
     *  30d baseline lacks that metric. All-null ratios ≠ missing baseline. */
    readonly baseline: {
        readonly cost_ratio: number | null;
        readonly friction_ratio: number | null;
        readonly land_ratio: number | null;
        readonly cache_pct: number | null;
    };
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
    /** full +3s/+10s/+30s series, observed_at ASC - drives the trace strip */
    readonly checkpoints?: ReadonlyArray<CheckpointSnapshotDto>;
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
    /** "mined" (signal-derived) or "agent" (ax improve propose); served coalesced. */
    readonly origin?: string;
    /** JSON snapshot frozen at creation - evidence/frequency provenance */
    readonly baseline?: string | null;
    /** hypothesis with {{placeholders}} - hydrated server-side from evidence_query */
    readonly hypothesis_template?: string | null;
    /** read-only query (SELECT/RETURN) whose first row fills the template */
    readonly evidence_query?: string | null;
    /** server-rendered markdown agent brief */
    readonly brief?: string;
}

export interface ImprovePayload {
    readonly proposals: ReadonlyArray<ProposalDto>;
}

// ---------------------------------------------------------------------------
// Next actions (improve-first dashboard)
// ---------------------------------------------------------------------------

export type NextActionKind =
    | "proposal"
    | "verdict"
    | "tool_failure"
    | "churn"
    | "routing"
    | "skill_hygiene"
    | "housekeeping";

export interface NextActionInlineAction {
    readonly type: "accept" | "reject" | "verdict" | "decide";
    /** proposal dedupe_sig for accept/reject/verdict */
    readonly sig: string | null;
    /** skill name for decide */
    readonly skill: string | null;
    /** suggested verdict for one-click lock */
    readonly suggested_verdict: string | null;
}

/** Projected impact for a proposal - estimated/backtested from the user's
 *  own history. Every number carries its basis and an honesty tier. */
export interface ImpactEstimate {
    readonly kind: "savings_usd" | "addressable_failures" | "correction_pressure" | "frequency";
    /** the centerpiece line, e.g. "~$297 redirectable over 30d" */
    readonly headline: string;
    /** one paragraph: how the number was derived */
    readonly detail: string;
    /** data window + method, honestly stated */
    readonly basis: string;
    readonly confidence: "measured" | "estimated" | "indicative";
}

export interface NextActionCard {
    /** stable id: `${kind}:${key}` */
    readonly id: string;
    readonly kind: NextActionKind;
    readonly title: string;
    /** one-line evidence summary */
    readonly evidence: string;
    /** rank score, higher first; KIND_WEIGHT + per-source bonus */
    readonly impact: number;
    /** server-rendered markdown agent brief */
    readonly brief: string;
    /** SPA drill-down path, e.g. /tools */
    readonly link: string | null;
    readonly inline_action: NextActionInlineAction | null;
    /** cheap value teaser parsed from the proposal baseline/hypothesis */
    readonly impact_chip?: string | null;
    /** the fix mechanism, human-named: "new skill" | "edit CLAUDE.md" | "new hook" | ... */
    readonly fix_kind?: string | null;
}

export interface NextActionsSourceNote {
    /** which aggregation leg failed/skipped - keyed by card kind by design */
    readonly source: NextActionKind;
    readonly note: string;
}

export interface NextActionsPayload {
    readonly generatedAt: string;
    readonly cards: ReadonlyArray<NextActionCard>;
    /** sources that failed or were skipped - fail-open, never 500 the panel */
    readonly notes: ReadonlyArray<NextActionsSourceNote>;
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
