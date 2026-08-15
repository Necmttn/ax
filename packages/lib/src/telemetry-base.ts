/**
 * Hook telemetry rows (`hook_fire`).
 *
 * THE ROW SHAPE IS PORTED ({@link telemetryCacheRow}); THE WRITE IS NOT, and
 * cannot be as it stands. The reason is worth writing down, because a half-ported
 * module looks like an oversight otherwise.
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
 * So `writeTelemetryRow` and its statement builder stay on the Surreal path
 * until that lands, while {@link telemetryCacheRow} - the half that is a pure
 * value mapping, and the half a spool-drain stage will need on day one - is
 * ported and tested against the real `hook_fire` table now. `deterministicId`
 * and {@link TelemetryBaseRow} are engine-neutral and survive either way. See
 * REPORT.md for w2-lib-core.
 */
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { SurrealClient } from "./db.ts";
import { cacheRow, jsonParam, tsParam } from "./duckdb/row.ts";
import type { DuckDbParam } from "./duckdb/types.ts";
import type { DbError } from "./errors.ts";
import { recordRef, surrealObject, surrealValue } from "./shared/surql.ts";
import { executeStatements } from "./shared/statement-exec.ts";

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
 * `session` and `file` arrive as SurrealDB refs (`session:⟨uuid⟩`), and the
 * cache's own `session.id` IS that uuid (see `sessionRowId` - the one table
 * whose row id is the provider's identifier verbatim). So a ref carried across
 * unchanged would join to nothing at all - a silently empty enrichment rather
 * than an error. A value that is already bare passes through.
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

/** Turn a stored `table:id` ref string into a `recordRef` literal, or `null`
 *  if it does not parse. Strips the SurrealDB `⟨⟩` id delimiters. */
const refLiteral = (value: string | undefined): string | null => {
    if (!value) return null;
    const idx = value.indexOf(":");
    if (idx < 0) return null;
    const table = value.slice(0, idx);
    const id = value.slice(idx + 1).replace(/^⟨|⟩$/g, "");
    if (!table || !id) return null;
    return recordRef(table, id);
};

/**
 * Build the `UPSERT` statement for one telemetry row. `id` becomes the record
 * key; `session`/`file` become record refs; every other field is encoded by
 * `surrealValue`. This is the hook-side counterpart to the typed statement
 * builders in `evidence-writers.ts` - same seam, same escaping.
 */
export const buildTelemetryRowStatement = <T extends TelemetryBaseRow>(
    table: string,
    row: T,
): string => {
    const { id, session, file, ...rest } = row;
    const fields: Array<[string, string]> = [];
    const sessionRef = refLiteral(session);
    if (sessionRef) fields.push(["session", sessionRef]);
    const fileRef = refLiteral(file);
    if (fileRef) fields.push(["file", fileRef]);
    for (const [k, v] of Object.entries(rest)) {
        fields.push([k, surrealValue(v)]);
    }
    return `UPSERT ${recordRef(table, id)} CONTENT ${surrealObject(fields)};`;
};

export const writeTelemetryRow = <T extends TelemetryBaseRow>(
    table: string,
    row: T,
): Effect.Effect<void, DbError, SurrealClient> =>
    executeStatements([buildTelemetryRowStatement(table, row)]);
