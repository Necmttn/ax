import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { prettyPrint, surrealLiteral } from "@ax/lib/json";
import { stableDigest } from "@ax/lib/ids";
import { recordRef } from "../ingest/evidence-writers.ts";

export const ENFORCE_WORKTREE_CASE_KEY = "enforce_worktree_next_worktree";

const CASE_TITLE = "Enforce worktree hook leads to worktree correction";
const CASE_SELECTOR = {
    table: "hook_command_invocation",
    commandContains: "enforce-worktree",
    targetRequiresToolCall: true,
};
const CASE_RULE = {
    kind: "short_horizon_tool_window",
    windowToolCalls: 3,
    passedWhen: [
        "a following tool command creates a git worktree",
        "or a following tool command changes into a worktree path",
    ],
    failedWhen: [
        "following tool commands continue without an observable worktree correction",
    ],
};

export interface FeedbackBacktestOptions {
    readonly sinceDays?: number | undefined;
    readonly tail?: number | undefined;
    readonly window?: number | undefined;
    readonly persist?: boolean | undefined;
}

interface HookBacktestCandidateRow {
    readonly id: string;
    readonly session: string;
    readonly tool_call: string;
    readonly ts: Date | string;
    readonly hook_name: string;
    readonly command: string;
    readonly provider_status: string;
    readonly effect: string;
}

interface ToolCallWindowRow {
    readonly id?: string | undefined;
    readonly seq?: number | null | undefined;
    readonly name?: string | null | undefined;
    readonly command_text?: string | null | undefined;
    readonly command_norm?: string | null | undefined;
    readonly has_error?: boolean | null | undefined;
}

export interface FeedbackCaseResultRow {
    readonly target_id: string;
    readonly session: string;
    readonly ts: Date | string;
    readonly hook_name: string;
    readonly hook_command: string;
    readonly provider_status: string;
    readonly trigger_seq: number | null;
    readonly trigger_command: string | null;
    readonly status: "passed" | "failed" | "inconclusive";
    readonly reason: string;
    readonly window: readonly ToolCallWindowRow[];
}

export interface FeedbackBacktestSummary {
    readonly case_type: string;
    readonly analyzed: number;
    readonly passed: number;
    readonly failed: number;
    readonly inconclusive: number;
    readonly pass_rate: number | null;
    readonly results: readonly FeedbackCaseResultRow[];
}

const sqlDate = (value: Date | string): string => {
    const iso = value instanceof Date ? value.toISOString() : String(value);
    return `d${surrealLiteral(iso)}`;
};

const sqlJsonString = (value: unknown): string => surrealLiteral(prettyPrint(value));

