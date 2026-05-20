import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { AppLayer } from "../lib/layers.ts";
import type { DbError } from "../lib/errors.ts";
import { recordRef } from "./evidence-writers.ts";
import { surrealDate, surrealJsonOption, surrealObject, surrealOptionDate, surrealOptionString, surrealString } from "../lib/shared/surql.ts";

type TimestampInput = Date | string | { readonly constructor: { readonly name: string }; toString(): string };

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
    readonly turn?: unknown;
    readonly name?: string | null;
    readonly command_norm?: string | null;
    readonly command_text?: string | null;
    readonly output_excerpt?: string | null;
    readonly error_text?: string | null;
    readonly exit_code?: number | null;
    readonly has_error?: boolean | null;
    readonly status?: string | null;
    readonly ts?: TimestampInput | null;
}

interface UserTurnRow {
    readonly id?: unknown;
    readonly session?: unknown;
    readonly seq?: number | null;
    readonly text_excerpt?: string | null;
    readonly ts?: TimestampInput | null;
    readonly has_error?: boolean | null;
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

const safeKeyPart = (value: string): string => {
    const sanitized = value
        .replace(/:/g, "__")
        .replace(/[^a-zA-Z0-9_]+/g, "_")
        .replace(/_{3,}/g, "__")
        .replace(/^_+|_+$/g, "");
    return sanitized.length > 0 ? sanitized.slice(0, 96) : Bun.hash(value).toString(16);
};

const isoTimestamp = (value: TimestampInput | null | undefined): string => {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "string" && value.length > 0) return value;
    if (value && typeof value === "object" && value.constructor.name === "DateTime") return String(value);
    return new Date(0).toISOString();
};

const recordKeyPart = (value: unknown, expectedTable?: string): string | null => {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") {
        let raw = value.trim();
        const prefix = expectedTable ? `${expectedTable}:` : null;
        if (prefix && raw.startsWith(prefix)) raw = raw.slice(prefix.length);
        else if (raw.includes(":")) raw = raw.slice(raw.indexOf(":") + 1);
        if ((raw.startsWith("`") && raw.endsWith("`")) || (raw.startsWith("⟨") && raw.endsWith("⟩"))) {
            raw = raw.slice(1, -1);
        }
        return raw.length > 0 ? raw : null;
    }
    if (typeof value === "object" && "id" in value) {
        const id = (value as { id: unknown }).id;
        return id === null || id === undefined ? null : String(id);
    }
    return null;
};

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
    if (/\b(test|typecheck|tsc|tsgo|lint|oxc|build|check)\b/.test(command)) {
        if (/fail|error|expected|assert|type|lint|diagnostic|compile/.test(text)) return "expected_feedback";
        return "product_bug_signal";
    }
    if (/no such file|not a git repository|unknown option|bad args|invalid argument|wrong path|cannot find/.test(text)) return "workflow_error";
    return "unknown";
}

function commandOutcomeKey(row: ToolCallOutcomeRow, index: number): string {
    const toolCallKey = recordKeyPart(row.id, "tool_call");
    if (toolCallKey) return `tool_call__${safeKeyPart(toolCallKey)}__${Bun.hash(toolCallKey).toString(16).slice(0, 12)}`;
    const seed = `${recordKeyPart(row.session, "session") ?? "session"}:${row.command_norm ?? row.name ?? "command"}:${index}`;
    return `derived__${safeKeyPart(seed)}__${Bun.hash(seed).toString(16).slice(0, 12)}`;
}

