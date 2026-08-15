// packages/lib/src/sqlite/integrity.ts
/**
 * The CROSS-ENGINE integrity check: which judgment rows point at a cache row
 * that no longer exists?
 *
 * WHY THIS CAN HAPPEN AT ALL. The v2 split makes one promise in each direction.
 * The cache is rebuildable, so nothing in it is precious. The sidecar is durable,
 * so nothing in it may be lost. But a sidecar row REFERS to the cache - a role
 * tag names a skill, a retro names a session - and a re-derive rewrites the cache
 * from scratch. The reason those refs survive at all is the content-hash id
 * contract (`@ax/lib/stable-id`): re-deriving the same input rewrites a
 * byte-identical id, so the tag still finds its skill. This module is what
 * MEASURES that promise instead of assuming it. A dangling count that is anything
 * but zero on unchanged inputs means the id contract broke, and it is far better
 * to learn that from `ax doctor` than from a role tag that silently stopped
 * applying.
 *
 * SPLIT IN TWO, ON PURPOSE. {@link collectSidecarRefs} needs the sidecar and
 * nothing else; the join against live cache ids is `checkCacheIntegrity` in
 * ../cache-integrity.ts, which takes plain data. So the interesting logic is
 * testable with no DuckDB running, and the same functions serve both callers -
 * ingest (checking against the LIVE database it just wrote, before publish) and
 * `ax doctor` (checking against the published snapshot).
 *
 * THE CACHE READER IS AN ARGUMENT, NEVER A SERVICE. Same rule wave 2 arrived at
 * for every module called from both sides of ingest (F1/F2 in the backlog): a
 * `CacheRead` resolved inside ingest answers from the PREVIOUS run's snapshot, so
 * a check running after a re-derive would compare this run's judgment against
 * last run's ids and invent dangling refs. {@link fetchCacheIds} therefore takes
 * the reader it should use.
 */
import { Effect, Schema } from "effect";
import {
    buildCacheIdIndex,
    checkCacheIntegrity,
    type CacheIdIndex,
    type IntegrityReport,
    type SidecarRef,
} from "../cache-integrity.ts";
import type { JudgmentError } from "./errors.ts";
import type { JudgmentService } from "./sidecar.ts";

/** One column of one sidecar table that holds a CACHE row id. */
export interface SidecarCacheRefSpec {
    readonly sidecarTable: string;
    readonly column: string;
    readonly targetTable: string;
}

/**
 * Every ref that crosses from the sidecar into the cache.
 *
 * DERIVED FROM THE v1 TYPES, not from naming. Each entry below was a
 * `record<T>` field (or a `RELATION FROM T`) in schema.surql, which is what makes
 * the target table a fact rather than a guess.
 *
 * TWO COLUMNS ARE DELIBERATELY ABSENT. `transcript_label_review.candidate_id` and
 * `.graph_fact_id` read like refs and are plain `string` in schema.surql - a
 * mined candidate identifier, not a row id in any cache table. Declaring a target
 * for them would make every label review report as dangling. If those ids are
 * later given a typed home, they belong here; until then the check says nothing
 * about them rather than something wrong.
 *
 * SIDECAR-TO-SIDECAR REFS ARE ALSO ABSENT (`experiment.proposal`,
 * `checkpoint.experiment`, `plays_role.out_id -> role`, the five form payloads).
 * They are real refs, but both endpoints are durable: a cache rebuild cannot
 * break them, and this check is about what a cache rebuild can break.
 */
export const SIDECAR_CACHE_REFS: readonly SidecarCacheRefSpec[] = [
    // was: DEFINE FIELD artifact ON experiment TYPE option<record<skill>>
    { sidecarTable: "experiment", column: "artifact", targetTable: "skill" },
    // was: DEFINE TABLE plays_role TYPE RELATION FROM skill TO role
    { sidecarTable: "plays_role", column: "in_id", targetTable: "skill" },
    // was: DEFINE FIELD session ON retro TYPE record<session>
    { sidecarTable: "retro", column: "session", targetTable: "session" },
    // was: DEFINE FIELD repository ON retro TYPE option<record<repository>>
    { sidecarTable: "retro", column: "repository", targetTable: "repository" },
    // was: DEFINE FIELD transcript_artifact ON dogfood_run TYPE option<record<artifact>>
    { sidecarTable: "dogfood_run", column: "transcript_artifact", targetTable: "artifact" },
    // New in v2: the spar stamp that used to be a VALUE in `session.labels`.
    { sidecarTable: "session_label", column: "session_id", targetTable: "session" },
];