const normalizeRecordString = (value: string): string =>
    value
        .replace(/^session:`(.+)`$/, "session:`$1`")
        .replace(/^hook_command_invocation:`?([^`]+)`?$/, "hook_command_invocation:$1");

const sessionIdFromRecordString = (value: string): string =>
    value
        .replace(/^session:/, "")
        .replace(/^`/, "")
        .replace(/`$/, "");

const candidateWhere = (opts: FeedbackBacktestOptions): string => {
    const where = [
        "string::contains(command, 'enforce-worktree')",
        "tool_call IS NOT NONE",
    ];
    if (opts.sinceDays !== undefined) {
        if (!Number.isFinite(opts.sinceDays) || opts.sinceDays <= 0) {
            throw new Error(`--since must be a positive integer, got ${opts.sinceDays}`);
        }
        where.push(`ts >= time::now() - ${Math.trunc(opts.sinceDays)}d`);
    }
    return where.join(" AND ");
};

export function buildEnforceWorktreeCandidateQuery(opts: FeedbackBacktestOptions): string {
    const tail = Math.max(1, Math.trunc(opts.tail ?? 100));
    return [
        "SELECT <string>id AS id, <string>session AS session, <string>tool_call AS tool_call,",
        "       ts, hook_name, command, provider_status, effect",
        "FROM hook_command_invocation",
        `WHERE ${candidateWhere(opts)}`,
        "ORDER BY ts DESC",
        `LIMIT ${tail}`,
    ].join("\n");
}

export function classifyEnforceWorktreeWindow(
    trigger: ToolCallWindowRow | null,
    window: readonly ToolCallWindowRow[],
): Pick<FeedbackCaseResultRow, "status" | "reason"> {
    if (!trigger || typeof trigger.seq !== "number") {
        return {
            status: "inconclusive",
            reason: "trigger tool call was missing or had no sequence",
        };
    }
    if (window.length === 0) {
        return {
            status: "inconclusive",
            reason: "no following tool calls were available in the evaluation window",
        };
    }

    const corrective = window.find((call) => {
        const command = `${call.command_text ?? ""}\n${call.command_norm ?? ""}`.toLowerCase();
        return command.includes("git worktree add") ||
            command.includes("/.worktrees/") ||
            command.includes("/.claude/worktrees/");
    });

    if (corrective) {
        return {
            status: "passed",
            reason: `observed corrective worktree command at tool seq ${corrective.seq ?? "?"}`,
        };
    }

    return {
        status: "failed",
        reason: "no worktree creation or worktree-path command appeared in the following tool calls",
    };
}

function caseTypeStatement(window: number): string {
    return `UPSERT ${recordRef("feedback_case_type", ENFORCE_WORKTREE_CASE_KEY)} MERGE { name: ${surrealLiteral(ENFORCE_WORKTREE_CASE_KEY)}, title: ${surrealLiteral(CASE_TITLE)}, target_kind: "hook_command_invocation", selector_json: ${sqlJsonString(CASE_SELECTOR)}, rule_kind: "deterministic", rule_json: ${sqlJsonString({ ...CASE_RULE, windowToolCalls: window })}, status: "active", updated_at: time::now() };`;
}

function resultStatement(result: FeedbackCaseResultRow): string {
    const resultKey = `${ENFORCE_WORKTREE_CASE_KEY}__${stableDigest(result.target_id, 20)}`;
    return `UPSERT ${recordRef("feedback_case_result", resultKey)} MERGE { case_type: ${recordRef("feedback_case_type", ENFORCE_WORKTREE_CASE_KEY)}, target_kind: "hook_command_invocation", target: ${normalizeRecordString(result.target_id)}, session: ${result.session}, ts: ${sqlDate(result.ts)}, status: ${surrealLiteral(result.status)}, reason: ${surrealLiteral(result.reason)}, window_json: ${sqlJsonString(result.window)}, evidence_json: ${sqlJsonString({ hookName: result.hook_name, hookCommand: result.hook_command, providerStatus: result.provider_status, triggerSeq: result.trigger_seq, triggerCommand: result.trigger_command })}, observed_at: time::now() };`;
}

export function buildFeedbackCasePersistStatements(
    results: readonly FeedbackCaseResultRow[],
    window: number,
): readonly string[] {
    return [
        caseTypeStatement(window),
        ...results.map(resultStatement),
    ];
}

const selectOne = <A>(rows: readonly A[] | undefined): A | null => rows?.[0] ?? null;

export const backtestEnforceWorktreeCase = (
    opts: FeedbackBacktestOptions = {},
): Effect.Effect<FeedbackBacktestSummary, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const window = Math.max(1, Math.trunc(opts.window ?? 3));
        const [candidates] = yield* db.query<[HookBacktestCandidateRow[]]>(buildEnforceWorktreeCandidateQuery(opts));
        const results: FeedbackCaseResultRow[] = [];

        for (const candidate of candidates) {
            const [triggerRows] = yield* db.query<[ToolCallWindowRow[]]>(
                `SELECT <string>id AS id, seq, name, command_text, command_norm, has_error FROM ${candidate.tool_call};`,
            );
            const trigger = selectOne(triggerRows);
            const triggerSeq = typeof trigger?.seq === "number" ? trigger.seq : null;
            const [windowRows] = triggerSeq === null
                ? [[] as ToolCallWindowRow[]]
                : yield* db.query<[ToolCallWindowRow[]]>(
                    `SELECT <string>id AS id, seq, name, command_text, command_norm, has_error FROM tool_call WHERE string::contains(<string>session, ${surrealLiteral(sessionIdFromRecordString(candidate.session))}) AND seq > ${triggerSeq} ORDER BY seq ASC LIMIT ${window};`,
                );
            const classification = classifyEnforceWorktreeWindow(trigger, windowRows);
            results.push({
                target_id: candidate.id,
                session: candidate.session,
                ts: candidate.ts,
                hook_name: candidate.hook_name,
                hook_command: candidate.command,
                provider_status: candidate.provider_status,
                trigger_seq: triggerSeq,
                trigger_command: trigger?.command_text ?? null,
                status: classification.status,
                reason: classification.reason,
                window: windowRows,
            });
        }

        if (opts.persist !== false) {
            const statements = buildFeedbackCasePersistStatements(results, window);
            for (let i = 0; i < statements.length; i += 100) {
                yield* db.query(statements.slice(i, i + 100).join(""));
            }
        }

        const passed = results.filter((row) => row.status === "passed").length;
        const failed = results.filter((row) => row.status === "failed").length;
        const inconclusive = results.filter((row) => row.status === "inconclusive").length;
        const decisive = passed + failed;
        return {
            case_type: ENFORCE_WORKTREE_CASE_KEY,
            analyzed: results.length,
            passed,
            failed,
            inconclusive,
            pass_rate: decisive === 0 ? null : passed / decisive,
            results,
        };
    });

const dateText = (value: Date | string): string =>
    value instanceof Date ? value.toISOString() : String(value);

const sessionText = (value: string): string =>
    sessionIdFromRecordString(value);

const clip = (value: string | null | undefined, max = 100): string => {
    if (!value) return "";
    const oneLine = value.replace(/\s+/g, " ").trim();
    return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
};

export function formatFeedbackBacktestSummary(summary: FeedbackBacktestSummary): string {
    const rate = summary.pass_rate === null ? "n/a" : `${Math.round(summary.pass_rate * 100)}%`;
    const lines = [
        `case\t${summary.case_type}`,
        `summary\tanalyzed=${summary.analyzed}\tpassed=${summary.passed}\tfailed=${summary.failed}\tinconclusive=${summary.inconclusive}\tpass_rate=${rate}`,
        "ts\tsession\tstatus\ttrigger_seq\treason\ttrigger_command",
    ];
    for (const result of summary.results) {
        lines.push([
            dateText(result.ts),
            sessionText(result.session),
            result.status,
            result.trigger_seq === null ? "" : String(result.trigger_seq),
            result.reason,
            clip(result.trigger_command),
        ].join("\t"));
    }
    return lines.join("\n");
}
