import { Effect, FileSystem, Path, Schema, type PlatformError } from "effect";
import { CacheRead, type CacheReadError } from "@ax/lib/duckdb/seam";
import { NumberFromBigIntColumn, TimestampColumn } from "@ax/lib/duckdb/columns";
import type { DuckDbParam } from "@ax/lib/duckdb/types";
import { withConfigWrite } from "../config-core/reconcile.ts";
import { Judgment } from "@ax/lib/sqlite";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { prettyPrint } from "@ax/lib/json";
import { stableId } from "@ax/lib/stable-id";
import { recordKeyPart } from "@ax/lib/shared/derive-keys";
import { safeJsonParse } from "@ax/lib/shared/safe-json";
import { ClassifierReviewPipelineService, ClassifierReviewPipelineServiceLive, type ClassifierReviewPipelineInputValues, nodeFileOutputVerifier } from "../classifiers/review-pipeline-service.ts";
import { catchDbErrorAndExit, catchCacheReadErrorAndExit } from "./output.ts";
import { listStoredProposals } from "../improve/judgment-proposals.ts";
import {
    workflowCandidateGroupSql,
    workflowCandidateEvidenceSql,
    WORKFLOW_CANDIDATE_PROPOSAL_PREFIXES,
    isObject,
    topicFromPropertiesJson,
    asString,
    syncWorkflowCandidateReportFromBrief,
    syncWorkflowCandidateTopicReportFromBrief,
    buildWorkflowCandidateGuidanceProposalPlan,
    workflowCandidateProposalHypothesis,
    workflowCandidateSuggestedGuidance,
    buildWorkflowCandidateTaskDrafts,
    buildWorkflowCandidateReport,
    attachWorkflowCandidatePersistedReviewFacts,
    buildWorkflowCandidateReviewCoverageReport,
    renderWorkflowCandidateReviewCoverageText,
    renderWorkflowCandidateReportText,
    renderWorkflowCandidateProposalListText,
    attachWorkflowCandidateProposalEvidence,
    buildWorkflowCandidateProposalListReport,
    buildWorkflowCandidateTopicReport,
    renderWorkflowCandidateTopicReportText,
    withWorkflowCandidateTopicHarnessEvidence,
    buildWorkflowCandidateTopicGuidanceDecisionBatchReport,
    buildWorkflowCandidateGuidancePendingReviewTask,
    parseWorkflowCandidateGuidancePendingReviewTaskMarkdown,
    buildWorkflowCandidateGuidancePendingReviewContextRepairReport,
    renderWorkflowCandidateGuidancePendingReviewContextRepairText,
    workflowCandidateTurnContextRowSql,
    workflowCandidatePreviousAssistantSql,
    buildWorkflowCandidateGuidancePendingReviewTaskListReport,
    renderWorkflowCandidateGuidancePendingReviewTaskListText,
    buildWorkflowCandidateGuidancePendingReviewHandoffSummary,
    renderWorkflowCandidateTopicGuidanceDecisionBatchText,
    withWorkflowCandidateTopicGuidanceDecision,
    buildWorkflowCandidateTopicHelperExplanations,
    workflowCandidateTopicHarnessGateFailures,
    buildWorkflowCandidateTopicHarnessGraphProjection,
    buildWorkflowCandidateTopicHarnessGraphWritePlan,
    buildWorkflowCandidateTopicReviewGraphProjection,
    buildWorkflowCandidateReviewCoveragePostApplyRecheckSummary,
    parseWorkflowCandidateFixtureRowsJsonl,
    renderWorkflowCandidateReviewCoverageBriefMarkdown,
    syncWorkflowCandidateFixtureRowsFromBriefWithSummary,
    stampWorkflowCandidateReviewProvenance,
    buildWorkflowCandidateReviewCoverageGraphProjectionFromFixtures,
    buildWorkflowCandidateReviewCoverageApplySummary,
    buildWorkflowCandidateTopicReviewGraphWritePlan,
    buildWorkflowCandidateTopicHarnessGraphListReport,
    buildWorkflowCandidateTopicReviewGraphListReport,
    withWorkflowCandidateTopicPersistedReviewCandidates,
    renderWorkflowCandidateTopicHarnessGraphListText,
    buildWorkflowCandidateTopicTaskDrafts,
    buildWorkflowCandidateTopicClassifierFixtureSummary,
    buildWorkflowCandidateAcceptedClassifierFixtureSummary,
    buildWorkflowCandidateReviewCoverageFixtureSummary,
    renderClassifierFixtureRowsJsonl,
    buildWorkflowCandidateHarnessProposalPlan,
    renderWorkflowCandidateTopicEvidencePackMarkdown,
    renderWorkflowCandidateBriefMarkdown,
} from "../classifiers/workflow-candidate-helpers.ts";
import type {
    WorkflowCandidateGuidancePendingReviewTaskSummary,
    WorkflowCandidateCommandInput,
    WorkflowCandidateProposalListRow,
    WorkflowCandidateProposalEvidenceEdgeRow,
    WorkflowCandidateTopicReport,
    WorkflowCandidateTopicGuidanceDecisionReport,
    WorkflowCandidateGuidancePendingReviewHandoffSummary,
    WorkflowCandidateGuidancePendingReviewTaskListFilters,
    WorkflowCandidateGuidancePendingReviewTaskListReport,
    WorkflowCandidateGuidancePendingReviewContextRepairTurnContext,
    WorkflowCandidateTopicClassifierFixtureSummary,
    WorkflowCandidateReviewCoverageFixtureSummary,
    WorkflowCandidateReviewCoverageApplySummary,
    WorkflowCandidateTopicHarnessGraphFactRow,
    WorkflowCandidateTopicHarnessGraphEdgeRow,
    WorkflowCandidateEmbeddingHelperGraphFactRow,
    WorkflowCandidateEmbeddingHelperGraphEdgeRow,
    WorkflowCandidateHelperFixtureRow,
    WorkflowCandidateReviewCoverageReport,
    WorkflowCandidateReviewPipelineLifecycleOptions,
    WorkflowCandidateGraphWriteRow,
} from "../classifiers/workflow-candidate-types.ts";
export * from "../classifiers/workflow-candidate-types.ts";
export * from "../classifiers/workflow-candidate-helpers.ts";

/**
 * DuckDB decode shapes for the `classifier_graph_{node,edge,fact}` /
 * `cites_evidence` / `turn` reads this dispatcher issues directly (every
 * `db.query` call this file used to make against SurrealDB). `updated_at` was
 * `type::string(updated_at)` under SurrealQL - already an ISO string; DuckDB
 * stores it as a real TIMESTAMP, so it decodes through `TimestampColumn` and
 * gets re-stringified with `.toISOString()` at the call site, keeping every
 * downstream row-shape contract (`updated_at?: string | null`) unchanged.
 */
const GroupRowSchema = Schema.Struct({
    graph_id: Schema.String,
    label: Schema.String,
    properties_json: Schema.String,
});
const EvidenceRowSchema = Schema.Struct({
    graph_id: Schema.String,
    subject: Schema.String,
    object: Schema.NullOr(Schema.String),
    properties_json: Schema.String,
});
const FactRowSchema = Schema.Struct({
    graph_id: Schema.String,
    subject: Schema.String,
    predicate: Schema.String,
    object: Schema.NullOr(Schema.String),
    value_json: Schema.NullOr(Schema.String),
    properties_json: Schema.String,
    updated_at: TimestampColumn,
});
const EdgeRowSchema = Schema.Struct({
    graph_id: Schema.String,
    kind: Schema.String,
    from_id: Schema.String,
    to_id: Schema.String,
    evidence_path: Schema.String,
    properties_json: Schema.String,
    updated_at: TimestampColumn,
});
const HelperFactRowSchema = Schema.Struct({
    graph_id: Schema.String,
    subject: Schema.String,
    predicate: Schema.String,
    object: Schema.NullOr(Schema.String),
    value_json: Schema.NullOr(Schema.String),
    evidence_edges_json: Schema.String,
    properties_json: Schema.String,
    updated_at: TimestampColumn,
});
const ProposalEvidenceEdgeRowSchema = Schema.Struct({
    in_id: Schema.String,
    out_id: Schema.String,
});
const PendingReviewTurnRowSchema = Schema.Struct({
    id: Schema.String,
    session_id: Schema.String,
    seq: NumberFromBigIntColumn,
    role: Schema.String,
    text: Schema.NullOr(Schema.String),
    text_excerpt: Schema.NullOr(Schema.String),
});

const toFactRow = (row: typeof FactRowSchema.Type): WorkflowCandidateTopicHarnessGraphFactRow => ({
    graph_id: row.graph_id,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    value_json: row.value_json,
    properties_json: row.properties_json,
    updated_at: row.updated_at.toISOString(),
});
const toEdgeRow = (row: typeof EdgeRowSchema.Type): WorkflowCandidateTopicHarnessGraphEdgeRow => ({
    graph_id: row.graph_id,
    kind: row.kind,
    from_id: row.from_id,
    to_id: row.to_id,
    evidence_path: row.evidence_path,
    properties_json: row.properties_json,
    updated_at: row.updated_at.toISOString(),
});
const toHelperFactRow = (row: typeof HelperFactRowSchema.Type): WorkflowCandidateEmbeddingHelperGraphFactRow => ({
    graph_id: row.graph_id,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    value_json: row.value_json,
    evidence_edges_json: row.evidence_edges_json,
    properties_json: row.properties_json,
    updated_at: row.updated_at.toISOString(),
});
const toEmbeddingHelperEdgeRow = (row: typeof EdgeRowSchema.Type): WorkflowCandidateEmbeddingHelperGraphEdgeRow => ({
    graph_id: row.graph_id,
    kind: row.kind,
    from_id: row.from_id,
    to_id: row.to_id,
    evidence_path: row.evidence_path,
    properties_json: row.properties_json,
    updated_at: row.updated_at.toISOString(),
});

/** Every read this dispatcher issues propagates a `CacheReadError` straight to
 *  a hard process exit, matching `catchDbErrorAndExit`'s exit-on-failure policy
 *  for the SurrealDB reads it replaces - a report command should never print a
 *  silently-empty result because a read degraded, so this deliberately does
 *  NOT use the defensive `cacheRows` helper (which degrades to `[]`). */
