import { Effect, Schema } from "effect";
import { CacheRead, type CacheReadError } from "@ax/lib/duckdb/seam";

export interface RecentInjectsQueryParams {
    readonly sessionRid: string;
    readonly filePaths: readonly string[];
    readonly windowMinutes: number;
}

export function buildRecentInjectsQuery(params: RecentInjectsQueryParams): {
    readonly sql: string;
    readonly params: ReadonlyArray<string | Date>;
} {
    const placeholders = params.filePaths.map(() => "?").join(", ");
    const win = Math.max(1, Math.trunc(params.windowMinutes));
    // The window cutoff is computed here, in JS, and bound as a plain
    // timestamp parameter - `CURRENT_TIMESTAMP - (? * INTERVAL '1 minute')`
    // fails to bind in DuckDB (no `-(TIMESTAMPTZ, INTERVAL)` overload resolves
    // for an untyped placeholder multiplied into an INTERVAL), and every
    // value should bind as itself rather than as an expression anyway.
    const since = new Date(Date.now() - win * 60_000);
    const sql = [
        "SELECT file_path FROM hook_fire",
        "WHERE session = ?",
        "  AND inject = true",
        `  AND file_path IN (${placeholders})`,
        "  AND ts >= ?",
        "LIMIT 100;",
    ].join("\n");
    return { sql, params: [params.sessionRid, ...params.filePaths, since] };
}

export interface FindRecentInjectsParams {
    readonly sessionId: string | undefined;
    readonly filePaths: readonly string[];
    readonly windowMinutes: number;
}

function parseSessionRid(value: string): string | null {
    if (!value || !value.includes(":")) return null;
    const idx = value.indexOf(":");
    const table = value.slice(0, idx);
    const id = value.slice(idx + 1);
    if (!table || !id) return null;
    return `${table}:${id.replaceAll("`", "")}`;
}

export const findRecentInjects = (
    params: FindRecentInjectsParams,
): Effect.Effect<ReadonlySet<string>, CacheReadError, CacheRead> =>
    Effect.gen(function* () {
        if (!params.sessionId || params.filePaths.length === 0) return new Set<string>();
        const sessionRid = parseSessionRid(params.sessionId);
        if (!sessionRid) return new Set<string>();

        const cache = yield* CacheRead;
        const query = buildRecentInjectsQuery({
            sessionRid,
            filePaths: params.filePaths,
            windowMinutes: params.windowMinutes,
        });
        const rows = yield* cache.rows(
            Schema.Struct({ file_path: Schema.String }),
            query.sql,
            query.params,
        );
        return new Set(rows.map((r) => r.file_path));
    });
