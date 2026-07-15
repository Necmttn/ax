import { Effect, Schema } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { AppLayer } from "@ax/lib/layers";
import { decodeJsonOrNull } from "@ax/lib/decode";
import type { DbError } from "@ax/lib/errors";
import { recordRef } from "./evidence-writers.ts";
import { surrealDate, surrealJsonOption, surrealObject, surrealOptionInt, surrealOptionString, surrealString } from "@ax/lib/shared/surql";
import { executeStatementsWith } from "@ax/lib/shared/statement-exec";
import { deriveTaskLabel } from "@ax/lib/shared/task-label";
import { isoTimestamp, recordKeyPart, safeKeyPart, type TimestampInput } from "@ax/lib/shared/derive-keys";
import { tokenQualityLabels, type TokenSourceQuality } from "./token-quality.ts";

type JsonRecord = Record<string, unknown>;

interface SessionRow {
    readonly id: unknown;
    readonly source?: string;
    readonly model?: string;
    readonly started_at?: TimestampInput;
    readonly ended_at?: TimestampInput;
}

interface TurnRow {
    readonly session: unknown;
    readonly seq?: number;
    readonly role?: string;
    readonly message_kind?: string;
    readonly intent_kind?: string;
    readonly text_excerpt?: string;
    readonly has_error?: boolean;
}

interface ToolCallRow {
    readonly session: unknown;
    readonly name?: string;
    readonly command_norm?: string;
    readonly input_json?: string;
    readonly output_json?: string;
    readonly output_excerpt?: string;
    readonly error_text?: string;
    readonly has_error?: boolean;
}

interface PlanSnapshotRow {
    readonly session: unknown;
}

interface InsightMetricRow {
    readonly subject_id?: string;
    readonly metrics?: string;
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

const sqlOptionFloat = (value: number | null | undefined): string =>
    value === null || value === undefined ? "NONE" : Number(value.toFixed(4)).toString();

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

function workflowEpochStatements(firstSuperpowersAt: string | null): string[] {
    const gsdEnds = firstSuperpowersAt ? surrealDate(firstSuperpowersAt) : "NONE";
    const superpowersStarts = firstSuperpowersAt ? surrealDate(firstSuperpowersAt) : "NONE";
    return [
        `UPSERT ${recordRef("workflow_epoch", "gsd")} MERGE ${surrealObject([
            ["name", surrealString("gsd")],
            ["starts_at", "NONE"],
            ["ends_at", gsdEnds],
            ["evidence_kind", surrealOptionString("derived_skill_invocation")],
            ["evidence_ref", surrealOptionString("first superpowers skill invocation")],
            ["notes", surrealOptionString("Sessions before first observed Superpowers skill invocation.")],
        ])};`,
        `UPSERT ${recordRef("workflow_epoch", "superpowers")} MERGE ${surrealObject([
            ["name", surrealString("superpowers")],
            ["starts_at", superpowersStarts],
            ["ends_at", "NONE"],
            ["evidence_kind", surrealOptionString("derived_skill_invocation")],
            ["evidence_ref", surrealOptionString("first superpowers skill invocation")],
            ["notes", surrealOptionString("Sessions at or after first observed Superpowers skill invocation.")],
        ])};`,
    ];
}

function tokenUsageStatement(row: SessionTokenUsage): string {
    const existingActualTokenUsage =
        "prompt_tokens != NONE OR completion_tokens != NONE OR cache_creation_input_tokens != NONE OR cache_read_input_tokens != NONE";
    return `UPSERT ${recordRef("session_token_usage", safeKeyPart(row.sessionKey))} MERGE ${surrealObject([
        ["session", recordRef("session", row.sessionKey)],
        ["source", surrealString(row.source)],
        ["workflow_epoch", row.workflowEpoch ? recordRef("workflow_epoch", row.workflowEpoch) : "NONE"],
        // Never clobber a model the transcript-priced pass already wrote: the
        // subagent ingest writes the real per-transcript model, while this
        // pass only knows session.model (null for sources that don't set it).
        ["model", row.model === null ? "IF model != NONE THEN model ELSE NONE END" : surrealOptionString(row.model)],
        ["prompt_tokens", `IF ${existingActualTokenUsage} THEN prompt_tokens ELSE ${surrealOptionInt(row.promptTokens)} END`],
        ["completion_tokens", `IF ${existingActualTokenUsage} THEN completion_tokens ELSE ${surrealOptionInt(row.completionTokens)} END`],
        ["cache_creation_input_tokens", `IF ${existingActualTokenUsage} THEN cache_creation_input_tokens ELSE ${surrealOptionInt(row.cacheCreationInputTokens)} END`],
        ["cache_read_input_tokens", `IF ${existingActualTokenUsage} THEN cache_read_input_tokens ELSE ${surrealOptionInt(row.cacheReadInputTokens)} END`],
        ["estimated_tokens", `IF ${existingActualTokenUsage} THEN estimated_tokens ELSE ${Math.trunc(row.estimatedTokens).toString(10)} END`],
        ["transcript_bytes", Math.trunc(row.transcriptBytes).toString(10)],
        ["context_window", surrealOptionInt(row.contextWindow)],
        ["labels", `IF ${existingActualTokenUsage} THEN labels ELSE ${surrealJsonOption(row.labels)} END`],
        ["metrics", `IF ${existingActualTokenUsage} THEN metrics ELSE ${surrealJsonOption(row.metrics)} END`],
        ["ts", surrealDate(row.ts)],
    ])};`;
}

export const __testTokenUsageStatement = tokenUsageStatement;

function sessionHealthStatement(row: SessionHealth): string {
    return `UPSERT ${recordRef("session_health", safeKeyPart(row.sessionKey))} MERGE ${surrealObject([
        ["session", recordRef("session", row.sessionKey)],
        ["source", surrealString(row.source)],
        ["workflow_epoch", row.workflowEpoch ? recordRef("workflow_epoch", row.workflowEpoch) : "NONE"],
        ["turns", row.turns.toString(10)],
        ["tool_calls", row.toolCalls.toString(10)],
        ["tool_errors", row.toolErrors.toString(10)],
        ["user_corrections", row.userCorrections.toString(10)],
        ["interruptions", row.interruptions.toString(10)],
        ["subagent_dispatches", row.subagentDispatches.toString(10)],
        ["plan_snapshots", row.planSnapshots.toString(10)],
        ["estimated_tokens", Math.trunc(row.estimatedTokens).toString(10)],
        ["cache_read_ratio", sqlOptionFloat(row.cacheReadRatio)],
        ["cache_creation_ratio", sqlOptionFloat(row.cacheCreationRatio)],
        ["context_pressure", surrealString(row.contextPressure)],
        ["task_label", surrealOptionString(row.taskLabel)],
        ["user_turns", row.userTurns.toString(10)],
        ["assistant_turns", row.assistantTurns.toString(10)],
        ["correction_turns", row.correctionTurns.toString(10)],
        ["labels", surrealJsonOption(row.labels)],
        ["metrics", surrealJsonOption(row.metrics)],
        ["ts", surrealDate(row.ts)],
    ])};`;
}

const fetchFirstSuperpowersAt = (): Effect.Effect<string | null, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const result = yield* db.query<[{ first_superpowers?: TimestampInput | null }[]]>(`
SELECT time::min(ts) AS first_superpowers
FROM invoked
WHERE out.name CONTAINS "superpowers:"
GROUP ALL;`);
        return isoTimestamp(result?.[0]?.[0]?.first_superpowers);
    }).pipe(Effect.map((value) => value === new Date(0).toISOString() ? null : value));

