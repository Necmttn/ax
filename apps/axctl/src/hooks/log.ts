import { Effect, Schema } from "effect";
import { JsonArrayColumn, NumberFromBigIntColumn, TimestampColumn } from "@ax/lib/duckdb/columns";
import { CacheRead, type CacheReadError } from "@ax/lib/duckdb/seam";

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

export interface HookLogQuery {
    readonly sql: string;
    readonly params: ReadonlyArray<string | number | boolean>;
}

export function buildHookLogQuery(opts: HookLogQueryOptions): HookLogQuery {
    const where: string[] = [];
    const params: Array<string | number | boolean> = [];
    if (opts.sinceHours !== undefined) {
        if (!Number.isFinite(opts.sinceHours) || opts.sinceHours <= 0) {
            throw new Error(`hook log --since must be a positive integer, got ${opts.sinceHours}`);
        }
        where.push("ts >= CURRENT_TIMESTAMP - (? * INTERVAL '1 hour')");
        params.push(Math.trunc(opts.sinceHours));
    }
    if (opts.reason !== undefined) { where.push("reason = ?"); params.push(opts.reason); }
    if (opts.file !== undefined) { where.push("file_path = ?"); params.push(opts.file); }
    if (opts.inject !== undefined) { where.push("inject = ?"); params.push(opts.inject); }
    if (opts.harness !== undefined) { where.push("harness = ?"); params.push(opts.harness); }

    const whereClause = where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`;
    const sql = [
        "SELECT ts, harness, event, file_path, inject, reason, latency_ms, injected_titles",
        `FROM hook_fire${whereClause}`,
        "ORDER BY ts DESC",
        `LIMIT ${Math.max(1, Math.trunc(opts.tail))}`,
    ].join("\n");
    return { sql, params };
}

const HookLogRowSchema = Schema.Struct({
    ts: TimestampColumn,
    harness: Schema.String,
    event: Schema.String,
    file_path: Schema.String,
    inject: Schema.Boolean,
    reason: Schema.String,
    latency_ms: NumberFromBigIntColumn,
    injected_titles: JsonArrayColumn(Schema.String),
});

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

export const queryHookLog = (opts: HookLogQueryOptions): Effect.Effect<readonly HookLogRow[], CacheReadError, CacheRead> =>
    Effect.gen(function* () {
        const cache = yield* CacheRead;
        const query = buildHookLogQuery(opts);
        return yield* cache.rows(HookLogRowSchema, query.sql, query.params);
    });
