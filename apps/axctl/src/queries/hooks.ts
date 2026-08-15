import { Effect, Schema } from "effect";
import type { Clause } from "@ax/lib/duckdb/clause";
import { NumberFromBigIntColumn, TimestampColumn } from "@ax/lib/duckdb/columns";
import { cacheRows } from "@ax/lib/duckdb/query";

export interface HookSummaryRow {
    readonly command: string;
    readonly hook_name: string;
    readonly provider_status: string;
    readonly effect: string;
    readonly count: number;
    readonly avg_duration_ms?: number | null;
    readonly max_duration_ms?: number | null;
    readonly last_seen?: Date | string | null;
}

export interface HookInvocationRow {
    readonly ts: Date | string;
    readonly session: string;
    readonly event_name: string;
    readonly hook_name: string;
    readonly command: string;
    readonly provider_status: string;
    readonly effect: string;
    readonly duration_ms?: number | null;
    readonly exit_code?: number | null;
    readonly stdout_excerpt?: string | null;
    readonly stderr_excerpt?: string | null;
    readonly blocking_error_excerpt?: string | null;
}

export interface HookSessionRow extends HookInvocationRow {
    readonly tool_call_id?: string | null;
}

export interface HookQueryOptions {
    readonly sinceDays?: number | undefined;
    readonly tail?: number | undefined;
    readonly command?: string | undefined;
    readonly sessionId?: string | undefined;
}

