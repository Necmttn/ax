/**
 * Hook telemetry rows (`hook_fire`).
 *
 * NOT PORTED TO THE CACHE, and not portable as it stands - the reason is worth
 * writing down because it looks like an oversight otherwise.
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
 * Everything below therefore stays on the Surreal path until that lands.
 * `deterministicId` and {@link TelemetryBaseRow} are engine-neutral and survive
 * whatever replaces the write. See REPORT.md for w2-lib-core.
 */
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { SurrealClient } from "./db.ts";
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