/** The cache tables this check ever looks in. Passed to `checkCacheIntegrity` as
 *  `knownTables`, so a ref into a real-but-EMPTY table reports `missing_id` (the
 *  row is gone) rather than `unknown_table` (ax has no such table) - a different
 *  diagnosis pointing at a different bug. */
export const SIDECAR_REF_TARGET_TABLES: ReadonlySet<string> = new Set(
    SIDECAR_CACHE_REFS.map((r) => r.targetTable),
);

const RefRow = Schema.Struct({ id: Schema.String, target: Schema.String });

/**
 * Every non-null cross-engine ref currently in the sidecar.
 *
 * One statement per declared column - six statements over tables that hold tens
 * to thousands of rows, not a join over the cache. A NULL is skipped in SQL
 * rather than filtered afterwards: an absent optional ref (a hook-form experiment
 * has no skill artifact) is not a dangling ref, it is no ref.
 */
export const collectSidecarRefs = (
    judgment: JudgmentService,
): Effect.Effect<ReadonlyArray<SidecarRef>, JudgmentError> =>
    Effect.gen(function* () {
        const all: SidecarRef[] = [];
        for (const spec of SIDECAR_CACHE_REFS) {
            const rows = yield* judgment.rows(
                RefRow,
                // Identifiers are from this module's own constant, never from a
                // caller - the seam's quoting rule would refuse anything else.
                `SELECT id, "${spec.column}" AS target FROM "${spec.sidecarTable}" WHERE "${spec.column}" IS NOT NULL`,
            );
            for (const row of rows) {
                all.push({
                    sidecarTable: spec.sidecarTable,
                    sidecarId: row.id,
                    column: spec.column,
                    targetTable: spec.targetTable,
                    targetId: row.target,
                });
            }
        }
        return all;
    });

/** Join collected refs against live cache ids. Thin by design: the counting
 *  lives in `checkCacheIntegrity`, and this only supplies the `knownTables` set
 *  that turns an empty-table ref into the right diagnosis. */
export const checkSidecarRefs = (
    refs: Iterable<SidecarRef>,
    cacheIds: CacheIdIndex,
    options?: { readonly sampleLimit?: number },
): IntegrityReport =>
    checkCacheIntegrity(refs, cacheIds, {
        knownTables: SIDECAR_REF_TARGET_TABLES,
        ...(options?.sampleLimit === undefined ? {} : { sampleLimit: options.sampleLimit }),
    });

/**
 * What {@link fetchCacheIds} needs of a cache handle: `rows`, and nothing more.
 *
 * Structural rather than an import of `CacheReadService`, so this module stays
 * free of the DuckDB seam and its dylib - and so BOTH a published `CacheRead` and
 * a live `CacheWriteService` satisfy it without a cast. `E` is left open because
 * the two differ in their error channel.
 */
export interface CacheIdReader<E> {
    readonly rows: <S extends Schema.Top>(
        schema: S,
        sql: string,
    ) => Effect.Effect<ReadonlyArray<S["Type"]>, E, S["DecodingServices"]>;
}

const IdRow = Schema.Struct({ id: Schema.String });

/**
 * Live ids of exactly the cache tables the sidecar refers to.
 *
 * One `SELECT id` per target table - four statements, no joins, no `IN` list of
 * ten thousand ids. The ids come back as a set and the comparison happens in JS,
 * which is the same shape the wave-2 aggregates settled on for cross-table work:
 * the alternative (a per-ref `EXISTS` subquery) is one round trip per judgment
 * row.
 */
export const fetchCacheIds = <E>(
    read: CacheIdReader<E>,
    tables: Iterable<string> = SIDECAR_REF_TARGET_TABLES,
): Effect.Effect<CacheIdIndex, E, (typeof IdRow)["DecodingServices"]> =>
    Effect.gen(function* () {
        const rows: { table: string; id: string }[] = [];
        for (const table of tables) {
            const ids = yield* read.rows(IdRow, `SELECT id FROM "${table}"`);
            for (const row of ids) rows.push({ table, id: row.id });
        }
        return buildCacheIdIndex(rows);
    });