function whereClause(opts: Pick<HookQueryOptions, "sinceDays" | "command" | "sessionId">): Clause {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (opts.sinceDays !== undefined) {
        if (!Number.isFinite(opts.sinceDays) || opts.sinceDays <= 0) {
            throw new Error(`--since must be a positive integer, got ${opts.sinceDays}`);
        }
        where.push("ts >= CURRENT_TIMESTAMP - (? * INTERVAL '1 day')");
        params.push(Math.trunc(opts.sinceDays));
    }
    if (opts.command !== undefined) {
        where.push("contains(command, ?)");
        params.push(opts.command);
    }
    if (opts.sessionId !== undefined) {
        where.push("session = ?");
        params.push(opts.sessionId.startsWith("session:") ? opts.sessionId : `session:${opts.sessionId}`);
    }
    return { sql: where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`, params };
}

export function buildHookSummaryQuery(opts: HookQueryOptions): Clause {
    const where = whereClause(opts);
    return { sql: [
        "SELECT command, hook_name, provider_status, effect, count(*) AS count,",
        "       avg(duration_ms) AS avg_duration_ms, max(duration_ms) AS max_duration_ms,",
        "       max(ts) AS last_seen",
        `FROM hook_command_invocation${where.sql}`,
        "GROUP BY command, hook_name, provider_status, effect",
        "ORDER BY count DESC",
        "LIMIT ?",
    ].join("\n"), params: [...where.params, Math.max(1, Math.trunc(opts.tail ?? 20))] };
}

export function buildHookInvocationsQuery(opts: HookQueryOptions): Clause {
    const where = whereClause(opts);
    return { sql: [
        "SELECT ts, session, event_name, hook_name, command, provider_status, effect, duration_ms, exit_code, stdout_excerpt, stderr_excerpt, blocking_error_excerpt",
        `FROM hook_command_invocation${where.sql}`,
        "ORDER BY ts DESC",
        "LIMIT ?",
    ].join("\n"), params: [...where.params, Math.max(1, Math.trunc(opts.tail ?? 50))] };
}

export function buildHookSessionQuery(sessionId: string): Clause {
    return { sql: [
        "SELECT ts, session, event_name, hook_name, tool_call_id, command, provider_status, effect, duration_ms, exit_code, stdout_excerpt, stderr_excerpt, blocking_error_excerpt",
        "FROM hook_command_invocation",
        "WHERE session = ?",
        "ORDER BY ts ASC",
        "LIMIT 500",
    ].join("\n"), params: [sessionId.startsWith("session:") ? sessionId : `session:${sessionId}`] };
}

const HookSummaryDbRow = Schema.Struct({ command: Schema.String, hook_name: Schema.String, provider_status: Schema.String, effect: Schema.String, count: NumberFromBigIntColumn, avg_duration_ms: Schema.NullOr(Schema.Number), max_duration_ms: Schema.NullOr(Schema.Number), last_seen: Schema.NullOr(TimestampColumn) });
const HookInvocationDbRow = Schema.Struct({ ts: TimestampColumn, session: Schema.String, event_name: Schema.String, hook_name: Schema.String, command: Schema.String, provider_status: Schema.String, effect: Schema.String, duration_ms: Schema.NullOr(Schema.Number), exit_code: Schema.NullOr(Schema.Number), stdout_excerpt: Schema.NullOr(Schema.String), stderr_excerpt: Schema.NullOr(Schema.String), blocking_error_excerpt: Schema.NullOr(Schema.String) });
const HookSessionDbRow = Schema.Struct({ ...HookInvocationDbRow.fields, tool_call_id: Schema.NullOr(Schema.String) });

export const queryHookSummary = Effect.fn("queries.queryHookSummary")(
    function* (opts: HookQueryOptions) {
        return yield* cacheRows(HookSummaryDbRow, buildHookSummaryQuery(opts), "hook summary");
    },
);

export const queryHookInvocations = Effect.fn("queries.queryHookInvocations")(
    function* (opts: HookQueryOptions) {
        return yield* cacheRows(HookInvocationDbRow, buildHookInvocationsQuery(opts), "hook invocations");
    },
);

export const queryHookSession = Effect.fn("queries.queryHookSession")(
    function* (sessionId: string) {
        return yield* cacheRows(HookSessionDbRow, buildHookSessionQuery(sessionId), "hook session");
    },
);

const clip = (value: string | null | undefined, max = 80): string => {
    if (!value) return "";
    const oneLine = value.replace(/\s+/g, " ").trim();
    return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
};

const dateText = (value: Date | string | null | undefined): string =>
    value instanceof Date ? value.toISOString() : value ? String(value) : "";

const finiteNumberText = (value: number | null | undefined, transform: (n: number) => number = (n) => n): string =>
    typeof value === "number" && Number.isFinite(value) ? String(transform(value)) : "";

const sessionText = (value: string): string =>
    value
        .replace(/^session:/, "")
        .replace(/^`/, "")
        .replace(/`$/, "");

/**
 * What an empty hook table actually means (#743).
 *
 * A bare header row reads as "this hook never fired", which is a claim ax
 * cannot make: the harness records a fire only when the hook produced output
 * (an outcome attachment) or blocked a call (named in the tool-result text). A
 * guard that passes silently writes nothing anywhere. Users read the silence as
 * evidence and scored hook experiments as unused against transcripts that
 * proved otherwise - so say it out loud instead.
 */
export const HOOK_EMPTY_NOTE = [
    "(no hook invocations recorded)",
    "ax observes a fire only when the harness writes one: a hook that printed output,",
    "or one that BLOCKED a call (recovered from the tool-result text). A hook that",
    "passes silently leaves no trace in the transcript, so an empty table is not proof",
    "the hook never ran.",
    "Blocked fires from before ax 0.33 need a re-read: ax ingest --reparse=claude",
].join("\n");

export function formatHookSummaryRows(rows: readonly HookSummaryRow[]): string {
    if (rows.length === 0) return HOOK_EMPTY_NOTE;
    const lines = ["count\tstatus\teffect\tavg_ms\tmax_ms\tlast_seen\thook\tcommand"];
    for (const row of rows) {
        lines.push([
            String(row.count),
            row.provider_status,
            row.effect,
            finiteNumberText(row.avg_duration_ms, Math.round),
            finiteNumberText(row.max_duration_ms),
            dateText(row.last_seen),
            row.hook_name,
            clip(row.command, 120),
        ].join("\t"));
    }
    return lines.join("\n");
}

export function formatHookInvocationRows(rows: readonly HookInvocationRow[]): string {
    if (rows.length === 0) return HOOK_EMPTY_NOTE;
    const lines = ["ts\tsession\tstatus\teffect\tduration_ms\thook\tcommand\tdetail"];
    for (const row of rows) {
        lines.push([
            dateText(row.ts),
            sessionText(String(row.session)),
            row.provider_status,
            row.effect,
            finiteNumberText(row.duration_ms),
            row.hook_name,
            clip(row.command, 100),
            clip(row.blocking_error_excerpt ?? row.stderr_excerpt ?? row.stdout_excerpt, 120),
        ].join("\t"));
    }
    return lines.join("\n");
}
