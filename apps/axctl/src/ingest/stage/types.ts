import { Effect, Schema } from "effect";
import { DbError } from "@ax/lib/errors";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { IngestStageTag } from "./tags.ts";

/** Stable base shape every stage's stats class extends. `summary` is the
 *  human-readable line emitted as a `SpanEvent`; `durationMs` is captured by
 *  the runner. */
export class BaseStageStats extends Schema.Class<BaseStageStats>("BaseStageStats")({
    durationMs: Schema.Number,
    summary: Schema.String,
    /** A failed-open stage returns success so independent stages can continue. */
    failedOpenError: Schema.optional(Schema.String),
}) {}

/** Ambient context every stage's run receives. Pipeline owns lifetime; stages
 *  treat it as read-only. */
export class IngestContext extends Schema.Class<IngestContext>("IngestContext")({
    cwd: Schema.String,
    since: Schema.Date,
    debug: Schema.Boolean,
    /** Present for orchestrated runs; standalone provider calls omit it. */
    runId: Schema.optional(Schema.String),
    repoPaths: Schema.optional(Schema.Array(Schema.String)),
    claudeProject: Schema.optional(Schema.String),
}) {}

/** Compute `sinceDays` from an {@link IngestContext}, suitable for passing to
 *  derive/ingest opts. Returns `undefined` when:
 *    - `ctx.since` is epoch-zero (the default "full re-derive" sentinel), to
 *      avoid a 56-year scan; callers treat `undefined` as "no time filter"
 *      or apply their own default.
 *    - `ctx.since` is in the future (negative diff).
 *  Otherwise returns the ceiling of the day-delta. */
export const sinceDaysFromCtx = (ctx: IngestContext): number | undefined => {
    const sinceMs = ctx.since.getTime();
    if (sinceMs === 0) return undefined;
    const days = Math.ceil((Date.now() - sinceMs) / 86400000);
    return days > 0 ? days : undefined;
};

/**
 * How a writer touches one DuckDB cache table (#893 Phase 4 event-layer
 * freeze). The MODE is the contract, checked against the table's `layer` in
 * `@ax/schema/duckdb-tables` by `table-writes.test.ts`:
 *
 * - `parse`     - event rows written from OUTSIDE-WORLD bytes (transcripts,
 *                 git, catalogs, spools, external ledgers). Legal only on
 *                 `event`-layer tables. Covers the parser's own lifecycle
 *                 UPDATEs/DELETEs on that table (reconcile tombstones,
 *                 scoped replace) - they restate on-disk reality.
 * - `enrich`    - UPDATE-ing an ENUMERATED set of derived columns on an
 *                 event table (`ENRICHMENT_COLUMNS`). The named, permanent
 *                 exception for derived-data-at-rest in event rows.
 * - `derive`    - writing a `derived`-layer table from event rows (insert,
 *                 update, or wipe - wiping derived tables is always safe).
 *                 Also legal on an EVENT table only when the (writer, table)
 *                 pair is enumerated in `DERIVED_ROW_WRITES_ON_EVENT_TABLES`.
 * - `bookkeep`  - the store's own state (`bookkeeping` layer): watermarks,
 *                 run/stage telemetry, sentinel markers.
 */
export const TableWriteMode = Schema.Literals(["parse", "enrich", "derive", "bookkeep"]);
export type TableWriteMode = typeof TableWriteMode.Type;

export const TableWrite = Schema.Struct({
    table: Schema.String,
    mode: TableWriteMode,
});
export type TableWrite = typeof TableWrite.Type;

/** Declarative metadata for a stage. The `key` field is narrowed per stage at
 *  construction time; deps/tags reference Schema unions defined in
 *  `./registry.ts` and `./tags.ts`. `writes` declares every cache table the
 *  stage (including its helpers) touches - the event-layer contract binds
 *  WRITES, not tags (#893): a stage's ingest/derive TAG says where it runs in
 *  the pipeline, while each TableWrite mode says what KIND of write it is. */
export class StageMeta extends Schema.Class<StageMeta>("StageMeta")({
    key: Schema.String, // tightened at the registry level to IngestStageKey
    deps: Schema.Array(Schema.String),
    tags: Schema.Array(IngestStageTag),
    writes: Schema.Array(TableWrite),
    /**
     * Marks a stage as a FIRST-VALUE provider for the cold-start intermediate
     * publish (#833): the SIX normalized transcript providers (claude, codex,
     * pi, omp, opencode, cursor) that turn raw transcripts into `session`/
     * `turn`/`tool_call` rows, and nothing else.
     *
     * Deliberately its OWN field rather than reusing `tags` (`"ingest"` also
     * covers skills/commands/pricing/git/github-pr - not what a first
     * usable snapshot needs) or a `writes` MODE (`"parse"` covers every
     * event-layer writer, including catalog stages this phase must still
     * wait on as DEPS but not select for on their own). Those two carry
     * mixed meanings; this field carries exactly one.
     *
     * `undefined`/`false` (the default - most stages omit this field
     * entirely) means "not a first-value provider". The cold-start phase
     * that reads this (`firstValuePhaseStages` in `./select.ts`) also pulls
     * in each marked stage's transitive deps, so skills/commands/pricing
     * still run before claude/codex do.
     */
    firstValue: Schema.optional(Schema.Boolean),
}) {}

/** A stage = metadata + a typed Effect runner. `R` is the union of Effect
 *  services the stage actually consumes; the pipeline composes the union. */
export interface StageDef<
    S extends BaseStageStats = BaseStageStats,
    R = never,
    E = DbError,
> {
    readonly meta: StageMeta;
    readonly run: (ctx: IngestContext, write: CacheWriteService) => Effect.Effect<S, E, R>;
}
