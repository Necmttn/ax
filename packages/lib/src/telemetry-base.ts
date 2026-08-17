/**
 * Hook telemetry rows (`hook_fire`).
 *
 * Request-time code does not write this row directly. It appends a bounded,
 * synced JSONL spool. A later ingest stage maps each row with
 * {@link telemetryCacheRow} and writes it through `CacheWriteService`.
 *
 * The only caller is `hooks/telemetry.ts`, reached from `ax hooks file-context`,
 * which a PreToolUse hook runs MID-TURN in the agent's process. In v2 a write
 * needs the ingest lock (`withCacheWrite` refuses without it - the lock IS the
 * write capability), and a hook can neither hold that lock nor wait for one an
 * ingest is holding: it has ~70ms and it must never block the agent. So this is
 * not a query to translate, it is a write that has to become an APPEND to a
 * spool file that a later ingest stage drains - exactly the shape
 * `w0-otlp-spool` gave OTLP, and the same shape the judgment sidecar takes in
 * wave 3.
 *
 * `deterministicId` and {@link TelemetryBaseRow} stay engine-neutral. This
 * module contains no database client and no request-time write capability.
 */
import { createHash } from "node:crypto";
import { cacheRow, jsonParam, tsParam } from "./duckdb/row.ts";
import type { DuckDbParam } from "./duckdb/types.ts";

export type TelemetryHarness = "claude" | "codex" | "unknown";

export interface TelemetryBaseRow {
    readonly id: string;
    readonly ts: Date;
    readonly kind: string;
    readonly session?: string | undefined;
    readonly file?: string | undefined;
    readonly file_path: string;
    readonly harness: TelemetryHarness;
    readonly ok: boolean;
    readonly latency_ms: number;
}

export function deterministicId(parts: readonly string[]): string {
    return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

/**
 * A stored `table:id` ref reduced to the BARE row id, or `null` when there is
 * nothing to reduce.
 *
 * `session` and `file` can arrive as `table:id` refs (`session:⟨uuid⟩`), and
 * the cache's own `session.id` IS that bare uuid (see `sessionRowId` - the one
 * table whose row id is the provider's identifier verbatim). So a ref carried
 * across unchanged would join to nothing at all - a silently empty enrichment
 * rather than an error. A value that is already bare passes through.
 */
const bareRowId = (value: string | undefined): string | null => {
    if (!value) return null;
    const colon = value.indexOf(":");
    const id = colon < 0 ? value : value.slice(colon + 1);
    const bare = id.replace(/^⟨|⟩$/g, "");
    return bare.length > 0 ? bare : null;
};

/** Column names whose value is a row reference rather than a plain string. */
const REF_COLUMNS: ReadonlySet<string> = new Set(["session", "file"]);

/**
 * One telemetry row as a CACHE row - the writer-side half of the port.
 *
 * The write itself cannot be ported (see the module header: a hook holds no
 * ingest lock), but the row shape can, and it is the half that has to be right
 * before any spool-drain stage can exist. Three conversions, all of which fail
 * late rather than at the call site if a future writer improvises them:
 *
 *  - a record REF becomes a bare row id (see {@link bareRowId});
 *  - an array or nested object becomes JSON TEXT, because the DDL stores every
 *    one of them in a VARCHAR (`hook_fire.top_prior_sessions` and
 *    `injected_titles` are both JSON columns);
 *  - a `Date` binds as a `Date`, and `undefined` becomes a NULL that KEEPS its
 *    column, so a batch of these rows is never ragged.
 *
 * Scalars pass through untouched - including `false` and `0`, which a truthiness
 * test would have quietly dropped.
 */
export const telemetryCacheRow = <T extends TelemetryBaseRow>(
    row: T,
): Record<string, DuckDbParam> => {
    const out: Record<string, DuckDbParam> = {};
    for (const [column, value] of Object.entries(row)) {
        if (REF_COLUMNS.has(column)) {
            out[column] = bareRowId(typeof value === "string" ? value : undefined);
        } else if (value instanceof Date) {
            out[column] = tsParam(value);
        } else if (typeof value === "object" && value !== null) {
            out[column] = jsonParam(value);
        } else {
            out[column] = value === undefined ? null : (value as DuckDbParam);
        }
    }
    return cacheRow(out);
};
