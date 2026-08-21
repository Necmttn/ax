/**
 * The run-evidence SQL models + their cutover (#888).
 *
 * Default implementation of the `run-evidence` stage. The TS builders in
 * derive-run-evidence.ts stay in the tree as the shadow implementation
 * (`AX_RUN_EVIDENCE_IMPL=ts`) for one release; the parity test diffs the two
 * on the natural key.
 *
 * CUTOVER: the models' id scheme (md5 of natural keys) differs from the TS
 * era's Bun.hash-based keys - legitimate because the cache is REBUILDABLE and
 * nothing joins on id shape, but the two schemes must never coexist. A
 * version marker (sentinel watermark row, the established non-file pattern)
 * records which model version built the tables; on mismatch this module
 *   1. backfills `command_outcome.check_family` for pre-stamp history
 *      (rejoining tool_call for command_text, the TS classifier as the single
 *      source of truth),
 *   2. wipes run_evidence_ref + run_evidence_event,
 *   3. runs both models UNWINDOWED once,
 *   4. stamps the marker.
 * Subsequent runs execute the models with the ingest since-window only.
 */
import { Effect, Schema } from "effect";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { watermarkRow, WATERMARK_TABLE } from "@ax/lib/duckdb/watermark";
import { stableDigest } from "@ax/lib/ids";
import { checkFamilyFromCommand } from "../check-family.ts";
import { parseModelHeader, runSqlModel, type SqlModel } from "./runner.ts";
import RUN_EVIDENCE_EVENT_SQL from "./run-evidence-event.sql" with { type: "text" };
import RUN_EVIDENCE_OBJECTIVE_CLEANUP_SQL from "./run-evidence-objective-cleanup.sql" with { type: "text" };
import RUN_EVIDENCE_REF_SQL from "./run-evidence-ref.sql" with { type: "text" };

export const RUN_EVIDENCE_OBJECTIVE_CLEANUP_MODEL: SqlModel = {
    name: "run_evidence_event",
    sql: RUN_EVIDENCE_OBJECTIVE_CLEANUP_SQL,
};
export const RUN_EVIDENCE_EVENT_MODEL: SqlModel = { name: "run_evidence_event", sql: RUN_EVIDENCE_EVENT_SQL };
export const RUN_EVIDENCE_REF_MODEL: SqlModel = { name: "run_evidence_ref", sql: RUN_EVIDENCE_REF_SQL };

/** Ordered: clear affected objectives, replace events, then recompute refs. */
export const RUN_EVIDENCE_MODELS: readonly SqlModel[] = [
    RUN_EVIDENCE_OBJECTIVE_CLEANUP_MODEL,
    RUN_EVIDENCE_EVENT_MODEL,
    RUN_EVIDENCE_REF_MODEL,
];

/** Changes whenever either model's SQL changes -> one full re-derive. */
export const runEvidenceModelVersion = (): string =>
    stableDigest(
        `run-evidence-models-v1${RUN_EVIDENCE_OBJECTIVE_CLEANUP_SQL}${RUN_EVIDENCE_EVENT_SQL}${RUN_EVIDENCE_REF_SQL}`,
    );

const MARKER_SOURCE_KIND = "run_evidence_model";
const MARKER_PATH = "__run_evidence_model__";

const storedModelVersion = (write: CacheWriteService): Effect.Effect<string | null, CacheWriteError> =>
    Effect.gen(function* () {
        const rows = yield* write.rows(
            Schema.Struct({ sha: Schema.NullOr(Schema.String) }),
            `SELECT sha FROM ${WATERMARK_TABLE} WHERE source_kind = ? AND path = ?`,
            [MARKER_SOURCE_KIND, MARKER_PATH],
        );
        return rows[0]?.sha ?? null;
    });

/**
 * Stamp `check_family` onto pre-stamp `command_outcome` history. The outcomes
 * stage stamps every row it writes from here on; this covers rows written
 * before the column existed, rejoining tool_call for the text-first input.
 * The TS classifier remains the single source of truth - SQL never
 * re-implements it (two token-position parsers WILL drift).
 */
export const backfillCheckFamily = (write: CacheWriteService): Effect.Effect<number, CacheWriteError> =>
    Effect.gen(function* () {
        const rows = yield* write.rows(
            Schema.Struct({
                id: Schema.String,
                command_text: Schema.NullOr(Schema.String),
                command_norm: Schema.NullOr(Schema.String),
            }),
            `SELECT co.id, tc.command_text, co.command_norm
             FROM command_outcome co
             LEFT JOIN tool_call tc ON tc.id = co.tool_call
             WHERE co.check_family IS NULL`,
        );
        const byFamily = new Map<string, string[]>();
        for (const row of rows) {
            const family = checkFamilyFromCommand(row.command_text) ?? checkFamilyFromCommand(row.command_norm);
            if (family === null) continue;
            const list = byFamily.get(family);
            if (list) list.push(row.id);
            else byFamily.set(family, [row.id]);
        }
        let updated = 0;
        for (const [family, ids] of byFamily) {
            for (let start = 0; start < ids.length; start += 500) {
                const batch = ids.slice(start, start + 500);
                const placeholders = batch.map(() => "?").join(", ");
                updated += yield* write.exec(
                    `UPDATE command_outcome SET check_family = ? WHERE id IN (${placeholders})`,
                    [family, ...batch],
                );
            }
        }
        return updated;
    });

export interface RunEvidenceModelStats {
    readonly written: number;
    readonly refsWritten: number;
    /** True when this run performed the one-time version cutover. */
    readonly rebuilt: boolean;
    /** check_family rows stamped by the cutover backfill (0 on ordinary runs). */
    readonly backfilled: number;
}

export const runRunEvidenceModels = (
    write: CacheWriteService,
    sinceDays: number | undefined,
): Effect.Effect<RunEvidenceModelStats, CacheWriteError> =>
    Effect.gen(function* () {
        const version = runEvidenceModelVersion();
        const stored = yield* storedModelVersion(write);
        const rebuild = stored !== version;
        let backfilled = 0;
        if (rebuild) {
            backfilled = yield* backfillCheckFamily(write);
            // Order matters: refs point at events, wipe refs first.
            yield* write.exec("DELETE FROM run_evidence_ref");
            yield* write.exec("DELETE FROM run_evidence_event");
        }
        const window = rebuild ? undefined : sinceDays;
        yield* runSqlModel(write, RUN_EVIDENCE_OBJECTIVE_CLEANUP_MODEL, window);
        const written = yield* runSqlModel(write, RUN_EVIDENCE_EVENT_MODEL, window);
        const refsWritten = yield* runSqlModel(write, RUN_EVIDENCE_REF_MODEL, window);
        if (rebuild) {
            yield* write.put(
                WATERMARK_TABLE,
                watermarkRow(MARKER_SOURCE_KIND, MARKER_PATH, { sha: version }),
            );
        }
        return { written, refsWritten, rebuilt: rebuild, backfilled };
    });

// Header contracts are enforced at import time: a malformed model file fails
// the FIRST test or run that loads this module, not silently at 3am.
for (const model of RUN_EVIDENCE_MODELS) {
    const header = parseModelHeader(model.sql);
    if (header.model !== model.name) {
        throw new Error(`model file header says "${header.model}" but is registered as "${model.name}"`);
    }
}