const readRows = <S extends Schema.Top>(
    schema: S,
    sql: string,
    params: ReadonlyArray<DuckDbParam> = [],
): Effect.Effect<ReadonlyArray<S["Type"]>, never, CacheRead | S["DecodingServices"]> =>
    Effect.gen(function* () {
        const cache = yield* CacheRead;
        return yield* cache.rows(schema, sql, params);
    }).pipe(catchCacheReadErrorAndExit("axctl classifiers workflow-candidates") as (
        eff: Effect.Effect<ReadonlyArray<S["Type"]>, CacheReadError, CacheRead | S["DecodingServices"]>,
    ) => Effect.Effect<ReadonlyArray<S["Type"]>, never, CacheRead | S["DecodingServices"]>);

/** `(kind = ? AND source_kind = ?)` OR-combined over `kinds`, optionally
 *  narrowed by a case-insensitive `properties_json` substring match - the
 *  DuckDB equivalent of the SurrealQL `string::lowercase(properties_json)
 *  CONTAINS ...` filter every topic-scoped fact read used. */
const workflowFactsByKindsSql = (kindCount: number, withTopic: boolean): string => {
    const kindFrag = Array.from({ length: kindCount }, () => "(kind = ? AND source_kind = ?)").join(" OR ");
    const where = kindCount > 1 ? `(${kindFrag})` : kindFrag;
    const topicFrag = withTopic ? " AND LOWER(properties_json) LIKE ?" : "";
    return `SELECT graph_id, subject, predicate, object, value_json, properties_json, updated_at ` +
        `FROM classifier_graph_fact WHERE ${where}${topicFrag} ORDER BY updated_at DESC LIMIT ?`;
};
const workflowEdgesBySourceKindSql = (withTopic: boolean): string => {
    const topicFrag = withTopic ? " AND LOWER(properties_json) LIKE ?" : "";
    return `SELECT graph_id, kind, from_id, to_id, evidence_path, properties_json, updated_at ` +
        `FROM classifier_graph_edge WHERE source_kind = ?${topicFrag} ORDER BY updated_at DESC LIMIT ?`;
};
const topicLikeParam = (topic: string): string => `%${topic.toLowerCase()}%`;

/** Read the persisted facts + edges for a single `(kind, source_kind)` pair
 *  (harness-check or candidate-review), optionally narrowed by a topic
 *  substring - the shared shape behind every `persisted_*_facts` read. */
const readWorkflowGraphFactsAndEdges = (input: {
    readonly kind: string;
    readonly topic?: string;
    readonly factLimit: number;
    readonly edgeLimit: number;
}) => Effect.gen(function* () {
    const withTopic = input.topic !== undefined;
    const factParams: DuckDbParam[] = [input.kind, input.kind];
    const edgeParams: DuckDbParam[] = [input.kind];
    if (withTopic) {
        factParams.push(topicLikeParam(input.topic!));
        edgeParams.push(topicLikeParam(input.topic!));
    }
    factParams.push(input.factLimit);
    edgeParams.push(input.edgeLimit);
    const facts = yield* readRows(FactRowSchema, workflowFactsByKindsSql(1, withTopic), factParams);
    const edges = yield* readRows(EdgeRowSchema, workflowEdgesBySourceKindSql(withTopic), edgeParams);
    return { facts: facts.map(toFactRow), edges: edges.map(toEdgeRow) };
});

/** Plain `workflow_topic_candidate_review` facts, no topic filter - the
 *  `reviewFactRows` shape reused by `guidanceDecisionBatch`'s refresh,
 *  `reviewCoverage`'s baseline read, and its post-apply recheck. */
const readWorkflowReviewFacts = (limit: number) =>
    Effect.map(
        readRows(FactRowSchema, workflowFactsByKindsSql(1, false), ["workflow_topic_candidate_review", "workflow_topic_candidate_review", limit]),
        (rows) => rows.map(toFactRow),
    );

/** Read the `classifier_candidate_group` / `classifier_candidate_evidence`
 *  rows this dispatcher's every top-level report starts from - the DuckDB
 *  split of the old two-statement `workflowCandidateSql`. */
const readWorkflowCandidateGroupsAndEvidence = (sourceKind: string) => Effect.gen(function* () {
    const groupRows = yield* readRows(GroupRowSchema, workflowCandidateGroupSql, [sourceKind]);
    const evidenceRows = yield* readRows(EvidenceRowSchema, workflowCandidateEvidenceSql, [sourceKind]);
    return [groupRows, evidenceRows] as const;
});

/** `graph_id IN (candidateIds)` against `classifier_candidate_group` /
 *  `classifier_candidate_evidence` - the evidence expansion read used by
 *  every proposal-list evidence attach. */
const readWorkflowCandidateEvidenceByIds = (candidateIds: readonly string[]) => Effect.gen(function* () {
    const placeholders = candidateIds.map(() => "?").join(", ");
    const groupRows = yield* readRows(
        GroupRowSchema,
        `SELECT graph_id, label, properties_json FROM classifier_graph_node WHERE kind = 'classifier_candidate_group' AND graph_id IN (${placeholders})`,
        candidateIds,
    );
    const evidenceRows = yield* readRows(
        EvidenceRowSchema,
        `SELECT graph_id, subject, object, properties_json FROM classifier_graph_fact WHERE kind = 'classifier_candidate_evidence' AND subject IN (${placeholders}) ORDER BY graph_id`,
        candidateIds,
    );
    return [groupRows, evidenceRows] as const;
});

/** `cites_evidence` rows citing `kind = 'workflow_candidate'` FROM one of
 *  `proposalKeys` (bare `proposal` ids) - reconstructs the `proposal:<id>` /
 *  bare-graph-id shape `attachWorkflowCandidateProposalEvidence` expects, since
 *  DuckDB's `in_id`/`out_id` are bare (no SurrealDB `table:id` ref). */
const readWorkflowCandidateProposalEvidenceEdges = (
    proposalKeys: readonly string[],
): Effect.Effect<readonly WorkflowCandidateProposalEvidenceEdgeRow[], never, CacheRead> =>
    Effect.gen(function* () {
        if (proposalKeys.length === 0) return [];
        const placeholders = proposalKeys.map(() => "?").join(", ");
        const rows = yield* readRows(
            ProposalEvidenceEdgeRowSchema,
            `SELECT in_id, out_id FROM cites_evidence WHERE kind = 'workflow_candidate' AND in_id IN (${placeholders})`,
            proposalKeys,
        );
        return rows.map((row) => ({
            proposal_id: `proposal:${row.in_id}`,
            candidate_ref: row.out_id,
        }));
    });

/** Apply a `classifier_graph_{node,edge,fact}` write plan (harness-check or
 *  candidate-review) through the DuckDB write seam - the `db.query(plan.
 *  statements.join("\n"))` this replaces, under the ingest lock via
 *  `withConfigWrite` since this is a CLI-invoked (non-ingest) write. */
export const applyGraphWriteRows = (rows: readonly WorkflowCandidateGraphWriteRow[]) =>
    withConfigWrite((write) =>
        Effect.forEach(rows, (entry) => write.put(entry.table, entry.row), { discard: true }),
    ).pipe(catchDbErrorAndExit("axctl classifiers workflow-candidates"));

const loadWorkflowProposalRows = (input: {
    readonly status: string;
    readonly search?: string;
    readonly limit: number;
}) => listStoredProposals({
    status: input.status,
    dedupePrefixes: WORKFLOW_CANDIDATE_PROPOSAL_PREFIXES,
    ...(input.search === undefined ? {} : { search: input.search }),
    limit: Math.max(1, input.limit),
}).pipe(Effect.map((proposals) => proposals
    .map((proposal): WorkflowCandidateProposalListRow => ({
        proposal_id: `proposal:${proposal.id}`,
        dedupe_sig: proposal.dedupe_sig,
        title: proposal.title,
        form: proposal.form,
        status: proposal.status,
        confidence: proposal.confidence,
        frequency: proposal.frequency,
        target: proposal.guidance_payload?.file_target ?? null,
        section: proposal.guidance_payload?.section ?? null,
        experiment_id: proposal.experiment ? `experiment:${proposal.experiment.id}` : null,
        experiment_status: proposal.experiment?.status ?? null,
        artifact_path: proposal.experiment?.artifact_path ?? null,
        task_path: proposal.experiment?.task_path ?? null,
        updated_at: (proposal.updated_at ?? proposal.created_at).toISOString(),
    }))));

const persistGuidanceProposalPlan = (
    report: import("../classifiers/workflow-candidate-types.ts").WorkflowCandidateReport,
    plan: ReturnType<typeof buildWorkflowCandidateGuidanceProposalPlan>,
) => Effect.gen(function* () {
    const judgment = yield* Judgment;
    const stored = yield* listStoredProposals(1_000);
    const bySig = new Map(stored.map((proposal) => [proposal.dedupe_sig, proposal] as const));
    const now = new Date();
    yield* judgment.transaction((tx) => Effect.gen(function* () {
        for (const promoted of plan.summary.proposals) {
            if (promoted.status !== "created_or_refreshed") continue;
            const task = report.promotion?.tasks.find((item) => item.candidate_id === promoted.candidate_id);
            if (!task) continue;
            const existing = bySig.get(promoted.dedupe_sig);
            const id = existing?.id ?? stableId("proposal", [promoted.dedupe_sig]);
            const candidateIds = task.candidate_ids ?? [task.candidate_id];
            yield* tx.put("proposal", {
                id,
                form: "guidance",
                title: promoted.title,
                hypothesis: workflowCandidateProposalHypothesis(task, report),
                dedupe_sig: promoted.dedupe_sig,
                frequency: Math.max(1, candidateIds.length),
                confidence: promoted.recommended_artifact.confidence,
                status: existing?.status ?? "open",
                origin: existing?.origin ?? "agent",
                hypothesis_template: existing?.hypothesis_template ?? null,
                evidence_query: existing?.evidence_query ?? null,
                reject_reason: existing?.reject_reason ?? null,
                baseline: prettyPrint({ source: "workflow_candidates", frequency: Math.max(1, candidateIds.length), candidate_ids: candidateIds, recommendation: task.recommended_artifact }),
                created_at: existing?.created_at ?? now,
                updated_at: now,
            });
            yield* tx.put("guidance_proposal", {
                id: stableId("guidance_proposal", [id]),
                proposal: id,
                file_target: promoted.file_target,
                section: promoted.section,
                suggested_text: workflowCandidateSuggestedGuidance(task, report),
            });
        }
    }));
});