const sinceWhere = (field: string, sinceDays: number | undefined): string =>
    sinceDays && sinceDays > 0 ? `WHERE ${field} > time::now() - ${sinceDays}d` : "";

export const deriveSessionHealth = (
    opts: { sinceDays: number | undefined } = { sinceDays: undefined },
): Effect.Effect<SessionHealthStats, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const firstSuperpowersAt = yield* fetchFirstSuperpowersAt();
        const [sessions, turns, toolCalls, planSnapshots, insightMetrics] = yield* Effect.all([
            db.query<[SessionRow[]]>(`
SELECT id, source, model, type::string(started_at) AS started_at, type::string(ended_at) AS ended_at
FROM session
${sinceWhere("started_at", opts.sinceDays)}
ORDER BY started_at DESC;`).pipe(Effect.map((rows) => rows?.[0] ?? [])),
            db.query<[TurnRow[]]>(`
SELECT session, seq, role, message_kind, intent_kind, text_excerpt, has_error
FROM turn
${sinceWhere("ts", opts.sinceDays)};`).pipe(Effect.map((rows) => rows?.[0] ?? [])),
            db.query<[ToolCallRow[]]>(`
SELECT session, name, command_norm, input_json, output_json, output_excerpt, error_text, has_error
FROM tool_call
${sinceWhere("ts", opts.sinceDays)};`).pipe(Effect.map((rows) => rows?.[0] ?? [])),
            db.query<[PlanSnapshotRow[]]>(`
SELECT session
FROM plan_snapshot
${sinceWhere("ts", opts.sinceDays)};`).pipe(Effect.map((rows) => rows?.[0] ?? [])),
            db.query<[InsightMetricRow[]]>(`
SELECT subject_id, metrics
FROM insight
WHERE kind = "claude_insights";`).pipe(Effect.map((rows) => rows?.[0] ?? [])),
        ], { concurrency: 5 });

        const { usages, health } = buildRows({
            sessions,
            turns,
            toolCalls,
            planSnapshots,
            insightMetrics,
            firstSuperpowersAt,
        });
        const statements = [
            ...workflowEpochStatements(firstSuperpowersAt),
            ...usages.map(tokenUsageStatement),
            ...health.map(sessionHealthStatement),
        ];
        yield* executeStatementsWith(db, statements, { chunkSize: 500 });
        return {
            workflowEpochs: 2,
            sessionTokenUsage: usages.length,
            sessionHealth: health.length,
        };
    });

if (import.meta.main) {
    const sinceArg = process.argv.find((a) => a.startsWith("--since="));
    const sinceDays = sinceArg ? parseInt(sinceArg.split("=")[1], 10) : undefined;
    await Effect.runPromise(
        deriveSessionHealth({ sinceDays }).pipe(
            Effect.provide(AppLayer),
            Effect.scoped,
        ) as Effect.Effect<SessionHealthStats>,
    );
}

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

export const sessionHealthStage: StageDef<SessionHealthStageStats, SurrealClient> = {
    meta: StageMeta.make({ key: "session-health", deps: ["signals"], tags: ["derive", "health"] }),
    run: (ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const sinceDays = sinceDaysFromCtx(ctx);
            const result = yield* deriveSessionHealth({ sinceDays });
            return SessionHealthStageStats.make({
                durationMs: Date.now() - t0,
                summary: `scored ${result.sessionHealth} session health records, ${result.sessionTokenUsage} token usages`,
                sessionTokenUsage: result.sessionTokenUsage,
                sessionHealth: result.sessionHealth,
            });
        }),
};
