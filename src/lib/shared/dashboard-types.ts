/**
 * Wire-format types shared between the dashboard server (Bun.serve) and the
 * dashboard SPA. Keep these stable - both sides depend on them.
 */

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
    readonly session_id: string | null;
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
    readonly example_session_ids: ReadonlyArray<string>;
}

export interface SessionOverview {
    readonly id: string;
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
    readonly session_id: string;
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

export interface SessionDetailPayload {
    readonly overview: SessionOverview | null;
    readonly top_skills: ReadonlyArray<SessionTopSkill>;
    readonly tool_calls: ReadonlyArray<SessionToolCall>;
    readonly children: ReadonlyArray<SessionLink>;
    readonly parent: SessionLink | null;
    readonly agent_delegations: ReadonlyArray<SessionAgentDelegation>;
}

export interface WorkflowEpisode {
    readonly parent_session_id: string;
    readonly project: string | null;
    readonly started_at: string | null;
    readonly child_count: number;
    readonly distinct_nicknames: number;
}

export interface EpisodeNode {
    readonly session_id: string;
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
    readonly parent_session_id: string;
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
    readonly example_parent_ids: ReadonlyArray<string>;
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
    readonly session_id: string;
    readonly source: string | null;
    readonly started_at: string | null;
    readonly ended_at: string | null;
    readonly model: string | null;
}

export interface ProjectEpisode {
    readonly parent_session_id: string;
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

export interface RecallHit {
    readonly turn_id: string;
    readonly session_id: string;
    readonly project: string | null;
    readonly source: string | null;
    readonly role: string | null;
    readonly ts: string | null;
    readonly snippet: string;
}

export interface RecallResponse {
    readonly q: string;
    readonly hits: ReadonlyArray<RecallHit>;
    readonly truncated: boolean;
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
    readonly id: string;
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
     *  Claude subagent / Codex agent). Null for top-level sessions. */
    readonly parent_session: string | null;
}

export interface SessionListResponse {
    readonly sessions: ReadonlyArray<SessionListRow>;
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

export interface InspectTurnDto {
    /** Sequence within session, 0-indexed in JSONL message order. */
    readonly seq: number;
    /** JSONL framing role: 'user' | 'assistant'. */
    readonly role: string;
    /** Dominant span kind - what the content actually IS, regardless of framing. */
    readonly semantic_role: InspectSpanKind;
    readonly ts: string | null;
    readonly char_count: number;
    readonly spans: ReadonlyArray<InspectSpanDto>;
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
    readonly session_id: string;
    readonly ts: string | null;
    readonly tool: string | null;       // 'spawn_agent' | 'Task' | ...
    readonly nickname: string | null;
    /** Sequence of the parent turn that fired this spawn (best-effort match
     *  by ts proximity). Null if no matching turn within the session. */
    readonly anchor_turn_seq: number | null;
    /** Args extracted from the parent's tool_use call. Null if we couldn't
     *  match the call (e.g. spawn happened off-JSONL or args weren't parseable). */
    readonly meta: SpawnMeta | null;
}

export interface SessionInspectPayload {
    readonly session_id: string;
    readonly source_path: string;
    readonly total_chars: number;
    readonly turns: ReadonlyArray<InspectTurnDto>;
    /** Aggregate char counts by span kind across the whole session. */
    readonly totals_by_kind: Partial<Record<InspectSpanKind, number>>;
    /** Parent session id when this session was spawned by another (codex
     *  spawn_agent, claude Task). Null for top-level sessions. */
    readonly parent_session: string | null;
    /** Codex assigns short names like "Pauli", "Turing" to spawned subagents. */
    readonly parent_nickname: string | null;
    /** Subagents this session spawned, in order. Empty for leaf sessions. */
    readonly children: ReadonlyArray<SpawnedChild>;
}
