import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";

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

function safeLiteral(value: string): string {
    if (value.includes("'")) {
        throw new Error(`hook query value contains a single quote and would unsafely escape SQL: ${value}`);
    }
    return `'${value}'`;
}

function sessionRecordRef(sessionId: string): string {
    const id = sessionId.replace(/^session:/, "");
    return `session:\`${id.replace(/`/g, "\\`")}\``;
}

function whereClause(opts: Pick<HookQueryOptions, "sinceDays" | "command" | "sessionId">): string {
    const where: string[] = [];
    if (opts.sinceDays !== undefined) {
        if (!Number.isFinite(opts.sinceDays) || opts.sinceDays <= 0) {
            throw new Error(`--since must be a positive integer, got ${opts.sinceDays}`);
        }
        where.push(`ts >= time::now() - ${Math.trunc(opts.sinceDays)}d`);
    }
    if (opts.command !== undefined) {
        where.push(`string::contains(command, ${safeLiteral(opts.command)})`);
    }
    if (opts.sessionId !== undefined) {
        where.push(`session = ${sessionRecordRef(opts.sessionId)}`);
    }
    return where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`;
}

export function buildHookSummaryQuery(opts: HookQueryOptions): string {
    const where = whereClause(opts);
    return [
        "SELECT command, hook_name, provider_status, effect, count() AS count,",
        "       math::mean(duration_ms) AS avg_duration_ms, math::max(duration_ms) AS max_duration_ms,",
        "       time::max(ts) AS last_seen",
        `FROM hook_command_invocation${where}`,
        "GROUP BY command, hook_name, provider_status, effect",
        "ORDER BY count DESC",
        `LIMIT ${Math.max(1, Math.trunc(opts.tail ?? 20))}`,
    ].join("\n");
}

export function buildHookInvocationsQuery(opts: HookQueryOptions): string {
    const where = whereClause(opts);
    return [
        "SELECT ts, <string>session AS session, event_name, hook_name, command, provider_status, effect, duration_ms, exit_code, stdout_excerpt, stderr_excerpt, blocking_error_excerpt",
        `FROM hook_command_invocation${where}`,
        "ORDER BY ts DESC",
        `LIMIT ${Math.max(1, Math.trunc(opts.tail ?? 50))}`,
    ].join("\n");
}

export function buildHookSessionQuery(sessionId: string): string {
    return [
        "SELECT ts, <string>session AS session, event_name, hook_name, tool_call_id, command, provider_status, effect, duration_ms, exit_code, stdout_excerpt, stderr_excerpt, blocking_error_excerpt",
        "FROM hook_command_invocation",
        `WHERE session = ${sessionRecordRef(sessionId)}`,
        "ORDER BY ts ASC",
        "LIMIT 500",
    ].join("\n");
}

export const queryHookSummary = (opts: HookQueryOptions): Effect.Effect<readonly HookSummaryRow[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const [rows] = yield* db.query<[HookSummaryRow[]]>(buildHookSummaryQuery(opts));
        return rows;
    });

export const queryHookInvocations = (opts: HookQueryOptions): Effect.Effect<readonly HookInvocationRow[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const [rows] = yield* db.query<[HookInvocationRow[]]>(buildHookInvocationsQuery(opts));
        return rows;
    });

export const queryHookSession = (sessionId: string): Effect.Effect<readonly HookSessionRow[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const [rows] = yield* db.query<[HookSessionRow[]]>(buildHookSessionQuery(sessionId));
        return rows;
    });

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

export function formatHookSummaryRows(rows: readonly HookSummaryRow[]): string {
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