export function deriveCommandOutcomes(rows: readonly ToolCallOutcomeRow[]): CommandOutcome[] {
    return rows.map((row, index) => {
        const toolCallKey = recordKeyPart(row.id, "tool_call");
        const sessionKey = recordKeyPart(row.session, "session");
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

const STOP_WORDS = new Set([
    "the", "and", "for", "that", "this", "with", "you", "can", "are", "was", "were", "have", "has", "but", "not", "from", "into",
    "if", "there", "to", "see", "your", "our", "their", "then", "when", "what", "how", "why", "does", "did", "would", "should",
    "could", "let", "lets", "we", "my", "me", "it", "its", "is", "in", "on", "as", "of", "or", "be", "so", "do",
]);

function tokens(text: string): string[] {
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
        const sessionKey = recordKeyPart(row.session, "session") ?? "unknown";
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

function commandOutcomeStatement(outcome: CommandOutcome): string {
    return `UPSERT ${recordRef("command_outcome", outcome.key)} MERGE ${surrealObject([
        ["tool_call", outcome.toolCallKey ? recordRef("tool_call", outcome.toolCallKey) : "NONE"],
        ["session", outcome.sessionKey ? recordRef("session", outcome.sessionKey) : "NONE"],
        ["command_norm", surrealOptionString(outcome.commandNorm)],
        ["command_tool", surrealOptionString(outcome.commandTool)],
        ["kind", surrealString(outcome.kind)],
        ["status", surrealString(outcome.status)],
        ["text", surrealOptionString(outcome.text)],
        ["labels", surrealJsonOption(outcome.labels)],
        ["metrics", surrealJsonOption(outcome.metrics)],
        ["ts", surrealDate(outcome.ts)],
    ])};`;
}

function ngramStatement(item: NgramAggregate): string {
    const key = `${item.n}__${safeKeyPart(item.ngram)}__${Bun.hash(item.ngram).toString(16).slice(0, 12)}`;
    return `UPSERT ${recordRef("user_message_ngram", key)} MERGE ${surrealObject([
        ["ngram", surrealString(item.ngram)],
        ["n", item.n.toString(10)],
        ["count", item.count.toString(10)],
        ["sessions", surrealJsonOption([...item.sessions].slice(0, 100))],
        ["near_correction_count", item.nearCorrectionCount.toString(10)],
        ["near_failed_tool_count", item.nearFailedToolCount.toString(10)],
        ["near_edit_count", item.nearEditCount.toString(10)],
        ["near_verification_count", item.nearVerificationCount.toString(10)],
        ["first_seen", surrealOptionDate(item.firstSeen)],
        ["last_seen", surrealOptionDate(item.lastSeen)],
    ])};`;
}

const fetchToolCalls = (sinceDays: number | undefined): Effect.Effect<ToolCallOutcomeRow[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const since = sinceDays && sinceDays > 0 ? `WHERE ts > time::now() - ${sinceDays}d` : "";
        const result = yield* db.query<[ToolCallOutcomeRow[]]>(`
SELECT id, session, turn, name, command_norm, command_text, output_excerpt, error_text, exit_code, has_error, status, type::string(ts) AS ts
FROM tool_call
${since}
ORDER BY ts DESC;`);
        return result?.[0] ?? [];
    });

const fetchUserTurns = (sinceDays: number | undefined): Effect.Effect<UserTurnRow[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const since = sinceDays && sinceDays > 0 ? `AND ts > time::now() - ${sinceDays}d` : "";
        const result = yield* db.query<[UserTurnRow[]]>(`
SELECT id, session, seq, text_excerpt, type::string(ts) AS ts, has_error
FROM turn
WHERE role = "user" ${since}
ORDER BY ts DESC;`);
        return result?.[0] ?? [];
    });

export const deriveOutcomes = (opts: { sinceDays: number | undefined } = { sinceDays: undefined }): Effect.Effect<OutcomeStats, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const [toolCalls, userTurns] = yield* Effect.all(
            [fetchToolCalls(opts.sinceDays), fetchUserTurns(opts.sinceDays)],
            { concurrency: 2 },
        );
        const outcomes = deriveCommandOutcomes(toolCalls);
        const ngrams = deriveUserMessageNgrams(userTurns);
        const statements = [
            ...outcomes.map(commandOutcomeStatement),
            ...ngrams.map(ngramStatement),
        ];
        yield* db.query("DELETE user_message_ngram;");
        for (let i = 0; i < statements.length; i += 500) {
            yield* db.query(statements.slice(i, i + 500).join(""));
        }
        return {
            commandOutcomes: outcomes.length,
            userMessageNgrams: ngrams.length,
        };
    });

if (import.meta.main) {
    const sinceArg = process.argv.find((a) => a.startsWith("--since="));
    const sinceDays = sinceArg ? parseInt(sinceArg.split("=")[1], 10) : undefined;
    await Effect.runPromise(
        deriveOutcomes({ sinceDays }).pipe(
            Effect.provide(AppLayer),
            Effect.scoped,
        ) as Effect.Effect<OutcomeStats>,
    );
}
