/**
 * The cache-bust SQL model + its cutover (#868).
 *
 * Sibling of run-evidence-models.ts, two ordered models and no
 * check_family backfill: `cache_bust_event` is a priced 1:1 projection of the
 * usage rows that carry a cache_miss_reason, so the only cutover work when
 * the model SQL changes is wipe + one unwindowed run (cheap - the busted
 * subset is ~2% of turn_token_usage). The version marker is the established
 * sentinel-watermark pattern, so two revisions of the derivation never
 * coexist in the table.
 */
import { Effect, Schema } from "effect";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { watermarkRow, WATERMARK_TABLE } from "@ax/lib/duckdb/watermark";
import { stableDigest } from "@ax/lib/ids";
import { parseModelHeader, runSqlModel, type SqlModel } from "./runner.ts";
import CACHE_BUST_EVENT_CLEANUP_SQL from "./cache-bust-event-cleanup.sql" with { type: "text" };
import CACHE_BUST_EVENT_SQL from "./cache-bust-event.sql" with { type: "text" };

export const CACHE_BUST_EVENT_CLEANUP_MODEL: SqlModel = {
    name: "cache_bust_event",
    sql: CACHE_BUST_EVENT_CLEANUP_SQL,
};
export const CACHE_BUST_EVENT_MODEL: SqlModel = { name: "cache_bust_event", sql: CACHE_BUST_EVENT_SQL };

/** Ordered: remove cleared source rows before the insert/upsert model runs. */
export const CACHE_BUST_MODELS: readonly SqlModel[] = [CACHE_BUST_EVENT_CLEANUP_MODEL, CACHE_BUST_EVENT_MODEL];

/** Changes whenever the model's SQL changes -> one full re-derive. */
export const cacheBustModelVersion = (): string =>
    stableDigest(`cache-bust-models-v1${CACHE_BUST_EVENT_CLEANUP_SQL}${CACHE_BUST_EVENT_SQL}`);

const MARKER_SOURCE_KIND = "cache_bust_model";
const MARKER_PATH = "__cache_bust_model__";

const storedModelVersion = (write: CacheWriteService): Effect.Effect<string | null, CacheWriteError> =>
    Effect.gen(function* () {
        const rows = yield* write.rows(
            Schema.Struct({ sha: Schema.NullOr(Schema.String) }),
            `SELECT sha FROM ${WATERMARK_TABLE} WHERE source_kind = ? AND path = ?`,
            [MARKER_SOURCE_KIND, MARKER_PATH],
        );
        return rows[0]?.sha ?? null;
    });

export interface CacheBustModelStats {
    readonly written: number;
    /** True when this run performed the one-time version cutover. */
    readonly rebuilt: boolean;
}

export const runCacheBustModels = (
    write: CacheWriteService,
    sinceDays: number | undefined,
): Effect.Effect<CacheBustModelStats, CacheWriteError> =>
    Effect.gen(function* () {
        const version = cacheBustModelVersion();
        const stored = yield* storedModelVersion(write);
        const rebuild = stored !== version;
        if (rebuild) {
            yield* write.exec("DELETE FROM cache_bust_event");
        }
        const window = rebuild ? undefined : sinceDays;
        yield* runSqlModel(write, CACHE_BUST_EVENT_CLEANUP_MODEL, window);
        const written = yield* runSqlModel(write, CACHE_BUST_EVENT_MODEL, window);
        if (rebuild) {
            yield* write.put(
                WATERMARK_TABLE,
                watermarkRow(MARKER_SOURCE_KIND, MARKER_PATH, { sha: version }),
            );
        }
        return { written, rebuilt: rebuild };
    });

// Header contract enforced at import time, as for the run-evidence models.
for (const model of CACHE_BUST_MODELS) {
    const header = parseModelHeader(model.sql);
    if (header.model !== model.name) {
        throw new Error(`model file header says "${header.model}" but is registered as "${model.name}"`);
    }
}