const persistHarnessProposalPlan = (
    report: WorkflowCandidateTopicReport,
    plan: ReturnType<typeof buildWorkflowCandidateHarnessProposalPlan>,
) => Effect.gen(function* () {
    const judgment = yield* Judgment;
    const stored = yield* listStoredProposals(1_000);
    const bySig = new Map(stored.map((proposal) => [proposal.dedupe_sig, proposal] as const));
    const now = new Date();
    yield* judgment.transaction((tx) => Effect.gen(function* () {
        for (const promoted of plan.summary.proposals) {
            if (promoted.status !== "created_or_refreshed") continue;
            const candidate = report.candidates.candidates.find((item) => item.group_id === promoted.candidate_id);
            if (!candidate) continue;
            const existing = bySig.get(promoted.dedupe_sig);
            const id = existing?.id ?? stableId("proposal", [promoted.dedupe_sig]);
            yield* tx.put("proposal", {
                id,
                form: "harness_check",
                title: promoted.title,
                hypothesis: `${promoted.recommended_artifact.rationale} Evidence-backed workflow candidate: ${candidate.label}. The check should fail when the agent stops before producing applied classifier result evidence.`,
                dedupe_sig: promoted.dedupe_sig,
                frequency: Math.max(1, candidate.support_count),
                confidence: promoted.recommended_artifact.confidence,
                status: existing?.status ?? "open",
                origin: existing?.origin ?? "agent",
                hypothesis_template: existing?.hypothesis_template ?? null,
                evidence_query: existing?.evidence_query ?? null,
                reject_reason: existing?.reject_reason ?? null,
                baseline: prettyPrint({ source: "workflow_topic_report", topic: report.topic, candidate_id: candidate.group_id, recommendation: promoted.recommended_artifact, examples: candidate.examples }),
                created_at: existing?.created_at ?? now,
                updated_at: now,
            });
        }
    }));
});
const loadWorkflowCandidatePendingReviewTurnContexts = (
    turnIds: readonly string[],
): Effect.Effect<readonly WorkflowCandidateGuidancePendingReviewContextRepairTurnContext[], never, CacheRead> =>
    Effect.gen(function* () {
        const contexts: WorkflowCandidateGuidancePendingReviewContextRepairTurnContext[] = [];
        for (const turnId of [...new Set(turnIds)]) {
            const turnKey = recordKeyPart(turnId, "turn") ?? turnId;
            const turnRows = yield* readRows(PendingReviewTurnRowSchema, workflowCandidateTurnContextRowSql, [turnKey]);
            const turn = turnRows[0];
            if (turn === undefined) {
                contexts.push({ turn_id: turnId });
                continue;
            }
            let previousAssistantText: string | null | undefined;
            if (typeof turn.session_id === "string" && typeof turn.seq === "number") {
                const previousRows = yield* readRows(
                    PendingReviewTurnRowSchema,
                    workflowCandidatePreviousAssistantSql,
                    [turn.session_id, turn.seq],
                );
                previousAssistantText = previousRows[0]?.text ?? previousRows[0]?.text_excerpt;
            }
            contexts.push({
                turn_id: turnId,
                ...((turn.text ?? turn.text_excerpt) === undefined ? {} : { user_text: turn.text ?? turn.text_excerpt }),
                ...(previousAssistantText === undefined ? {} : { previous_assistant_text: previousAssistantText }),
            });
        }
        return contexts;
    });

const listMarkdownFiles = (
    dir: string,
): Effect.Effect<readonly string[], never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // Original: existsSync-guard then readdirSync; a missing dir -> [].
        const names = yield* fs.readDirectory(dir).pipe(orAbsent([] as readonly string[]));
        const candidates = names.map((name) => path.join(dir, name));
        const files: string[] = [];
        for (const candidate of candidates) {
            // Original used statSync(...).isFile() in a try/catch (any error ->
            // skip). fs.stat follows symlinks just as the bare statSync did.
            const info = yield* fs.stat(candidate).pipe(orAbsent<FileSystem.File.Info | null>(null));
            if (info !== null && info.type === "File" && candidate.endsWith(".md")) {
                files.push(candidate);
            }
        }
        return files.sort();
    });

export function loadWorkflowCandidateGuidancePendingReviewTaskListReport(
    taskDir: string,
    filters?: WorkflowCandidateGuidancePendingReviewTaskListFilters,
): Effect.Effect<
    WorkflowCandidateGuidancePendingReviewTaskListReport,
    PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
> {
    return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* listMarkdownFiles(taskDir);
        // Reads with no original tolerance (the file was just stat'd): propagate.
        const taskFiles: { path: string; content: string }[] = [];
        for (const path of paths) {
            taskFiles.push({ path, content: yield* fs.readFileString(path) });
        }

        // Pre-resolve the artifact paths that the pure builder would otherwise
        // probe/read synchronously, so the builder stays pure (and the test
        // sync-closure interface is preserved). Mirror the original tolerance:
        // existsSync (presence probe -> orAbsent(false)) and readFileSync inside
        // a try/catch (any error -> "unreadable", so a read miss simply omits the
        // path from the content map and the builder's closure throws -> caught).
        const referenced = new Set<string>();
        for (const file of taskFiles) {
            const parsed = parseWorkflowCandidateGuidancePendingReviewTaskMarkdown(file.content);
            if (parsed.fixture_pack_path !== undefined) referenced.add(parsed.fixture_pack_path);
            if (parsed.review_brief_path !== undefined) referenced.add(parsed.review_brief_path);
        }
        const present = new Set<string>();
        const contents = new Map<string, string>();
        for (const ref of referenced) {
            if (yield* fs.exists(ref).pipe(orAbsent(false))) present.add(ref);
            const content = yield* fs.readFileString(ref).pipe(orAbsent<string | null>(null));
            if (content !== null) contents.set(ref, content);
        }

        return buildWorkflowCandidateGuidancePendingReviewTaskListReport({
            taskDir,
            ...(filters === undefined ? {} : { filters }),
            taskFiles,
            pathExists: (p) => present.has(p),
            readFile: (p) => {
                const content = contents.get(p);
                if (content === undefined) throw new Error(`unreadable: ${p}`);
                return content;
            },
        });
    });
}

export function readWorkflowCandidateHelperFixtures(
    filePath: string,
): Effect.Effect<readonly WorkflowCandidateHelperFixtureRow[], PlatformError.PlatformError, FileSystem.FileSystem> {
    return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // Read with no original tolerance (bare readFileSync): propagate.
        const raw = yield* fs.readFileString(filePath);
        const rows: WorkflowCandidateHelperFixtureRow[] = [];
        for (const line of raw.split(/\r?\n/)) {
            const parsed = safeJsonParse<unknown>(line.trim());
            if (!isObject(parsed)) continue;
            const id = asString(parsed.id);
            const text = asString(parsed.text);
            if (id && text) rows.push({ id, text });
        }
        return rows;
    });
}

export const withWorkflowCandidateReviewPipelineLifecycle = (
    report: WorkflowCandidateReviewCoverageReport,
    options: WorkflowCandidateReviewPipelineLifecycleOptions = {},
): Effect.Effect<WorkflowCandidateReviewCoverageReport, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        if (report.coverage_review === undefined) return report;
        const coverageReview = yield* withWorkflowCandidateReviewCoverageApplySummaryLifecycle(report.coverage_review, options);
        return {
            ...report,
            coverage_review: {
                ...coverageReview,
            },
        };
    }).pipe(Effect.provide(ClassifierReviewPipelineServiceLive));

export const withWorkflowCandidateReviewCoverageApplySummaryLifecycle = (
    summary: WorkflowCandidateReviewCoverageApplySummary,
    options: WorkflowCandidateReviewPipelineLifecycleOptions = {},
): Effect.Effect<WorkflowCandidateReviewCoverageApplySummary, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const pipeline = yield* ClassifierReviewPipelineService;
        const lifecycle = yield* pipeline.commandLifecycle(summary, options);
        return {
            ...summary,
            review_pipeline_lifecycle: lifecycle,
        };
    }).pipe(Effect.provide(ClassifierReviewPipelineServiceLive));

