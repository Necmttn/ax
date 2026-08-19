import { Effect, Schema } from "effect";
import { TimestampColumn } from "@ax/lib/duckdb/columns";
import { cacheRow, jsonParam, tsParam } from "@ax/lib/duckdb/row";
import type { CacheReadError, CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { decodeJsonOrNull } from "@ax/lib/decode";
import { deriveTaskLabel } from "@ax/lib/shared/task-label";
import { isoTimestamp, recordKeyPart, type TimestampInput } from "@ax/lib/shared/derive-keys";
import { stableId } from "@ax/lib/stable-id";
import { tokenQualityLabels, type TokenSourceQuality } from "./token-quality.ts";

type JsonRecord = Record<string, unknown>;

interface SessionRow {
    readonly id: unknown;
    readonly source?: string | null;
    readonly model?: string | null;
    readonly started_at?: TimestampInput | null;
    readonly ended_at?: TimestampInput | null;
}

interface TurnRow {
    readonly session: unknown;
    readonly seq?: number | null;
    readonly role?: string | null;
    readonly message_kind?: string | null;
    readonly intent_kind?: string | null;
    readonly text_excerpt?: string | null;
    readonly has_error?: boolean | null;
}

interface ToolCallRow {
    readonly session: unknown;
    readonly name?: string | null;
    readonly command_norm?: string | null;
    readonly input_json?: string | null;
    readonly output_json?: string | null;
    readonly output_excerpt?: string | null;
    readonly error_text?: string | null;
    readonly has_error?: boolean | null;
}

interface PlanSnapshotRow {
    readonly session: unknown;
}

interface InsightMetricRow {
    readonly subject_id?: string | null;
    readonly metrics?: string | null;
}

export interface SessionTokenUsage {
    readonly sessionKey: string;
    readonly source: string;
    readonly workflowEpoch: "gsd" | "superpowers" | null;
    readonly model: string | null;
    readonly promptTokens: number | null;
    readonly completionTokens: number | null;
    readonly cacheCreationInputTokens: number | null;
    readonly cacheReadInputTokens: number | null;
    readonly estimatedTokens: number;
    readonly transcriptBytes: number;
    readonly contextWindow: number | null;
    readonly labels: JsonRecord;
    readonly metrics: JsonRecord;
    readonly ts: string;
}

export interface SessionHealth {
    readonly sessionKey: string;
    readonly source: string;
    readonly workflowEpoch: "gsd" | "superpowers" | null;
    readonly turns: number;
    readonly toolCalls: number;
    readonly toolErrors: number;
    readonly userCorrections: number;
    readonly interruptions: number;
    readonly subagentDispatches: number;
    readonly planSnapshots: number;
    readonly estimatedTokens: number;
    readonly cacheReadRatio: number | null;
    readonly cacheCreationRatio: number | null;
    readonly contextPressure: "low" | "medium" | "high" | "unknown";
    readonly taskLabel: string | null;
    readonly userTurns: number;
    readonly assistantTurns: number;
    readonly correctionTurns: number;
    readonly labels: JsonRecord;
    readonly metrics: JsonRecord;
    readonly ts: string;
}

export interface SessionHealthStats {
    readonly workflowEpochs: number;
    readonly sessionTokenUsage: number;
    readonly sessionHealth: number;
}

function parseMetrics(input: string | null | undefined): JsonRecord {
    if (!input) return {};
    const parsed = decodeJsonOrNull(input);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? parsed as JsonRecord
        : {};
}

function numberMetric(metrics: JsonRecord, keys: readonly string[]): number | null {
    for (const key of keys) {
        const value = metrics[key];
        if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
    }
    return null;
}

function textBytes(...parts: readonly (string | null | undefined)[]): number {
    return parts.reduce((sum, part) => sum + (part ? Buffer.byteLength(part, "utf8") : 0), 0);
}

function ratio(part: number | null, total: number | null): number | null {
    if (part === null || total === null || total <= 0) return null;
    return part / total;
}

function contextPressure(input: {
    readonly estimatedTokens: number;
    readonly promptTokens: number | null;
    readonly cacheReadRatio: number | null;
    readonly interruptions: number;
}): "low" | "medium" | "high" | "unknown" {
    if (input.estimatedTokens <= 0) return "unknown";
    if (input.estimatedTokens >= 120_000 || (input.promptTokens ?? 0) >= 80_000) return "high";
    if ((input.cacheReadRatio ?? 1) < 0.1 && (input.promptTokens ?? 0) >= 20_000) return "high";
    if (input.estimatedTokens >= 40_000 || input.interruptions >= 2) return "medium";
    return "low";
}

function workflowEpochFor(startedAt: string, firstSuperpowersAt: string | null): "gsd" | "superpowers" | null {
    if (!firstSuperpowersAt || startedAt === new Date(0).toISOString()) return null;
    return startedAt >= firstSuperpowersAt ? "superpowers" : "gsd";
}

function buildRows(input: {
    readonly sessions: readonly SessionRow[];
    readonly turns: readonly TurnRow[];
    readonly toolCalls: readonly ToolCallRow[];
    readonly planSnapshots: readonly PlanSnapshotRow[];
    readonly insightMetrics: readonly InsightMetricRow[];
    readonly firstSuperpowersAt: string | null;
}): { readonly usages: SessionTokenUsage[]; readonly health: SessionHealth[] } {
    const turnsBySession = new Map<string, TurnRow[]>();
    for (const turn of input.turns) {
        const key = recordKeyPart(turn.session, "session");
        if (!key) continue;
        const bucket = turnsBySession.get(key) ?? [];
        bucket.push(turn);
        turnsBySession.set(key, bucket);
    }

    const toolsBySession = new Map<string, ToolCallRow[]>();
    for (const tool of input.toolCalls) {
        const key = recordKeyPart(tool.session, "session");
        if (!key) continue;
        const bucket = toolsBySession.get(key) ?? [];
        bucket.push(tool);
        toolsBySession.set(key, bucket);
    }

    const plansBySession = new Map<string, number>();
    for (const snapshot of input.planSnapshots) {
        const key = recordKeyPart(snapshot.session, "session");
        if (!key) continue;
        plansBySession.set(key, (plansBySession.get(key) ?? 0) + 1);
    }

    const metricsBySession = new Map<string, JsonRecord>();
    for (const row of input.insightMetrics) {
        const key = row.subject_id ?? null;
        if (!key) continue;
        metricsBySession.set(key, parseMetrics(row.metrics));
    }

    const usages: SessionTokenUsage[] = [];
    const health: SessionHealth[] = [];
    for (const session of input.sessions) {
        const sessionKey = recordKeyPart(session.id, "session");
        if (!sessionKey) continue;
        // NONE-safe (#680): a half-ingested session (e.g. a codex session whose
        // started_at hasn't landed yet) has no usable timestamp. Passing it to
        // isoTimestamp warns and stamps an epoch (1970) row; skip it entirely -
        // a later ingest recomputes health once the session is complete.
        if (session.started_at == null) continue;
        const startedAt = isoTimestamp(session.started_at);
        const ts = isoTimestamp(session.ended_at ?? session.started_at);
        const source = session.source ?? "unknown";
        const sessionTurns = turnsBySession.get(sessionKey) ?? [];
        const sessionTools = toolsBySession.get(sessionKey) ?? [];
        const metrics = metricsBySession.get(sessionKey) ?? {};
        const turnBytes = sessionTurns.reduce((sum, turn) => sum + textBytes(turn.text_excerpt), 0);
        const toolBytes = sessionTools.reduce(
            (sum, tool) => sum + textBytes(tool.input_json, tool.output_json, tool.output_excerpt, tool.error_text),
            0,
        );
        const transcriptBytes = turnBytes + toolBytes;
        const promptTokens = numberMetric(metrics, ["input_tokens", "prompt_tokens"]);
        const completionTokens = numberMetric(metrics, ["output_tokens", "completion_tokens"]);
        const cacheCreationInputTokens = numberMetric(metrics, ["cache_creation_input_tokens", "cached_input_tokens"]);
        const cacheReadInputTokens = numberMetric(metrics, ["cache_read_input_tokens", "cache_read_tokens"]);
        const contextWindow = numberMetric(metrics, ["context_window", "context_window_tokens"]);
        const hasExplicitTokenCounters =
            promptTokens !== null ||
            completionTokens !== null ||
            cacheCreationInputTokens !== null ||
            cacheReadInputTokens !== null;
        const tokenSourceQuality: TokenSourceQuality = hasExplicitTokenCounters
            ? "explicit"
            : transcriptBytes > 0
              ? "estimate"
              : "unavailable";
        const tokenSourceDetail = hasExplicitTokenCounters
            ? "usage_metadata"
            : tokenSourceQuality === "estimate"
              ? "transcript_byte_estimate"
              : "no_token_counters_or_transcript_bytes";
        const estimatedTokens = promptTokens !== null || completionTokens !== null
            ? (promptTokens ?? 0) + (completionTokens ?? 0)
            : Math.ceil(transcriptBytes / 4);
        const cacheReadRatio = ratio(cacheReadInputTokens, promptTokens);
        const cacheCreationRatio = ratio(cacheCreationInputTokens, promptTokens);
        const epoch = workflowEpochFor(startedAt, input.firstSuperpowersAt);
        const userTurns = sessionTurns.filter((turn) => turn.role === "user");
        const assistantTurnCount = sessionTurns.filter((turn) => turn.role === "assistant").length;
        const correctionTurnCount = userTurns.filter((turn) => turn.intent_kind === "correction").length;
        const taskLabel = deriveTaskLabel(sessionTurns);
        const userCorrections = userTurns.filter((turn) =>
            /\b(no|wrong|instead|not that|actually|stop doing|don't)\b/i.test(turn.text_excerpt ?? ""),
        ).length;
        const interruptions = userTurns.filter((turn) =>
            /\b(esc|interrupt|interrupted|stop|pause|wait|redirect|status|what'?s left)\b/i.test(turn.text_excerpt ?? ""),
        ).length;
        const subagentDispatches = sessionTools.filter((tool) =>
            /^(Task|spawn_agent)$/i.test(tool.name ?? "") ||
            /\b(subagent|spawn_agent|dispatching-parallel-agents)\b/i.test(`${tool.command_norm ?? ""} ${tool.input_json ?? ""}`),
        ).length;
        const toolErrors = sessionTools.filter((tool) => tool.has_error === true).length;
        const pressure = contextPressure({ estimatedTokens, promptTokens, cacheReadRatio, interruptions });

        usages.push({
            sessionKey,
            source,
            workflowEpoch: epoch,
            model: session.model ?? null,
            promptTokens,
            completionTokens,
            cacheCreationInputTokens,
            cacheReadInputTokens,
            estimatedTokens,
            transcriptBytes,
            contextWindow,
            labels: {
                ...tokenQualityLabels({
                    source: "session_health",
                    tokenSourceQuality,
                    tokenSourceDetail,
                    model: session.model ?? null,
                    modelSourceDetail: session.model ? "session.model" : "missing_session_model",
                }),
                source: "session_health",
                token_source: promptTokens !== null || completionTokens !== null ? "usage_metadata" : "byte_estimate",
            },
            metrics: {
                cache_read_ratio: cacheReadRatio,
                cache_creation_ratio: cacheCreationRatio,
                turn_bytes: turnBytes,
                tool_bytes: toolBytes,
            },
            ts,
        });

        health.push({
            sessionKey,
            source,
            workflowEpoch: epoch,
            turns: sessionTurns.length,
            toolCalls: sessionTools.length,
            toolErrors,
            userCorrections,
            interruptions,
            subagentDispatches,
            planSnapshots: plansBySession.get(sessionKey) ?? 0,
            estimatedTokens,
            cacheReadRatio,
            cacheCreationRatio,
            contextPressure: pressure,
            taskLabel,
            userTurns: userTurns.length,
            assistantTurns: assistantTurnCount,
            correctionTurns: correctionTurnCount,
            labels: { source: "session_health" },
            metrics: {
                transcript_bytes: transcriptBytes,
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
            },
            ts,
        });
    }

    return { usages, health };
}

export function __testBuildSessionHealthRows(input: Parameters<typeof buildRows>[0]): ReturnType<typeof buildRows> {
    return buildRows(input);
}

const FIRST_SUPERPOWERS_MIN_YEAR = 2000;
const FIRST_SUPERPOWERS_MAX_YEAR = 2100;

function normalizeFirstSuperpowersAt(value: TimestampInput | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    const timestamp = isoTimestamp(value);
    const parsed = Date.parse(timestamp);
    if (!Number.isFinite(parsed)) return null;
    const year = new Date(parsed).getUTCFullYear();
    return year >= FIRST_SUPERPOWERS_MIN_YEAR && year <= FIRST_SUPERPOWERS_MAX_YEAR ? timestamp : null;
}

export const __testNormalizeFirstSuperpowersAt = normalizeFirstSuperpowersAt;

const fetchFirstSuperpowersAt = (write: CacheWriteService): Effect.Effect<string | null, CacheReadError> =>
    Effect.gen(function* () {
        const result = yield* write.rows(Schema.Struct({ first_superpowers: Schema.NullOr(TimestampColumn) }), `
SELECT min(i.ts) AS first_superpowers
FROM invoked i JOIN skill s ON s.id = i.out_id
WHERE s.name LIKE '%superpowers:%'`);
        return normalizeFirstSuperpowersAt(result[0]?.first_superpowers);
    });

const sinceWhere = (field: string, sinceDays: number | undefined): string =>
    sinceDays && sinceDays > 0 ? `WHERE ${field} > CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - INTERVAL '${Math.trunc(sinceDays)} days'` : "";

export const deriveSessionHealth = (
    write: CacheWriteService,
    opts: { sinceDays: number | undefined } = { sinceDays: undefined },
): Effect.Effect<SessionHealthStats, CacheReadError | CacheWriteError> =>
    Effect.gen(function* () {
        const firstSuperpowersAt = yield* fetchFirstSuperpowersAt(write);
        const SessionDbRow = Schema.Struct({
            id: Schema.String, source: Schema.NullOr(Schema.String), model: Schema.NullOr(Schema.String),
            started_at: Schema.NullOr(TimestampColumn), ended_at: Schema.NullOr(TimestampColumn),
        });
        const TurnDbRow = Schema.Struct({
            session: Schema.String, seq: Schema.NullOr(Schema.BigInt), role: Schema.NullOr(Schema.String),
            message_kind: Schema.NullOr(Schema.String), intent_kind: Schema.NullOr(Schema.String),
            text_excerpt: Schema.NullOr(Schema.String), has_error: Schema.NullOr(Schema.Boolean),
        });
        const ToolDbRow = Schema.Struct({
            session: Schema.String, name: Schema.NullOr(Schema.String), command_norm: Schema.NullOr(Schema.String),
            input_json: Schema.NullOr(Schema.String), output_json: Schema.NullOr(Schema.String),
            output_excerpt: Schema.NullOr(Schema.String), error_text: Schema.NullOr(Schema.String),
            has_error: Schema.NullOr(Schema.Boolean),
        });
        const SessionRefRow = Schema.Struct({ session: Schema.String });
        const InsightDbRow = Schema.Struct({ subject_id: Schema.NullOr(Schema.String), metrics: Schema.NullOr(Schema.String) });
        const [sessions, turns, toolCalls, planSnapshots, insightMetrics] = yield* Effect.all([
            write.rows(SessionDbRow, `
SELECT id, source, model, started_at, ended_at
FROM session
${sinceWhere("started_at", opts.sinceDays)}
ORDER BY started_at DESC`),
            write.rows(TurnDbRow, `
SELECT session, seq, role, message_kind, intent_kind, text_excerpt, has_error
FROM turn
${sinceWhere("ts", opts.sinceDays)}`),
            write.rows(ToolDbRow, `
SELECT session, name, command_norm, input_json, output_json, output_excerpt, error_text, has_error
FROM tool_call
${sinceWhere("ts", opts.sinceDays)}`),
            write.rows(SessionRefRow, `
SELECT session
FROM plan_snapshot
${sinceWhere("ts", opts.sinceDays)}`),
            write.rows(InsightDbRow, `
SELECT subject_id, metrics
FROM insight
WHERE kind = 'claude_insights'`),
        ], { concurrency: 5 });

        const { usages, health } = buildRows({
            sessions,
            turns: turns.map((row) => ({
                ...row, seq: row.seq === null ? null : Number(row.seq),
            })),
            toolCalls: toolCalls.map((row) => ({
                ...row,
            })),
            planSnapshots,
            insightMetrics,
            firstSuperpowersAt,
        });
        yield* write.putMany("workflow_epoch", [
            cacheRow({ id: "gsd", name: "gsd", starts_at: null, ends_at: tsParam(firstSuperpowersAt),
                evidence_kind: "derived_skill_invocation", evidence_ref: "first superpowers skill invocation",
                notes: "Sessions before first observed Superpowers skill invocation." }),
            cacheRow({ id: "superpowers", name: "superpowers", starts_at: tsParam(firstSuperpowersAt), ends_at: null,
                evidence_kind: "derived_skill_invocation", evidence_ref: "first superpowers skill invocation",
                notes: "Sessions at or after first observed Superpowers skill invocation." }),
        ]);
        for (const row of usages) {
            // Numeric columns are projected DOUBLE at the READ boundary, not
            // cast in JS afterwards. `write.raw` applies no column decoder, so
            // a BIGINT cell arrives as a JS bigint; every consumer then needs
            // its own guard, and a `typeof x === "number"` guard reads FALSE on
            // one and silently stores null. Doing it in the projection is the
            // one place that cannot be forgotten per-consumer.
            const existing = yield* write.raw(
                `SELECT CAST(prompt_tokens AS DOUBLE) AS prompt_tokens,
                        CAST(completion_tokens AS DOUBLE) AS completion_tokens,
                        CAST(cache_creation_input_tokens AS DOUBLE) AS cache_creation_input_tokens,
                        CAST(cache_read_input_tokens AS DOUBLE) AS cache_read_input_tokens,
                        CAST(estimated_tokens AS DOUBLE) AS estimated_tokens,
                        labels, metrics, model
                 FROM session_token_usage WHERE id = ?`,
                [row.sessionKey],
            );
            const values = existing.rows[0] as Record<string, unknown> | undefined;
            const hasActual = values !== undefined && ["prompt_tokens", "completion_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]
                .some((key) => values[key] !== null && values[key] !== undefined);
            yield* write.put("session_token_usage", cacheRow({
                id: row.sessionKey, session: row.sessionKey, source: row.source,
                workflow_epoch: row.workflowEpoch, model: row.model ?? (values?.model as string | null | undefined) ?? null,
                prompt_tokens: hasActual ? values?.prompt_tokens as number : row.promptTokens,
                completion_tokens: hasActual ? values?.completion_tokens as number : row.completionTokens,
                cache_creation_input_tokens: hasActual ? values?.cache_creation_input_tokens as number : row.cacheCreationInputTokens,
                cache_read_input_tokens: hasActual ? values?.cache_read_input_tokens as number : row.cacheReadInputTokens,
                estimated_tokens: hasActual ? (values?.estimated_tokens as number | undefined) ?? row.estimatedTokens : row.estimatedTokens,
                transcript_bytes: row.transcriptBytes, context_window: row.contextWindow,
                labels: hasActual ? (values?.labels as string | null | undefined) ?? jsonParam(row.labels) : jsonParam(row.labels),
                metrics: hasActual ? (values?.metrics as string | null | undefined) ?? jsonParam(row.metrics) : jsonParam(row.metrics),
                ts: tsParam(row.ts) ?? new Date(),
            }));
        }
        yield* write.putMany("session_health", health.map((row) => cacheRow({
            id: stableId("session_health", [row.sessionKey]), session: row.sessionKey, source: row.source,
            workflow_epoch: row.workflowEpoch, turns: row.turns, tool_calls: row.toolCalls,
            tool_errors: row.toolErrors, user_corrections: row.userCorrections, interruptions: row.interruptions,
            subagent_dispatches: row.subagentDispatches, plan_snapshots: row.planSnapshots,
            estimated_tokens: row.estimatedTokens, cache_read_ratio: row.cacheReadRatio,
            cache_creation_ratio: row.cacheCreationRatio, context_pressure: row.contextPressure,
            task_label: row.taskLabel, user_turns: row.userTurns, assistant_turns: row.assistantTurns,
            correction_turns: row.correctionTurns, labels: jsonParam(row.labels), metrics: jsonParam(row.metrics),
            ts: tsParam(row.ts) ?? new Date(),
        })));
        return {
            workflowEpochs: 2,
            sessionTokenUsage: usages.length,
            sessionHealth: health.length,
        };
    });

// ---------------------------------------------------------------------------
// Co-located StageDef
// ---------------------------------------------------------------------------

import { BaseStageStats, IngestContext, sinceDaysFromCtx, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

export const SessionHealthKey = Schema.Literal("session-health");
export type SessionHealthKey = typeof SessionHealthKey.Type;

/**
 * Session health stage - scores Session Insights via friction/feedback ratios.
 * Depends on {@link SignalsKey}.
 */
// Named SessionHealthStageStats to avoid collision with the original SessionHealthStats interface.
export class SessionHealthStageStats extends BaseStageStats.extend<SessionHealthStageStats>("SessionHealthStageStats")({
    sessionTokenUsage: Schema.Number,
    sessionHealth: Schema.Number,
}) {}

export const sessionHealthStage: StageDef<SessionHealthStageStats, never, CacheWriteError> = {
    meta: StageMeta.make({
        key: "session-health",
        deps: ["signals"],
        tags: ["derive", "health"],
        writes: [
            { table: "workflow_epoch", mode: "derive" },
            { table: "session_health", mode: "derive" },
            // Estimated usage rows upserted into the event table - an
            // enumerated exception (WRITE_MODE_EXCEPTIONS).
            { table: "session_token_usage", mode: "derive" },
        ],
    }),
    run: (ctx: IngestContext, write: CacheWriteService) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const sinceDays = sinceDaysFromCtx(ctx);
            const result = yield* deriveSessionHealth(write, { sinceDays });
            return SessionHealthStageStats.make({
                durationMs: Date.now() - t0,
                summary: `scored ${result.sessionHealth} session health records, ${result.sessionTokenUsage} token usages`,
                sessionTokenUsage: result.sessionTokenUsage,
                sessionHealth: result.sessionHealth,
            });
        }),
};
