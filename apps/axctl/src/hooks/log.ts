import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";

export interface HookLogRow {
    readonly ts: Date;
    readonly harness: string;
    readonly event: string;
    readonly file_path: string;
    readonly inject: boolean;
    readonly reason: string;
    readonly latency_ms: number;
    readonly injected_titles?: readonly string[] | undefined;
}

export interface HookLogQueryOptions {
    readonly tail: number;
    readonly sinceHours?: number | undefined;
    readonly reason?: string | undefined;
    readonly file?: string | undefined;
    readonly inject?: boolean | undefined;
    readonly harness?: string | undefined;
}

function safeLiteral(value: string): string {
    if (value.includes("'")) {
        throw new Error(`hook log filter value contains a single quote and would unsafely escape the SQL string: ${value}`);
    }
    return `'${value}'`;
}

export function buildHookLogQuery(opts: HookLogQueryOptions): string {
    const where: string[] = [];
    if (opts.sinceHours !== undefined) {
        if (!Number.isFinite(opts.sinceHours) || opts.sinceHours <= 0) {
            throw new Error(`hook log --since must be a positive integer, got ${opts.sinceHours}`);
        }
        where.push(`ts >= time::now() - ${Math.trunc(opts.sinceHours)}h`);
    }
    if (opts.reason !== undefined) where.push(`reason = ${safeLiteral(opts.reason)}`);
    if (opts.file !== undefined) where.push(`file_path = ${safeLiteral(opts.file)}`);
    if (opts.inject !== undefined) where.push(`inject = ${opts.inject ? "true" : "false"}`);
    if (opts.harness !== undefined) where.push(`harness = ${safeLiteral(opts.harness)}`);

    const whereClause = where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`;
    return [
        "SELECT ts, harness, event, file_path, inject, reason, latency_ms, injected_titles",
        `FROM hook_fire${whereClause}`,
        "ORDER BY ts DESC",
        `LIMIT ${Math.max(1, Math.trunc(opts.tail))}`,
    ].join("\n");
}

const TSV_HEADERS = ["ts", "harness", "event", "file", "inject", "reason", "latency_ms", "injected"];

const TITLE_DISPLAY_MAX = 60;

const clipForTsv = (s: string, n: number): string =>
    s.length <= n ? s : `${s.slice(0, n - 1)}…`;

function formatInjectedTitles(titles: readonly string[] | undefined): string {
    if (!titles || titles.length === 0) return "";
    return titles.map((t) => clipForTsv(t.replace(/\s+/g, " ").trim(), TITLE_DISPLAY_MAX)).join(" | ");
}

export function formatHookLogRowsTsv(rows: readonly HookLogRow[]): string {
    const lines = [TSV_HEADERS.join("\t")];
    for (const row of rows) {
        lines.push([
            row.ts instanceof Date ? row.ts.toISOString() : String(row.ts),
            row.harness,
            row.event,
            row.file_path,
            row.inject ? "true" : "false",
            row.reason,
            String(row.latency_ms),
            formatInjectedTitles(row.injected_titles),
        ].join("\t"));
    }
    return lines.join("\n");
}

export const queryHookLog = (opts: HookLogQueryOptions): Effect.Effect<readonly HookLogRow[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const sql = buildHookLogQuery(opts);
        const [rows] = yield* db.query<[HookLogRow[]]>(sql);
        return rows.map((row) => ({
            ...row,
            ts: row.ts instanceof Date ? row.ts : new Date(row.ts as unknown as string),
        }));
    });
