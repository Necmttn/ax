import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";

export interface RecentInjectsQueryParams {
    readonly sessionRid: string;
    readonly filePaths: readonly string[];
    readonly windowMinutes: number;
}

function safePath(p: string): string {
    if (p.includes("'")) {
        throw new Error(`hook dedup: file path contains a single quote and would break SQL: ${p}`);
    }
    return `'${p}'`;
}

export function buildRecentInjectsQuery(params: RecentInjectsQueryParams): string {
    const list = params.filePaths.map(safePath).join(", ");
    const win = Math.max(1, Math.trunc(params.windowMinutes));
    return [
        "SELECT file_path FROM hook_fire",
        `WHERE session = ${params.sessionRid}`,
        "  AND inject = true",
        `  AND file_path IN [${list}]`,
        `  AND ts >= time::now() - ${win}m`,
        "LIMIT 100;",
    ].join("\n");
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
    // Bare-alphanumeric-only IDs are safe unquoted. Anything else (hyphens,
    // dots, UUIDs) gets backtick-wrapped - bare hyphens in SurrealQL parse as
    // subtraction operators and break the query.
    if (/^[A-Za-z0-9_]+$/.test(id)) return `${table}:${id}`;
    return `${table}:\`${id.replace(/`/g, "")}\``;
}

export const findRecentInjects = (
    params: FindRecentInjectsParams,
): Effect.Effect<ReadonlySet<string>, DbError, SurrealClient> =>
    Effect.gen(function* () {
        if (!params.sessionId || params.filePaths.length === 0) return new Set<string>();
        const sessionRid = parseSessionRid(params.sessionId);
        if (!sessionRid) return new Set<string>();

        const db = yield* SurrealClient;
        const sql = buildRecentInjectsQuery({
            sessionRid,
            filePaths: params.filePaths,
            windowMinutes: params.windowMinutes,
        });
        const [rows] = yield* db.query<[{ file_path: string }[]]>(sql);
        return new Set(rows.map((r) => r.file_path));
    });
