import { Effect, Schema } from "effect";
import { TimestampColumn } from "@ax/lib/duckdb/columns";
import { cacheRow, jsonParam, tsParam } from "@ax/lib/duckdb/row";
import type { CacheReadError, CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { stableId } from "@ax/lib/stable-id";
import { isoTimestamp, recordKeyPart, type TimestampInput } from "@ax/lib/shared/derive-keys";
import { checkFamilyFromCommand } from "./check-family.ts";

export type CommandOutcomeKind =
    | "success"
    | "expected_feedback"
    | "search_miss"
    | "guardrail"
    | "environment_blocker"
    | "workflow_error"
    | "product_bug_signal"
    | "unknown";

interface ToolCallOutcomeRow {
    readonly id?: unknown;
    readonly session?: unknown;
    readonly turn?: unknown | null;
    readonly name?: string;
    readonly command_norm?: string | null;
    readonly command_text?: string | null;
    readonly output_excerpt?: string | null;
    readonly error_text?: string | null;
    readonly exit_code?: number | null;
    readonly has_error?: boolean;
    readonly status?: string | null;
    readonly ts?: TimestampInput;
}

interface UserTurnRow {
    readonly id?: unknown;
    readonly session?: unknown;
    readonly seq?: number;
    readonly text_excerpt?: string | null;
    readonly ts?: TimestampInput;
    readonly has_error?: boolean;
}

interface CommandOutcome {
    readonly key: string;
    readonly toolCallKey: string | null;
    readonly sessionKey: string | null;
    readonly commandNorm: string | null;
    readonly commandTool: string | null;
    readonly kind: CommandOutcomeKind;
    readonly status: string;
    readonly text: string | null;
    readonly labels: Record<string, unknown>;
    readonly metrics: Record<string, unknown>;
    readonly ts: string;
}

interface NgramAggregate {
    readonly ngram: string;
    readonly n: number;
    count: number;
    sessions: Set<string>;
    nearCorrectionCount: number;
    nearFailedToolCount: number;
    nearEditCount: number;
    nearVerificationCount: number;
    firstSeen: string;
    lastSeen: string;
}

export interface OutcomeStats {
    readonly commandOutcomes: number;
    readonly userMessageNgrams: number;
}

const textFor = (row: ToolCallOutcomeRow): string =>
    [row.command_text, row.command_norm, row.error_text, row.output_excerpt]
        .filter((part): part is string => typeof part === "string" && part.length > 0)
        .join("\n")
        .toLowerCase();

export function classifyCommandOutcome(row: ToolCallOutcomeRow): CommandOutcomeKind {
    const hasError = row.has_error === true || row.status === "error" || (typeof row.exit_code === "number" && row.exit_code !== 0);
    const text = textFor(row);
    const command = `${row.command_norm ?? ""} ${row.command_text ?? ""}`.toLowerCase();
    if (!hasError) return "success";
    if (/\b(rg|grep|find|fd)\b/.test(command) && (row.exit_code === 1 || /no matches|not found|0 results/.test(text))) return "search_miss";
    if (/--exit-code|git diff|git status --porcelain|guardrail|preflight/.test(command)) return "guardrail";
    if (/command not found|enoent|econnrefused|connection refused|auth|permission denied|network|port|daemon|database/.test(text)) return "environment_blocker";
    if (checkFamilyFromCommand(row.command_text) !== null || checkFamilyFromCommand(row.command_norm) !== null) {
        if (/fail|error|expected|assert|type|lint|diagnostic|compile/.test(text)) return "expected_feedback";
        return "product_bug_signal";
    }
    if (/no such file|not a git repository|unknown option|bad args|invalid argument|wrong path|cannot find/.test(text)) return "workflow_error";
    return "unknown";
}

function commandOutcomeKey(row: ToolCallOutcomeRow, index: number): string {
    const toolCallKey = recordKeyPart(row.id, "tool_call") ?? (typeof row.id === "string" ? row.id : null);
    if (toolCallKey) return stableId("command_outcome", [toolCallKey]);
    const seed = `${typeof row.session === "string" ? row.session : "session"}:${row.command_norm ?? row.name ?? "command"}:${index}`;
    return stableId("command_outcome", [seed]);
}

export function deriveCommandOutcomes(rows: readonly ToolCallOutcomeRow[]): CommandOutcome[] {
    return rows.map((row, index) => {
        const toolCallKey = recordKeyPart(row.id, "tool_call") ?? (typeof row.id === "string" ? row.id : null);
        const sessionKey = recordKeyPart(row.session, "session") ?? (typeof row.session === "string" ? row.session : null);
        const kind = classifyCommandOutcome(row);
        return {
            key: commandOutcomeKey(row, index),
            toolCallKey,
            sessionKey,
            commandNorm: row.command_norm ?? null,
            commandTool: row.name ?? null,
            kind,
            status: kind === "success" ? "ok" : "error",
            text: row.error_text ?? row.output_excerpt ?? row.command_text ?? null,
            labels: {
                source: "derive_outcomes",
                exitCode: row.exit_code ?? null,
                hasError: row.has_error === true,
            },
            metrics: { confidence: kind === "unknown" ? 0.3 : 0.8 },
            ts: isoTimestamp(row.ts),
        };
    });
}

export const STOP_WORDS = new Set([
    "the", "and", "for", "that", "this", "with", "you", "can", "are", "was", "were", "have", "has", "but", "not", "from", "into",
    "if", "there", "to", "see", "your", "our", "their", "then", "when", "what", "how", "why", "does", "did", "would", "should",
    "could", "let", "lets", "we", "my", "me", "it", "its", "is", "in", "on", "as", "of", "or", "be", "so", "do",
]);

export function tokens(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/`[^`]+`/g, " ")
        .replace(/https?:\/\/\S+/g, " ")
        .split(/[^a-z0-9_'-]+/)
        .map((token) => token.replace(/^['-]+|['-]+$/g, ""))
        .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

export function deriveUserMessageNgrams(rows: readonly UserTurnRow[], sizes: readonly number[] = [2, 3]): NgramAggregate[] {
    const byNgram = new Map<string, NgramAggregate>();
    for (const row of rows) {
        const text = row.text_excerpt?.trim();
        if (!text) continue;
        const sessionKey = recordKeyPart(row.session, "session") ?? (typeof row.session === "string" ? row.session : "unknown");
        const ts = isoTimestamp(row.ts);
        const words = tokens(text);
        const nearCorrection = /\b(no|wrong|instead|wait|stop|not that|actually)\b/i.test(text);
        const nearFailedTool = row.has_error === true;
        const nearVerification = /\b(test|typecheck|lint|verify|check)\b/i.test(text);
        for (const n of sizes) {
            for (let i = 0; i <= words.length - n; i += 1) {
                const ngram = words.slice(i, i + n).join(" ");
                const key = `${n}:${ngram}`;
                const existing = byNgram.get(key);
                if (existing) {
                    existing.count += 1;
                    existing.sessions.add(sessionKey);
                    if (nearCorrection) existing.nearCorrectionCount += 1;
                    if (nearFailedTool) existing.nearFailedToolCount += 1;
                    if (nearVerification) existing.nearVerificationCount += 1;
                    if (ts < existing.firstSeen) existing.firstSeen = ts;
                    if (ts > existing.lastSeen) existing.lastSeen = ts;
                } else {
                    byNgram.set(key, {
                        ngram,
                        n,
                        count: 1,
                        sessions: new Set([sessionKey]),
                        nearCorrectionCount: nearCorrection ? 1 : 0,
                        nearFailedToolCount: nearFailedTool ? 1 : 0,
                        nearEditCount: 0,
                        nearVerificationCount: nearVerification ? 1 : 0,
                        firstSeen: ts,
                        lastSeen: ts,
                    });
                }
            }
        }
    }
    return [...byNgram.values()]
        .filter((item) => item.count >= 1)
        .sort((a, b) => b.count - a.count || a.ngram.localeCompare(b.ngram))
        .slice(0, 1000);
}

const commandOutcomeRow = (outcome: CommandOutcome) => cacheRow({
    id: outcome.key, tool_call: outcome.toolCallKey, session: outcome.sessionKey,
    command_norm: outcome.commandNorm, command_tool: outcome.commandTool, kind: outcome.kind,
    status: outcome.status, text: outcome.text, labels: jsonParam(outcome.labels),
    metrics: jsonParam(outcome.metrics), ts: tsParam(outcome.ts),
});
const ngramRow = (item: NgramAggregate) => cacheRow({
    id: stableId("user_message_ngram", [item.n, item.ngram]), ngram: item.ngram, n: item.n,
    count: item.count, sessions: jsonParam([...item.sessions].slice(0, 100)),
    near_correction_count: item.nearCorrectionCount, near_failed_tool_count: item.nearFailedToolCount,
    near_edit_count: item.nearEditCount, near_verification_count: item.nearVerificationCount,
    first_seen: tsParam(item.firstSeen), last_seen: tsParam(item.lastSeen),
});

const fetchToolCalls = (write: CacheWriteService, sinceDays: number | undefined): Effect.Effect<readonly ToolCallOutcomeRow[], CacheReadError> =>
    Effect.gen(function* () {
        return yield* write.rows(Schema.Struct({
            id: Schema.String, session: Schema.String, turn: Schema.NullOr(Schema.String), name: Schema.String,
            command_norm: Schema.NullOr(Schema.String), command_text: Schema.NullOr(Schema.String),
            output_excerpt: Schema.NullOr(Schema.String), error_text: Schema.NullOr(Schema.String),
            exit_code: Schema.NullOr(Schema.Number), has_error: Schema.Boolean,
            status: Schema.NullOr(Schema.String), ts: TimestampColumn,
        }), `SELECT id, session, turn, name, command_norm, command_text, output_excerpt, error_text,
                    CAST(exit_code AS DOUBLE) AS exit_code, has_error, status, ts
FROM tool_call
${sinceDays === undefined ? "" : "WHERE ts >= CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - (CAST(? AS INTEGER) * INTERVAL '1 day')"}
ORDER BY ts DESC`, sinceDays === undefined ? [] : [sinceDays]);
    });

const fetchUserTurns = (write: CacheWriteService, sinceDays: number | undefined): Effect.Effect<readonly UserTurnRow[], CacheReadError> =>
    Effect.gen(function* () {
        return yield* write.rows(Schema.Struct({
            id: Schema.String, session: Schema.String, seq: Schema.Number,
            text_excerpt: Schema.NullOr(Schema.String), ts: TimestampColumn, has_error: Schema.Boolean,
        }), `SELECT id, session, CAST(seq AS DOUBLE) AS seq, text_excerpt, ts, has_error
FROM turn
WHERE role = 'user' ${sinceDays === undefined ? "" : "AND ts >= CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - (CAST(? AS INTEGER) * INTERVAL '1 day')"}
ORDER BY ts DESC`, sinceDays === undefined ? [] : [sinceDays]);
    });

export const deriveOutcomes = (write: CacheWriteService, opts: { sinceDays: number | undefined } = { sinceDays: undefined }): Effect.Effect<OutcomeStats, CacheReadError | CacheWriteError> =>
    Effect.gen(function* () {
        const [toolCalls, userTurns] = yield* Effect.all(
            [
                fetchToolCalls(write, opts.sinceDays).pipe(Effect.withSpan("outcomes.fetch-tool-calls")),
                fetchUserTurns(write, opts.sinceDays).pipe(Effect.withSpan("outcomes.fetch-user-turns")),
            ],
            { concurrency: 2 },
        );
        const outcomes = deriveCommandOutcomes(toolCalls);
        const ngrams = deriveUserMessageNgrams(userTurns);
        yield* write.exec("DELETE FROM user_message_ngram");
        yield* write.putMany("command_outcome", outcomes.map(commandOutcomeRow));
        yield* write.putMany("user_message_ngram", ngrams.map(ngramRow));
        return {
            commandOutcomes: outcomes.length,
            userMessageNgrams: ngrams.length,
        };
    });

// ---------------------------------------------------------------------------
// Co-located StageDef
// ---------------------------------------------------------------------------

import { BaseStageStats, IngestContext, sinceDaysFromCtx, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

export const OutcomesKey = Schema.Literal("outcomes");
export type OutcomesKey = typeof OutcomesKey.Type;

/**
 * Outcomes stage - derives Command outcome rollups + user-turn n-grams.
 * Depends on {@link SignalsKey}.
 */
// Named OutcomesStageStats to avoid collision with the original OutcomeStats interface.
export class OutcomesStageStats extends BaseStageStats.extend<OutcomesStageStats>("OutcomesStageStats")({
    commandOutcomes: Schema.Number,
    userMessageNgrams: Schema.Number,
}) {}

export const outcomesStage: StageDef<OutcomesStageStats, never, import("./stage/registry.ts").IngestStageError> = {
    meta: StageMeta.make({ key: "outcomes", deps: ["signals"], tags: ["derive"] }),
    run: (ctx: IngestContext, write) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const sinceDays = sinceDaysFromCtx(ctx);
            const result = yield* deriveOutcomes(write, { sinceDays });
            return OutcomesStageStats.make({
                durationMs: Date.now() - t0,
                summary: `derived ${result.commandOutcomes} command outcomes, ${result.userMessageNgrams} ngrams`,
                commandOutcomes: result.commandOutcomes,
                userMessageNgrams: result.userMessageNgrams,
            });
        }),
};