export const runClassifiersWorkflowCandidates = (input: WorkflowCandidateCommandInput) =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const taskDir = input.taskDir ?? ".ax/tasks";
        if (input.listPendingReviewTasks) {
            const filters: WorkflowCandidateGuidancePendingReviewTaskListFilters = {
                ...(input.pendingReviewTaskPath === undefined ? {} : { path: input.pendingReviewTaskPath }),
                ...(input.pendingReviewTaskStatus === undefined ? {} : { status: input.pendingReviewTaskStatus }),
                ...(input.pendingReviewDecisionStatus === undefined ? {} : { review_decision_status: input.pendingReviewDecisionStatus }),
                ...(input.pendingReviewCommandStatus === undefined ? {} : { review_command_status: input.pendingReviewCommandStatus }),
                ...(input.pendingReviewRoute === undefined ? {} : { route: input.pendingReviewRoute }),
                ...(input.pendingReviewProgressStatus === undefined ? {} : { review_progress_status: input.pendingReviewProgressStatus }),
            };
            const hasFilters = Object.keys(filters).length > 0;
            const report = yield* loadWorkflowCandidateGuidancePendingReviewTaskListReport(taskDir, hasFilters ? filters : undefined);
            if (input.out) {
                yield* fs.makeDirectory(path.dirname(input.out), { recursive: true });
                yield* fs.writeFileString(input.out, `${prettyPrint(report)}\n`);
            }
            console.log(input.json ? prettyPrint(report) : renderWorkflowCandidateGuidancePendingReviewTaskListText(report));
            return;
        }
        if (input.repairPendingReviewContext) {
            const taskList = yield* loadWorkflowCandidateGuidancePendingReviewTaskListReport(taskDir, {
                ...(input.pendingReviewTaskPath === undefined ? { route: "repair_review_decisions" as const } : { path: input.pendingReviewTaskPath }),
            });
            const task = taskList.tasks[0];
            if (task?.fixture_pack_path === undefined) {
                console.log(input.json
                    ? prettyPrint({
                        schema: "ax.workflow_candidate_pending_review_context_repair.v1",
                        fixture_pack_path: "unknown",
                        fixture_count: 0,
                        repaired_fixture_count: 0,
                        fully_repaired_fixture_count: 0,
                        partially_repaired_fixture_count: 0,
                        unrepaired_fixture_count: 0,
                        unchanged_fixture_count: 0,
                        before_issue_count: 0,
                        after_issue_count: 0,
                        repaired_issue_count: 0,
                        remaining_issue_count: 0,
                        target_resolution_required_count: 0,
                        target_resolution_rows: [],
                        target_resolution_next_action: "No target resolution is required before human verdict collection.",
                        rows: [],
                        repaired_jsonl: "",
                        repaired_review_brief_markdown: "",
                        next_action: "No pending review task with repairable context was found.",
                    })
                    : "No pending review task with repairable context was found.\n");
                return;
            }
            const rows = parseWorkflowCandidateFixtureRowsJsonl(yield* fs.readFileString(task.fixture_pack_path));
            const turnIds = rows
                .map((row) => row.turn)
                .filter((turn): turn is string => typeof turn === "string" && turn.length > 0);
            const turnContexts = yield* loadWorkflowCandidatePendingReviewTurnContexts(turnIds);
            const report = buildWorkflowCandidateGuidancePendingReviewContextRepairReport({
                fixturePackPath: task.fixture_pack_path,
                ...(task.review_brief_path === undefined ? {} : { reviewBriefPath: task.review_brief_path }),
                rows,
                turnContexts,
                ...(input.repairTarget === undefined ? {} : { repairTarget: input.repairTarget }),
            });
            if (input.repairedFixturePack) {
                yield* fs.makeDirectory(path.dirname(input.repairedFixturePack), { recursive: true });
                yield* fs.writeFileString(input.repairedFixturePack, report.repaired_jsonl);
            }
            if (input.repairedReviewBrief) {
                yield* fs.makeDirectory(path.dirname(input.repairedReviewBrief), { recursive: true });
                yield* fs.writeFileString(input.repairedReviewBrief, report.repaired_review_brief_markdown);
            }
            if (input.out) {
                yield* fs.makeDirectory(path.dirname(input.out), { recursive: true });
                yield* fs.writeFileString(input.out, `${prettyPrint(report)}\n`);
            }
            console.log(input.json ? prettyPrint(report) : renderWorkflowCandidateGuidancePendingReviewContextRepairText(report));
            return;
        }
        const loadTopicReport = (topic: string) =>
            Effect.gen(function* () {
                const status = input.proposalStatus ?? "all";
                let proposalListRows: readonly WorkflowCandidateProposalListRow[] = yield* loadWorkflowProposalRows({
                    status,
                    search: topic,
                    limit: input.limit,
                }).pipe(catchDbErrorAndExit("axctl classifiers workflow-candidates"));
                if (proposalListRows.length > 0) {
                    const proposalKeys = proposalListRows
                        .map((row) => recordKeyPart(row.proposal_id, "proposal"))
                        .filter((key): key is string => key !== null);
                    if (proposalKeys.length > 0) {
                        const edges = yield* readWorkflowCandidateProposalEvidenceEdges(proposalKeys);
                        const candidateIds = [...new Set(edges
                            .map((edge) => recordKeyPart(edge.candidate_ref, "classifier_graph_node"))
                            .filter((id): id is string => id !== null))].sort();
                        if (candidateIds.length > 0) {
                            const [candidateRows, factRows] = yield* readWorkflowCandidateEvidenceByIds(candidateIds);
                            proposalListRows = attachWorkflowCandidateProposalEvidence({
                                rows: proposalListRows,
                                edges,
                                candidateRows,
                                factRows,
                                examplesPerCandidate: input.examples,
                            });
                        }
                    }
                }
                const proposalReport = buildWorkflowCandidateProposalListReport({
                    rows: proposalListRows,
                    limit: input.limit,
                    status,
                    expandEvidence: true,
                    search: topic,
                });
                const [groupRows, evidenceRows] = yield* readWorkflowCandidateGroupsAndEvidence(input.sourceKind);
                const candidateReport = buildWorkflowCandidateReport({
                    groupRows,
                    evidenceRows,
                    sourceKind: input.sourceKind,
                    limit: input.limit,
                    examplesPerGroup: input.examples,
                    ...(input.action === undefined ? {} : { action: input.action }),
                    ...(input.classifier === undefined ? {} : { classifier: input.classifier }),
                    search: topic,
                    taskLike: input.taskLike,
                });
                let topicReport = buildWorkflowCandidateTopicReport({
                    sourceKind: input.sourceKind,
                    topic,
                    proposals: proposalReport,
                    candidates: candidateReport,
                });
                const persistedHarness = yield* readWorkflowGraphFactsAndEdges({
                    kind: "workflow_topic_harness_check",
                    topic,
                    factLimit: Math.max(1, input.limit),
                    edgeLimit: Math.max(1, input.limit * 3),
                });
                topicReport = withWorkflowCandidateTopicHarnessEvidence({
                    ...topicReport,
                    persisted_harness_facts: buildWorkflowCandidateTopicHarnessGraphListReport({
                        topic,
                        facts: persistedHarness.facts,
                        edges: persistedHarness.edges,
                    }),
                });
                const persistedReview = yield* readWorkflowGraphFactsAndEdges({
                    kind: "workflow_topic_candidate_review",
                    topic,
                    factLimit: Math.max(1, input.limit),
                    edgeLimit: Math.max(1, input.limit * 3),
                });
                topicReport = {
                    ...topicReport,
                    persisted_review_facts: buildWorkflowCandidateTopicReviewGraphListReport({
                        topic,
                        facts: persistedReview.facts,
                        edges: persistedReview.edges,
                    }),
                };
                topicReport = withWorkflowCandidateTopicPersistedReviewCandidates(topicReport);
                topicReport = withWorkflowCandidateTopicGuidanceDecision(topicReport);
                return topicReport;
            });

        if (input.guidanceDecisionBatch) {
            const topicRows = (yield* readRows(
                FactRowSchema,
                workflowFactsByKindsSql(2, false),
                [
                    "workflow_topic_candidate_review",
                    "workflow_topic_candidate_review",
                    "workflow_topic_harness_check",
                    "workflow_topic_harness_check",
                    Math.max(1, input.limit * 50),
                ],
            )).map(toFactRow);
            let reviewFactRows = topicRows.filter((row) =>
                row.graph_id?.startsWith("fact:workflow_topic_candidate_review__") ||
                row.subject?.startsWith("workflow_topic_candidate_review:")
            );
            const search = input.search?.trim().toLowerCase();
            const topics = [...new Set(topicRows
                .map((row) => topicFromPropertiesJson(row.properties_json))
                .filter((topic): topic is string => topic !== undefined)
                .filter((topic) => search === undefined || topic.toLowerCase().includes(search))
                .map((topic) => topic.toLowerCase()))]
                .sort()
                .slice(0, Math.max(1, input.limit));
            const reports: WorkflowCandidateTopicReport[] = [];
            for (const topic of topics) reports.push(yield* loadTopicReport(topic));
            const [pendingGroupRows, pendingEvidenceRows] = yield* readWorkflowCandidateGroupsAndEvidence(input.sourceKind);
            let pendingCandidateReport = attachWorkflowCandidatePersistedReviewFacts(buildWorkflowCandidateReport({
                groupRows: pendingGroupRows,
                evidenceRows: pendingEvidenceRows,
                sourceKind: input.sourceKind,
                limit: input.limit,
                examplesPerGroup: input.examples,
                ...(input.action === undefined ? {} : { action: input.action }),
                ...(input.classifier === undefined ? {} : { classifier: input.classifier }),
                ...(input.search === undefined ? {} : { search: input.search }),
                taskLike: input.taskLike,
            }), reviewFactRows);
            const coverageFixturePack = input.coverageFixturePack;
            const taskDir = input.taskDir ?? path.join(process.cwd(), ".ax", "tasks");
            const reviewPipelineValues: ClassifierReviewPipelineInputValues = {
                ...(input.reviewPipelineReviewer === undefined
                    ? input.reviewProvenanceReviewer === undefined ? {} : { reviewer: input.reviewProvenanceReviewer }
                    : { reviewer: input.reviewPipelineReviewer }),
                ...(input.reviewPipelineReviewedAt === undefined
                    ? input.reviewProvenanceReviewedAt === undefined ? {} : { reviewed_at: input.reviewProvenanceReviewedAt }
                    : { reviewed_at: input.reviewPipelineReviewedAt }),
            };
            let pendingReviewFixturePack: WorkflowCandidateReviewCoverageFixtureSummary | undefined;
            let pendingReviewHandoff: WorkflowCandidateGuidancePendingReviewHandoffSummary | undefined;
            let pendingReviewTask: WorkflowCandidateGuidancePendingReviewTaskSummary | undefined;
            if (coverageFixturePack !== undefined) {
                pendingReviewFixturePack = buildWorkflowCandidateReviewCoverageFixtureSummary(pendingCandidateReport, coverageFixturePack);
                yield* fs.makeDirectory(path.dirname(coverageFixturePack), { recursive: true });
                yield* fs.writeFileString(coverageFixturePack, renderClassifierFixtureRowsJsonl(pendingReviewFixturePack.fixtures));
                const reviewProjection = buildWorkflowCandidateReviewCoverageGraphProjectionFromFixtures({
                    rows: pendingReviewFixturePack.fixtures,
                    syncedFrom: coverageFixturePack,
                });
                const reviewWritePlan = buildWorkflowCandidateTopicReviewGraphWritePlan(reviewProjection);
                if (input.reviewFacts !== undefined) {
                    yield* fs.makeDirectory(path.dirname(input.reviewFacts), { recursive: true });
                    yield* fs.writeFileString(input.reviewFacts, `${prettyPrint(reviewProjection)}\n`);
                }
                if (input.reviewWritePlan !== undefined) {
                    yield* fs.makeDirectory(path.dirname(input.reviewWritePlan), { recursive: true });
                    yield* fs.writeFileString(input.reviewWritePlan, `${prettyPrint(reviewWritePlan)}\n`);
                }
                if (input.coverageReviewBrief !== undefined) {
                    yield* fs.makeDirectory(path.dirname(input.coverageReviewBrief), { recursive: true });
                    yield* fs.writeFileString(input.coverageReviewBrief, renderWorkflowCandidateReviewCoverageBriefMarkdown(pendingReviewFixturePack.fixtures, {
                        sourceKind: input.sourceKind,
                        limit: input.limit,
                        coverageFixturePack,
                        coverageReviewBrief: input.coverageReviewBrief,
                        commandMode: "guidance_decision_batch",
                        ...(input.out === undefined ? {} : { outputPath: input.out }),
                    }));
                }
                let applySummary = buildWorkflowCandidateReviewCoverageApplySummary({
                    rows: pendingReviewFixturePack.fixtures,
                    sourcePath: coverageFixturePack,
                    projection: reviewProjection,
                    writePlan: reviewWritePlan,
                    applyRequested: false,
                    applied: false,
                    syncedFixtureCount: 0,
                    unknownFixtureCount: 0,
                    stampedReviewerCount: 0,
                    stampedReviewedAtCount: 0,
                    ...(input.reviewFacts === undefined ? {} : { reviewFactsPath: input.reviewFacts }),
                    ...(input.reviewWritePlan === undefined ? {} : { reviewWritePlanPath: input.reviewWritePlan }),
                    ...(input.coverageReviewBrief === undefined ? {} : { reviewBriefPath: input.coverageReviewBrief }),
                    ...(input.coverageReviewBrief === undefined ? {} : { syncedReviewBriefPath: input.coverageReviewBrief }),
                    sourceKind: input.sourceKind,
                    limit: input.limit,
                    commandMode: "guidance_decision_batch",
                    ...(input.out === undefined ? {} : { outputPath: input.out }),
                });
                if (input.reviewPipelineLifecycle) {
                    applySummary = yield* withWorkflowCandidateReviewCoverageApplySummaryLifecycle(applySummary, {
                        values: reviewPipelineValues,
                        ...(input.reviewPipelineVerifyOutputs ? { verifier: nodeFileOutputVerifier } : {}),
                    });
                }
                pendingReviewHandoff = buildWorkflowCandidateGuidancePendingReviewHandoffSummary({
                    fixturePack: pendingReviewFixturePack,
                    applySummary,
                });
            }
            if (input.coverageReviewPack !== undefined) {
                let reviewedRows = parseWorkflowCandidateFixtureRowsJsonl(
                    yield* fs.readFileString(input.coverageReviewPack),
                );
                let syncedFixtureCount = 0;
                let unknownFixtureCount = 0;
                let stampedReviewerCount = 0;
                let stampedReviewedAtCount = 0;
                if (input.syncCoverageReviewBrief !== undefined) {
                    const syncResult = syncWorkflowCandidateFixtureRowsFromBriefWithSummary(
                        reviewedRows,
                        yield* fs.readFileString(input.syncCoverageReviewBrief),
                    );
                    reviewedRows = syncResult.rows;
                    syncedFixtureCount = syncResult.synced_fixture_count;
                    unknownFixtureCount = syncResult.unknown_fixture_count;
                    yield* fs.writeFileString(input.coverageReviewPack, renderClassifierFixtureRowsJsonl(reviewedRows));
                }
                if (input.reviewProvenanceReviewer !== undefined || input.reviewProvenanceReviewedAt !== undefined) {
                    const stampResult = stampWorkflowCandidateReviewProvenance(reviewedRows, {
                        ...(input.reviewProvenanceReviewer === undefined ? {} : { reviewer: input.reviewProvenanceReviewer }),
                        ...(input.reviewProvenanceReviewedAt === undefined ? {} : { reviewedAt: input.reviewProvenanceReviewedAt }),
                    });
                    reviewedRows = stampResult.rows;
                    stampedReviewerCount = stampResult.stamped_reviewer_count;
                    stampedReviewedAtCount = stampResult.stamped_reviewed_at_count;
                    yield* fs.writeFileString(input.coverageReviewPack, renderClassifierFixtureRowsJsonl(reviewedRows));
                }
                if (input.coverageReviewBrief !== undefined) {
                    yield* fs.makeDirectory(path.dirname(input.coverageReviewBrief), { recursive: true });
                    yield* fs.writeFileString(input.coverageReviewBrief, renderWorkflowCandidateReviewCoverageBriefMarkdown(reviewedRows, {
                        sourceKind: input.sourceKind,
                        limit: input.limit,
                        coverageReviewPack: input.coverageReviewPack,
                        coverageReviewBrief: input.coverageReviewBrief,
                        commandMode: "guidance_decision_batch",
                        ...(input.out === undefined ? {} : { outputPath: input.out }),
                    }));
                }
                const reviewProjection = buildWorkflowCandidateReviewCoverageGraphProjectionFromFixtures({
                    rows: reviewedRows,
                    syncedFrom: input.coverageReviewPack,
                });
                const reviewWritePlan = buildWorkflowCandidateTopicReviewGraphWritePlan(reviewProjection);
                if (input.reviewFacts !== undefined) {
                    yield* fs.makeDirectory(path.dirname(input.reviewFacts), { recursive: true });
                    yield* fs.writeFileString(input.reviewFacts, `${prettyPrint(reviewProjection)}\n`);
                }
                if (input.reviewWritePlan !== undefined) {
                    yield* fs.makeDirectory(path.dirname(input.reviewWritePlan), { recursive: true });
                    yield* fs.writeFileString(input.reviewWritePlan, `${prettyPrint(reviewWritePlan)}\n`);
                }
                const reviewFixturePack = pendingReviewFixturePack ?? {
                    path: input.coverageReviewPack,
                    emitted_fixture_count: reviewedRows.length,
                    candidate_count: new Set(reviewedRows.map((row) => row.candidate_id)).size,
                    skipped_candidate_count: 0,
                    fixtures: reviewedRows,
                };
                pendingReviewFixturePack = reviewFixturePack;
                const pendingApplySummary = buildWorkflowCandidateReviewCoverageApplySummary({
                    rows: reviewedRows,
                    sourcePath: input.coverageReviewPack,
                    projection: reviewProjection,
                    writePlan: reviewWritePlan,
                    applyRequested: Boolean(input.applyReviewFacts),
                    applied: false,
                    syncedFixtureCount,
                    unknownFixtureCount,
                    stampedReviewerCount,
                    stampedReviewedAtCount,
                    ...(input.reviewFacts === undefined ? {} : { reviewFactsPath: input.reviewFacts }),
                    ...(input.reviewWritePlan === undefined ? {} : { reviewWritePlanPath: input.reviewWritePlan }),
                    ...(input.coverageReviewBrief === undefined ? {} : { reviewBriefPath: input.coverageReviewBrief }),
                    ...(input.syncCoverageReviewBrief === undefined ? {} : { syncedReviewBriefPath: input.syncCoverageReviewBrief }),
                    ...(input.requireReviewProvenance === undefined ? {} : { requireReviewProvenance: input.requireReviewProvenance }),
                    ...(input.requireReviewHandoff === undefined ? {} : { requireReviewHandoff: input.requireReviewHandoff }),
                    sourceKind: input.sourceKind,
                    limit: input.limit,
                    commandMode: "guidance_decision_batch",
                    ...(input.out === undefined ? {} : { outputPath: input.out }),
                });
                let applySummary = pendingApplySummary;
                if (input.applyReviewFacts && pendingApplySummary.can_apply) {
                    yield* applyGraphWriteRows(reviewWritePlan.rows);
                    applySummary = buildWorkflowCandidateReviewCoverageApplySummary({
                        rows: reviewedRows,
                        sourcePath: input.coverageReviewPack,
                        projection: reviewProjection,
                        writePlan: reviewWritePlan,
                        applyRequested: true,
                        applied: true,
                        syncedFixtureCount,
                        unknownFixtureCount,
                        stampedReviewerCount,
                        stampedReviewedAtCount,
                        ...(input.reviewFacts === undefined ? {} : { reviewFactsPath: input.reviewFacts }),
                        ...(input.reviewWritePlan === undefined ? {} : { reviewWritePlanPath: input.reviewWritePlan }),
                        ...(input.coverageReviewBrief === undefined ? {} : { reviewBriefPath: input.coverageReviewBrief }),
                        ...(input.syncCoverageReviewBrief === undefined ? {} : { syncedReviewBriefPath: input.syncCoverageReviewBrief }),
                        ...(input.requireReviewProvenance === undefined ? {} : { requireReviewProvenance: input.requireReviewProvenance }),
                        ...(input.requireReviewHandoff === undefined ? {} : { requireReviewHandoff: input.requireReviewHandoff }),
                        sourceKind: input.sourceKind,
                        limit: input.limit,
                        commandMode: "guidance_decision_batch",
                        ...(input.out === undefined ? {} : { outputPath: input.out }),
                    });
                    reviewFactRows = yield* readWorkflowReviewFacts(Math.max(1, input.limit * 50));
                    pendingCandidateReport = attachWorkflowCandidatePersistedReviewFacts(buildWorkflowCandidateReport({
                        groupRows: pendingGroupRows,
                        evidenceRows: pendingEvidenceRows,
                        sourceKind: input.sourceKind,
                        limit: input.limit,
                        examplesPerGroup: input.examples,
                        ...(input.action === undefined ? {} : { action: input.action }),
                        ...(input.classifier === undefined ? {} : { classifier: input.classifier }),
                        ...(input.search === undefined ? {} : { search: input.search }),
                        taskLike: input.taskLike,
                    }), reviewFactRows);
                }
                if (input.reviewPipelineLifecycle) {
                    applySummary = yield* withWorkflowCandidateReviewCoverageApplySummaryLifecycle(applySummary, {
                        values: reviewPipelineValues,
                        ...(input.reviewPipelineVerifyOutputs ? { verifier: nodeFileOutputVerifier } : {}),
                    });
                }
                pendingReviewHandoff = buildWorkflowCandidateGuidancePendingReviewHandoffSummary({
                    fixturePack: reviewFixturePack,
                    applySummary,
                });
                if (input.applyReviewFacts && !pendingApplySummary.can_apply) process.exitCode = 1;
            }
            if (input.emitPendingReviewTask && pendingReviewFixturePack !== undefined && pendingReviewHandoff !== undefined) {
                const task = buildWorkflowCandidateGuidancePendingReviewTask({
                    taskDir,
                    fixturePack: pendingReviewFixturePack,
                    handoff: pendingReviewHandoff,
                    sourceKind: input.sourceKind,
                    ...(input.out === undefined ? {} : { outputPath: input.out }),
                });
                yield* fs.makeDirectory(path.dirname(task.summary.path!), { recursive: true });
                yield* fs.writeFileString(task.summary.path!, task.content);
                pendingReviewTask = task.summary;
            }
            let acceptedClassifierFixturePack: WorkflowCandidateTopicClassifierFixtureSummary | undefined;
            if (input.classifierFixturePack) {
                acceptedClassifierFixturePack = buildWorkflowCandidateAcceptedClassifierFixtureSummary(reports, input.classifierFixturePack);
                yield* fs.makeDirectory(path.dirname(input.classifierFixturePack), { recursive: true });
                yield* fs.writeFileString(input.classifierFixturePack, renderClassifierFixtureRowsJsonl(acceptedClassifierFixturePack.fixtures));
            }
            const batch = buildWorkflowCandidateTopicGuidanceDecisionBatchReport({
                sourceKind: input.sourceKind,
                limit: input.limit,
                ...(input.search === undefined ? {} : { search: input.search }),
                decisions: reports
                    .map((report) => report.guidance_decision)
                    .filter((decision): decision is WorkflowCandidateTopicGuidanceDecisionReport => decision !== undefined),
                pendingCandidateReport,
                ...(acceptedClassifierFixturePack === undefined ? {} : { acceptedClassifierFixturePack }),
                ...(pendingReviewFixturePack === undefined ? {} : { pendingReviewFixturePack }),
                ...(pendingReviewHandoff === undefined ? {} : { pendingReviewHandoff }),
                ...(pendingReviewTask === undefined ? {} : { pendingReviewTask }),
            });
            if (input.out) {
                yield* fs.makeDirectory(path.dirname(input.out), { recursive: true });
                yield* fs.writeFileString(input.out, `${prettyPrint(batch)}\n`);
            }
            console.log(input.json ? prettyPrint(batch) : renderWorkflowCandidateTopicGuidanceDecisionBatchText(batch));
            return;
        }
        if (input.listHarnessFacts) {
            const topic = input.search?.trim();
            const result = yield* readWorkflowGraphFactsAndEdges({
                kind: "workflow_topic_harness_check",
                ...(topic !== undefined && topic.length > 0 ? { topic } : {}),
                factLimit: Math.max(1, input.limit),
                edgeLimit: Math.max(1, input.limit * 3),
            });
            const report = buildWorkflowCandidateTopicHarnessGraphListReport({
                ...(topic === undefined ? {} : { topic }),
                facts: result.facts,
                edges: result.edges,
            });
            if (input.out) {
                yield* fs.makeDirectory(path.dirname(input.out), { recursive: true });
                yield* fs.writeFileString(input.out, `${prettyPrint(report)}\n`);
            }
            console.log(input.json ? prettyPrint(report) : renderWorkflowCandidateTopicHarnessGraphListText(report));
            return;
        }
        if (input.reviewCoverage) {
            const [groupRows, evidenceRows] = yield* readWorkflowCandidateGroupsAndEvidence(input.sourceKind);
            const reviewFacts = yield* readWorkflowReviewFacts(Math.max(1, input.limit * 50));
            let report = buildWorkflowCandidateReviewCoverageReport({
                groupRows,
                evidenceRows,
                reviewFactRows: reviewFacts,
                sourceKind: input.sourceKind,
                limit: input.limit,
                ...(input.search === undefined ? {} : { search: input.search }),
            });
            if (input.coverageFixturePack) {
                const candidateReport = attachWorkflowCandidatePersistedReviewFacts(buildWorkflowCandidateReport({
                    groupRows,
                    evidenceRows,
                    sourceKind: input.sourceKind,
                    limit: input.limit,
                    examplesPerGroup: input.examples,
                    ...(input.search === undefined ? {} : { search: input.search }),
                    taskLike: input.taskLike,
                }), reviewFacts);
                const fixtureSummary = buildWorkflowCandidateReviewCoverageFixtureSummary(candidateReport, input.coverageFixturePack);
                yield* fs.makeDirectory(path.dirname(input.coverageFixturePack), { recursive: true });
                yield* fs.writeFileString(input.coverageFixturePack, renderClassifierFixtureRowsJsonl(fixtureSummary.fixtures));
                if (input.coverageReviewBrief) {
                    yield* fs.makeDirectory(path.dirname(input.coverageReviewBrief), { recursive: true });
                    yield* fs.writeFileString(input.coverageReviewBrief, renderWorkflowCandidateReviewCoverageBriefMarkdown(fixtureSummary.fixtures, {
                        sourceKind: input.sourceKind,
                        limit: input.limit,
                        coverageFixturePack: input.coverageFixturePack,
                        coverageReviewBrief: input.coverageReviewBrief,
                        ...(input.out === undefined ? {} : { outputPath: input.out }),
                    }));
                }
                report = { ...report, fixture_pack: fixtureSummary };
            }
            if (input.coverageReviewPack) {
                let reviewedRows = parseWorkflowCandidateFixtureRowsJsonl(
                    yield* fs.readFileString(input.coverageReviewPack),
                );
                let syncedFixtureCount = 0;
                let unknownFixtureCount = 0;
                let stampedReviewerCount = 0;
                let stampedReviewedAtCount = 0;
                if (input.syncCoverageReviewBrief) {
                    const syncResult = syncWorkflowCandidateFixtureRowsFromBriefWithSummary(
                        reviewedRows,
                        yield* fs.readFileString(input.syncCoverageReviewBrief),
                    );
                    reviewedRows = syncResult.rows;
                    syncedFixtureCount = syncResult.synced_fixture_count;
                    unknownFixtureCount = syncResult.unknown_fixture_count;
                    yield* fs.writeFileString(input.coverageReviewPack, renderClassifierFixtureRowsJsonl(reviewedRows));
                }
                if (input.reviewProvenanceReviewer !== undefined || input.reviewProvenanceReviewedAt !== undefined) {
                    const stampResult = stampWorkflowCandidateReviewProvenance(reviewedRows, {
                        ...(input.reviewProvenanceReviewer === undefined ? {} : { reviewer: input.reviewProvenanceReviewer }),
                        ...(input.reviewProvenanceReviewedAt === undefined ? {} : { reviewedAt: input.reviewProvenanceReviewedAt }),
                    });
                    reviewedRows = stampResult.rows;
                    stampedReviewerCount = stampResult.stamped_reviewer_count;
                    stampedReviewedAtCount = stampResult.stamped_reviewed_at_count;
                    yield* fs.writeFileString(input.coverageReviewPack, renderClassifierFixtureRowsJsonl(reviewedRows));
                }
                if (input.coverageReviewBrief) {
                    yield* fs.makeDirectory(path.dirname(input.coverageReviewBrief), { recursive: true });
                    yield* fs.writeFileString(input.coverageReviewBrief, renderWorkflowCandidateReviewCoverageBriefMarkdown(reviewedRows, {
                        sourceKind: input.sourceKind,
                        limit: input.limit,
                        coverageReviewPack: input.coverageReviewPack,
                        coverageReviewBrief: input.coverageReviewBrief,
                        ...(input.out === undefined ? {} : { outputPath: input.out }),
                    }));
                }
                const reviewProjection = buildWorkflowCandidateReviewCoverageGraphProjectionFromFixtures({
                    rows: reviewedRows,
                    syncedFrom: input.coverageReviewPack,
                });
                const reviewWritePlan = buildWorkflowCandidateTopicReviewGraphWritePlan(reviewProjection);
                if (input.reviewFacts) {
                    yield* fs.makeDirectory(path.dirname(input.reviewFacts), { recursive: true });
                    yield* fs.writeFileString(input.reviewFacts, `${prettyPrint(reviewProjection)}\n`);
                }
                if (input.reviewWritePlan) {
                    yield* fs.makeDirectory(path.dirname(input.reviewWritePlan), { recursive: true });
                    yield* fs.writeFileString(input.reviewWritePlan, `${prettyPrint(reviewWritePlan)}\n`);
                }
                const pendingApplySummary = buildWorkflowCandidateReviewCoverageApplySummary({
                    rows: reviewedRows,
                    sourcePath: input.coverageReviewPack,
                    projection: reviewProjection,
                    writePlan: reviewWritePlan,
                    applyRequested: Boolean(input.applyReviewFacts),
                    applied: false,
                    syncedFixtureCount,
                    unknownFixtureCount,
                    stampedReviewerCount,
                    stampedReviewedAtCount,
                    ...(input.reviewFacts === undefined ? {} : { reviewFactsPath: input.reviewFacts }),
                    ...(input.reviewWritePlan === undefined ? {} : { reviewWritePlanPath: input.reviewWritePlan }),
                    ...(input.coverageReviewBrief === undefined ? {} : { reviewBriefPath: input.coverageReviewBrief }),
                    ...(input.syncCoverageReviewBrief === undefined ? {} : { syncedReviewBriefPath: input.syncCoverageReviewBrief }),
                    coverageRows: report.candidates,
                    ...(input.requireReviewProvenance === undefined ? {} : { requireReviewProvenance: input.requireReviewProvenance }),
                    ...(input.requireReviewHandoff === undefined ? {} : { requireReviewHandoff: input.requireReviewHandoff }),
                    sourceKind: input.sourceKind,
                    limit: input.limit,
                    ...(input.out === undefined ? {} : { outputPath: input.out }),
                });
                if (input.applyReviewFacts && pendingApplySummary.can_apply) {
                    yield* applyGraphWriteRows(reviewWritePlan.rows);
                }
                const applied = Boolean(input.applyReviewFacts && pendingApplySummary.can_apply);
                let applySummary = pendingApplySummary;
                if (applied) {
                    const appliedSummary = buildWorkflowCandidateReviewCoverageApplySummary({
                        rows: reviewedRows,
                        sourcePath: input.coverageReviewPack,
                        projection: reviewProjection,
                        writePlan: reviewWritePlan,
                        applyRequested: true,
                        applied: true,
                        syncedFixtureCount,
                        unknownFixtureCount,
                        stampedReviewerCount,
                        stampedReviewedAtCount,
                        ...(input.reviewFacts === undefined ? {} : { reviewFactsPath: input.reviewFacts }),
                        ...(input.reviewWritePlan === undefined ? {} : { reviewWritePlanPath: input.reviewWritePlan }),
                        ...(input.coverageReviewBrief === undefined ? {} : { reviewBriefPath: input.coverageReviewBrief }),
                        ...(input.syncCoverageReviewBrief === undefined ? {} : { syncedReviewBriefPath: input.syncCoverageReviewBrief }),
                        coverageRows: report.candidates,
                        ...(input.requireReviewProvenance === undefined ? {} : { requireReviewProvenance: input.requireReviewProvenance }),
                        ...(input.requireReviewHandoff === undefined ? {} : { requireReviewHandoff: input.requireReviewHandoff }),
                        sourceKind: input.sourceKind,
                        limit: input.limit,
                        ...(input.out === undefined ? {} : { outputPath: input.out }),
                    });
                    const [postGroupRows, postEvidenceRows] = yield* readWorkflowCandidateGroupsAndEvidence(input.sourceKind);
                    const postReviewFacts = yield* readWorkflowReviewFacts(Math.max(1, input.limit * 50));
                    const postReport = buildWorkflowCandidateReviewCoverageReport({
                        groupRows: postGroupRows,
                        evidenceRows: postEvidenceRows,
                        reviewFactRows: postReviewFacts,
                        sourceKind: input.sourceKind,
                        limit: input.limit,
                        ...(input.search === undefined ? {} : { search: input.search }),
                    });
                    applySummary = {
                        ...appliedSummary,
                        post_apply_recheck: buildWorkflowCandidateReviewCoveragePostApplyRecheckSummary({
                            before: {
                                reviewedCandidateCount: report.totals.reviewed_candidate_count,
                                unreviewedCandidateCount: report.totals.unreviewed_candidate_count,
                                projectedReviewedCandidateCount: pendingApplySummary.projected_reviewed_candidate_count,
                                projectedUnreviewedCandidateCount: pendingApplySummary.projected_unreviewed_candidate_count,
                            },
                            after: {
                                reviewedCandidateCount: postReport.totals.reviewed_candidate_count,
                                unreviewedCandidateCount: postReport.totals.unreviewed_candidate_count,
                            },
                            command: appliedSummary.post_apply_recheck_command,
                        }),
                    };
                    report = postReport;
                }
                report = {
                    ...report,
                    coverage_review: applySummary,
                };
                if (input.applyReviewFacts && !pendingApplySummary.can_apply) process.exitCode = 1;
            }
            if (input.reviewPipelineLifecycle) {
                const values: ClassifierReviewPipelineInputValues = {
                    ...(input.reviewPipelineReviewer === undefined
                        ? input.reviewProvenanceReviewer === undefined ? {} : { reviewer: input.reviewProvenanceReviewer }
                        : { reviewer: input.reviewPipelineReviewer }),
                    ...(input.reviewPipelineReviewedAt === undefined
                        ? input.reviewProvenanceReviewedAt === undefined ? {} : { reviewed_at: input.reviewProvenanceReviewedAt }
                        : { reviewed_at: input.reviewPipelineReviewedAt }),
                };
                report = yield* withWorkflowCandidateReviewPipelineLifecycle(report, {
                    values,
                    ...(input.reviewPipelineVerifyOutputs ? { verifier: nodeFileOutputVerifier } : {}),
                });
            }
            if (input.out) {
                yield* fs.makeDirectory(path.dirname(input.out), { recursive: true });
                yield* fs.writeFileString(input.out, `${prettyPrint(report)}\n`);
            }
            console.log(input.json ? prettyPrint(report) : renderWorkflowCandidateReviewCoverageText(report));
            return;
        }
        if (input.topicReport) {
            const topic = (input.search ?? "").trim();
            if (topic.length === 0) {
                const emptyCandidates = buildWorkflowCandidateReport({
                    groupRows: [],
                    evidenceRows: [],
                    sourceKind: input.sourceKind,
                    limit: input.limit,
                    examplesPerGroup: input.examples,
                    taskLike: input.taskLike,
                });
                const emptyProposals = buildWorkflowCandidateProposalListReport({
                    rows: [],
                    limit: input.limit,
                    status: input.proposalStatus ?? "all",
                    expandEvidence: true,
                });
                const report = buildWorkflowCandidateTopicReport({
                    sourceKind: input.sourceKind,
                    topic,
                    proposals: emptyProposals,
                    candidates: {
                        ...emptyCandidates,
                        failures: [...emptyCandidates.failures, "--search is required for --topic-report"],
                        decision: "needs_workflow_candidate_review",
                    },
                });
                console.log(input.json ? prettyPrint(report) : renderWorkflowCandidateTopicReportText(report));
                process.exitCode = 1;
                return;
            }
            const status = input.proposalStatus ?? "all";
            let proposalListRows: readonly WorkflowCandidateProposalListRow[] = yield* loadWorkflowProposalRows({
                status,
                search: topic,
                limit: input.limit,
            }).pipe(catchDbErrorAndExit("axctl classifiers workflow-candidates"));
            if (proposalListRows.length > 0) {
                const proposalKeys = proposalListRows
                    .map((row) => recordKeyPart(row.proposal_id, "proposal"))
                    .filter((key): key is string => key !== null);
                if (proposalKeys.length > 0) {
                    const edges = yield* readWorkflowCandidateProposalEvidenceEdges(proposalKeys);
                    const candidateIds = [...new Set(edges
                        .map((edge) => recordKeyPart(edge.candidate_ref, "classifier_graph_node"))
                        .filter((id): id is string => id !== null))].sort();
                    if (candidateIds.length > 0) {
                        const [candidateRows, factRows] = yield* readWorkflowCandidateEvidenceByIds(candidateIds);
                        proposalListRows = attachWorkflowCandidateProposalEvidence({
                            rows: proposalListRows,
                            edges,
                            candidateRows,
                            factRows,
                            examplesPerCandidate: input.examples,
                        });
                    }
                }
            }
            const proposalReport = buildWorkflowCandidateProposalListReport({
                rows: proposalListRows,
                limit: input.limit,
                status,
                expandEvidence: true,
                search: topic,
            });
            const [candidateGroupRows, candidateEvidenceRows] = yield* readWorkflowCandidateGroupsAndEvidence(input.sourceKind);
            const candidateReport = buildWorkflowCandidateReport({
                groupRows: candidateGroupRows,
                evidenceRows: candidateEvidenceRows,
                sourceKind: input.sourceKind,
                limit: input.limit,
                examplesPerGroup: input.examples,
                ...(input.action === undefined ? {} : { action: input.action }),
                ...(input.classifier === undefined ? {} : { classifier: input.classifier }),
                search: topic,
                taskLike: input.taskLike,
            });
            let topicReport = buildWorkflowCandidateTopicReport({
                sourceKind: input.sourceKind,
                topic,
                proposals: proposalReport,
                candidates: candidateReport,
            });
            if (input.includeHarnessFacts) {
                const persistedHarness = yield* readWorkflowGraphFactsAndEdges({
                    kind: "workflow_topic_harness_check",
                    topic,
                    factLimit: Math.max(1, input.limit),
                    edgeLimit: Math.max(1, input.limit * 3),
                });
                topicReport = withWorkflowCandidateTopicHarnessEvidence({
                    ...topicReport,
                    persisted_harness_facts: buildWorkflowCandidateTopicHarnessGraphListReport({
                        topic,
                        facts: persistedHarness.facts,
                        edges: persistedHarness.edges,
                    }),
                });
            }
            if (input.includeReviewFacts) {
                const persistedReview = yield* readWorkflowGraphFactsAndEdges({
                    kind: "workflow_topic_candidate_review",
                    topic,
                    factLimit: Math.max(1, input.limit),
                    edgeLimit: Math.max(1, input.limit * 3),
                });
                topicReport = {
                    ...topicReport,
                    persisted_review_facts: buildWorkflowCandidateTopicReviewGraphListReport({
                        topic,
                        facts: persistedReview.facts,
                        edges: persistedReview.edges,
                    }),
                };
                topicReport = withWorkflowCandidateTopicPersistedReviewCandidates(topicReport);
            }
            if (input.includeHelperFacts) {
                const helperFactRows = yield* readRows(
                    HelperFactRowSchema,
                    `SELECT graph_id, subject, predicate, object, value_json, evidence_edges_json, properties_json, updated_at
                     FROM classifier_graph_fact
                     WHERE source_kind = ? AND kind = ? AND predicate = ?
                     ORDER BY updated_at DESC LIMIT ?`,
                    ["embedding_helper_review_projection", "embedding_helper_hard_negative_candidate", "promoted_hard_negative_fixture", Math.max(1, input.limit * 5)],
                );
                const helperEdgeRows = yield* readRows(
                    EdgeRowSchema,
                    `SELECT graph_id, kind, from_id, to_id, evidence_path, properties_json, updated_at
                     FROM classifier_graph_edge
                     WHERE source_kind = ? AND kind IN (?, ?)
                     ORDER BY updated_at DESC LIMIT ?`,
                    ["embedding_helper_review_projection", "nearest_reviewed_fixture", "promoted_as_fixture", Math.max(1, input.limit * 25)],
                );
                const helperFixtures = yield* readWorkflowCandidateHelperFixtures(
                    path.join(process.cwd(), "packages", "ax-classifier-session-sections", "eval-fixtures", "chunks.jsonl"),
                );
                topicReport = {
                    ...topicReport,
                    helper_explanations: buildWorkflowCandidateTopicHelperExplanations({
                        report: topicReport,
                        facts: helperFactRows.map(toHelperFactRow),
                        edges: helperEdgeRows.map(toEmbeddingHelperEdgeRow),
                        fixtures: helperFixtures,
                    }),
                };
            }
            if (input.syncBrief) {
                topicReport = syncWorkflowCandidateTopicReportFromBrief(
                    topicReport,
                    yield* fs.readFileString(input.syncBrief),
                    input.syncBrief,
                );
            }
            if (input.emitAdjacentTasks) {
                const taskDir = input.taskDir ?? path.join(process.cwd(), ".ax", "tasks");
                const adjacentTasks = buildWorkflowCandidateTopicTaskDrafts(topicReport, taskDir);
                if (adjacentTasks.drafts.length > 0) yield* fs.makeDirectory(taskDir, { recursive: true });
                for (const draft of adjacentTasks.drafts) {
                    yield* fs.writeFileString(draft.path, draft.content);
                }
                topicReport = {
                    ...topicReport,
                    adjacent_tasks: adjacentTasks.summary,
                };
            }
            if (input.classifierFixturePack) {
                const summary = buildWorkflowCandidateTopicClassifierFixtureSummary(topicReport, input.classifierFixturePack);
                yield* fs.makeDirectory(path.dirname(input.classifierFixturePack), { recursive: true });
                yield* fs.writeFileString(input.classifierFixturePack, renderClassifierFixtureRowsJsonl(summary.fixtures));
                topicReport = {
                    ...topicReport,
                    classifier_fixtures: summary,
                };
            }
            if (input.promoteHarnessProposals) {
                const existingSigs = new Set((yield* listStoredProposals(1_000)).map((proposal) => proposal.dedupe_sig));
                const plan = buildWorkflowCandidateHarnessProposalPlan(topicReport, existingSigs, {
                    dryRun: Boolean(input.proposalDryRun),
                    includeStatements: Boolean(input.proposalDryRun),
                });
                if (plan.statements.length > 0 && !input.proposalDryRun) {
                    yield* persistHarnessProposalPlan(topicReport, plan).pipe(
                        catchDbErrorAndExit("axctl classifiers workflow-candidates"),
                    );
                }
                topicReport = {
                    ...topicReport,
                    harness_proposals: plan.summary,
                };
            }
            if (input.guidanceDecision) {
                topicReport = withWorkflowCandidateTopicGuidanceDecision(topicReport);
            }
            if (input.out) {
                yield* fs.makeDirectory(path.dirname(input.out), { recursive: true });
                yield* fs.writeFileString(input.out, `${prettyPrint(topicReport)}\n`);
            }
            if (input.evidencePack) {
                yield* fs.makeDirectory(path.dirname(input.evidencePack), { recursive: true });
                yield* fs.writeFileString(input.evidencePack, renderWorkflowCandidateTopicEvidencePackMarkdown(topicReport));
            }
            if (input.reviewFacts || input.reviewWritePlan || input.applyReviewFacts) {
                const reviewProjection = buildWorkflowCandidateTopicReviewGraphProjection(topicReport);
                const reviewWritePlan = buildWorkflowCandidateTopicReviewGraphWritePlan(reviewProjection);
                if (input.reviewFacts) {
                    yield* fs.makeDirectory(path.dirname(input.reviewFacts), { recursive: true });
                    yield* fs.writeFileString(input.reviewFacts, `${prettyPrint(reviewProjection)}\n`);
                }
                if (input.reviewWritePlan) {
                    yield* fs.makeDirectory(path.dirname(input.reviewWritePlan), { recursive: true });
                    yield* fs.writeFileString(input.reviewWritePlan, `${prettyPrint(reviewWritePlan)}\n`);
                }
                if (input.applyReviewFacts && reviewWritePlan.statements.length > 0) {
                    yield* applyGraphWriteRows(reviewWritePlan.rows);
                }
            }
            if (input.harnessFacts || input.harnessWritePlan || input.applyHarnessFacts) {
                const harnessProjection = buildWorkflowCandidateTopicHarnessGraphProjection(topicReport);
                const harnessWritePlan = buildWorkflowCandidateTopicHarnessGraphWritePlan(harnessProjection);
                if (input.harnessFacts) {
                    yield* fs.makeDirectory(path.dirname(input.harnessFacts), { recursive: true });
                    yield* fs.writeFileString(input.harnessFacts, `${prettyPrint(harnessProjection)}\n`);
                }
                if (input.harnessWritePlan) {
                    yield* fs.makeDirectory(path.dirname(input.harnessWritePlan), { recursive: true });
                    yield* fs.writeFileString(input.harnessWritePlan, `${prettyPrint(harnessWritePlan)}\n`);
                }
                if (input.applyHarnessFacts && harnessWritePlan.statements.length > 0) {
                    yield* applyGraphWriteRows(harnessWritePlan.rows);
                }
            }
            console.log(input.json ? prettyPrint(topicReport) : renderWorkflowCandidateTopicReportText(topicReport));
            if (topicReport.decision !== "workflow_topic_evidence_found") process.exitCode = 1;
            if (input.requireHarnessChecks) {
                const harnessFailures = workflowCandidateTopicHarnessGateFailures(topicReport);
                if (harnessFailures.length > 0) {
                    for (const failure of harnessFailures) console.error(`harness gate failure: ${failure}`);
                    process.exitCode = 1;
                }
            }
            return;
        }
        if (input.listProposals) {
            const status = input.proposalStatus ?? "all";
            let rows: readonly WorkflowCandidateProposalListRow[] = yield* loadWorkflowProposalRows({
                status,
                ...(input.search === undefined ? {} : { search: input.search }),
                limit: input.limit,
            }).pipe(catchDbErrorAndExit("axctl classifiers workflow-candidates"));
            if (input.expandEvidence && rows.length > 0) {
                const proposalKeys = rows
                    .map((row) => recordKeyPart(row.proposal_id, "proposal"))
                    .filter((key): key is string => key !== null);
                if (proposalKeys.length > 0) {
                    const edges = yield* readWorkflowCandidateProposalEvidenceEdges(proposalKeys);
                    const candidateIds = [...new Set(edges
                        .map((edge) => recordKeyPart(edge.candidate_ref, "classifier_graph_node"))
                        .filter((id): id is string => id !== null))].sort();
                    if (candidateIds.length > 0) {
                        const [candidateRows, factRows] = yield* readWorkflowCandidateEvidenceByIds(candidateIds);
                        rows = attachWorkflowCandidateProposalEvidence({
                            rows,
                            edges,
                            candidateRows,
                            factRows,
                            examplesPerCandidate: input.examples,
                        });
                    }
                }
            }
            const listReport = buildWorkflowCandidateProposalListReport({
                rows,
                limit: input.limit,
                status,
                expandEvidence: Boolean(input.expandEvidence),
                ...(input.search === undefined ? {} : { search: input.search }),
            });
            if (input.out) {
                yield* fs.makeDirectory(path.dirname(input.out), { recursive: true });
                yield* fs.writeFileString(input.out, `${prettyPrint(listReport)}\n`);
            }
            console.log(input.json ? prettyPrint(listReport) : renderWorkflowCandidateProposalListText(listReport));
            return;
        }
        const [groupRows, evidenceRows] = yield* readWorkflowCandidateGroupsAndEvidence(input.sourceKind);
        let report = buildWorkflowCandidateReport({
            groupRows,
            evidenceRows,
            sourceKind: input.sourceKind,
            limit: input.limit,
            examplesPerGroup: input.examples,
            ...(input.action === undefined ? {} : { action: input.action }),
            ...(input.classifier === undefined ? {} : { classifier: input.classifier }),
            ...(input.search === undefined ? {} : { search: input.search }),
            taskLike: input.taskLike,
        });
        if (input.includeReviewFacts && report.candidates.length > 0) {
            const candidateIds = report.candidates.map((candidate) => candidate.group_id);
            const placeholders = candidateIds.map(() => "?").join(", ");
            const persistedReviewRows = yield* readRows(
                FactRowSchema,
                `SELECT graph_id, subject, predicate, object, value_json, properties_json, updated_at
                 FROM classifier_graph_fact
                 WHERE kind = ? AND source_kind = ? AND object IN (${placeholders})
                 ORDER BY updated_at DESC LIMIT ?`,
                ["workflow_topic_candidate_review", "workflow_topic_candidate_review", ...candidateIds, Math.max(1, input.limit * 3)],
            );
            report = attachWorkflowCandidatePersistedReviewFacts(report, persistedReviewRows.map(toFactRow));
        }
        if (input.syncBrief) {
            report = syncWorkflowCandidateReportFromBrief(
                report,
                yield* fs.readFileString(input.syncBrief),
                input.syncBrief,
            );
        }
        if (input.promoteTasks || input.promoteProposals) {
            const taskDir = input.taskDir ?? path.join(process.cwd(), ".ax", "tasks");
            const promotion = buildWorkflowCandidateTaskDrafts(report, taskDir, input.promotionMode ?? "per-candidate");
            report = promotion.report;
            if (input.promoteTasks) {
                if (promotion.drafts.length > 0) yield* fs.makeDirectory(taskDir, { recursive: true });
                for (const draft of promotion.drafts) {
                    yield* fs.writeFileString(draft.path, draft.content);
                }
            }
        }
        if (input.promoteProposals) {
            const existingSigs = new Set((yield* listStoredProposals(1_000)).map((proposal) => proposal.dedupe_sig));
            const plan = buildWorkflowCandidateGuidanceProposalPlan(report, existingSigs, {
                ...(input.proposalTarget === undefined ? {} : { fileTarget: input.proposalTarget }),
                ...(input.proposalSection === undefined ? {} : { section: input.proposalSection }),
                dryRun: Boolean(input.proposalDryRun),
                includeStatements: Boolean(input.proposalDryRun),
            });
            if (plan.statements.length > 0 && !input.proposalDryRun) {
                yield* persistGuidanceProposalPlan(report, plan).pipe(
                    catchDbErrorAndExit("axctl classifiers workflow-candidates"),
                );
            }
            const promotion = report.promotion;
            if (promotion === undefined) {
                const failures = [...report.failures, "promotion required before proposal seeding"];
                report = {
                    ...report,
                    failures,
                    decision: "needs_workflow_candidate_review",
                };
            } else {
                const failures = [...report.failures, ...plan.summary.failures];
                report = {
                    ...report,
                    promotion: {
                        ...promotion,
                        proposals: plan.summary,
                    },
                    failures,
                    decision: failures.length === 0 ? "workflow_candidates_ranked" : "needs_workflow_candidate_review",
                };
            }
        }
        if (input.out) {
            yield* fs.makeDirectory(path.dirname(input.out), { recursive: true });
            yield* fs.writeFileString(input.out, `${prettyPrint(report)}\n`);
        }
        if (input.brief) {
            yield* fs.makeDirectory(path.dirname(input.brief), { recursive: true });
            yield* fs.writeFileString(input.brief, renderWorkflowCandidateBriefMarkdown(report));
        }
        console.log(input.json ? prettyPrint(report) : renderWorkflowCandidateReportText(report));
        if (report.decision !== "workflow_candidates_ranked") process.exitCode = 1;
    });
