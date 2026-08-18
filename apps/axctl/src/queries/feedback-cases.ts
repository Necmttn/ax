import { Effect, Schema } from "effect";
import { NumberFromBigIntColumn, TimestampColumn } from "@ax/lib/duckdb/columns";
import { cacheRows } from "@ax/lib/duckdb/query";
import { NO_CLAUSE, andAll, withinDaysClause, type Clause } from "@ax/lib/duckdb/clause";

export const ENFORCE_WORKTREE_CASE_KEY = "enforce_worktree_next_worktree";

export interface FeedbackBacktestOptions {
    readonly sinceDays?: number | undefined;
    readonly tail?: number | undefined;
    readonly window?: number | undefined;
    readonly persist?: boolean | undefined;
}

const HookBacktestCandidateSchemaRow = Schema.Struct({
    id: Schema.String,
    session: Schema.String,
    tool_call: Schema.String,
    ts: TimestampColumn,
    hook_name: Schema.String,
    command: Schema.String,
    provider_status: Schema.String,
    effect: Schema.String,
});

interface ToolCallWindowRow {
    readonly id?: string | undefined;
    readonly seq?: number | null | undefined;
    readonly name?: string | null | undefined;
    readonly command_text?: string | null | undefined;
    readonly command_norm?: string | null | undefined;
    readonly has_error?: boolean | null | undefined;
}

const ToolCallWindowSchemaRow = Schema.Struct({
    id: Schema.String,
    seq: Schema.NullOr(NumberFromBigIntColumn),
    name: Schema.NullOr(Schema.String),
    command_text: Schema.NullOr(Schema.String),
    command_norm: Schema.NullOr(Schema.String),
    has_error: Schema.Boolean,
});

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

/** Candidate-query WHERE clause: the fixed hook-command predicate, plus an
 *  optional `--since` recency filter. `sinceDays` is validated (positive
 *  integer) before it reaches `withinDaysClause`, which needs a real count. */
const candidateFilter = (opts: FeedbackBacktestOptions): Clause => {
    if (opts.sinceDays !== undefined && (!Number.isFinite(opts.sinceDays) || opts.sinceDays <= 0)) {
        throw new Error(`--since must be a positive integer, got ${opts.sinceDays}`);
    }
    return andAll([
        { sql: "WHERE contains(command, 'enforce-worktree') AND tool_call IS NOT NULL", params: [] },
        opts.sinceDays === undefined ? NO_CLAUSE : withinDaysClause("ts", Math.trunc(opts.sinceDays)),
    ]);
};

export function buildEnforceWorktreeCandidateClause(opts: FeedbackBacktestOptions): Clause {
    const tail = Math.max(1, Math.trunc(opts.tail ?? 100));
    const filter = candidateFilter(opts);
    return {
        sql: [
            "SELECT id, session, tool_call, ts, hook_name, command, provider_status, effect",
            "FROM hook_command_invocation",
            filter.sql,
            "ORDER BY ts DESC",
            `LIMIT ${tail}`,
        ].join("\n"),
        params: filter.params,
    };
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

const selectOne = <A>(rows: readonly A[] | undefined): A | null => rows?.[0] ?? null;

const TRIGGER_TOOL_CALL_SQL =
    "SELECT id, seq, name, command_text, command_norm, has_error FROM tool_call WHERE id = ?;";

const WINDOW_TOOL_CALL_SQL = (limit: number) => `
SELECT id, seq, name, command_text, command_norm, has_error
FROM tool_call
WHERE session = ? AND seq > ?
ORDER BY seq ASC
LIMIT ${Math.max(1, Math.trunc(limit))};
`;

export const backtestEnforceWorktreeCase = Effect.fn("queries.backtestEnforceWorktreeCase")(
    function* (opts: FeedbackBacktestOptions = {}) {
        const window = Math.max(1, Math.trunc(opts.window ?? 3));
        const candidates = yield* cacheRows(
            HookBacktestCandidateSchemaRow,
            buildEnforceWorktreeCandidateClause(opts),
            "feedback case candidates",
        );
        const results: FeedbackCaseResultRow[] = [];

        for (const candidate of candidates) {
            const triggerRows = yield* cacheRows(
                ToolCallWindowSchemaRow,
                { sql: TRIGGER_TOOL_CALL_SQL, params: [candidate.tool_call] },
                "feedback case trigger tool call",
            );
            const trigger = selectOne(triggerRows);
            const triggerSeq = typeof trigger?.seq === "number" ? trigger.seq : null;
            const windowRows = triggerSeq === null
                ? []
                : yield* cacheRows(
                    ToolCallWindowSchemaRow,
                    { sql: WINDOW_TOOL_CALL_SQL(window), params: [candidate.session, triggerSeq] },
                    "feedback case window tool calls",
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

        // v2: writes only happen inside `ax ingest`, under the ingest lock
        // (see packages/lib/src/duckdb/seam.ts) - `withCacheWrite` refuses at
        // runtime for any caller that does not hold that lock, which this CLI
        // backtest never does. `feedback_case_type`/`feedback_case_result`
        // are also read by nothing else in the codebase, so there is no
        // consumer waiting on the row - persistence is dropped, not moved.
        if (opts.persist === true) {
            yield* Effect.logWarning(
                "ax hooks cases: --persist has no effect on the DuckDB cache - writes only happen inside " +
                    "ax ingest, under the ingest lock. Results are computed and printed, not stored.",
            );
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
        } satisfies FeedbackBacktestSummary;
    },
);

const dateText = (value: Date | string): string =>
    value instanceof Date ? value.toISOString() : String(value);

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
            result.session,
            result.status,
            result.trigger_seq === null ? "" : String(result.trigger_seq),
            result.reason,
            clip(result.trigger_command),
        ].join("\t"));
    }
    return lines.join("\n");
}
