import { Effect, Schema } from "effect";
import { DbError } from "@ax/lib/errors";
import { IngestStageTag } from "./tags.ts";

/** Stable base shape every stage's stats class extends. `summary` is the
 *  human-readable line emitted as a `SpanEvent`; `durationMs` is captured by
 *  the runner. */
export class BaseStageStats extends Schema.Class<BaseStageStats>("BaseStageStats")({
    durationMs: Schema.Number,
    summary: Schema.String,
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

/** Build a standalone `WHERE ts > time::now() - Nd` filter from a `sinceDays`.
 *  Returns `""` when `sinceDays` is undefined or non-positive (no time filter).
 *  Extracted to kill the copy-pasted ternary whose typo'd variants fail
 *  silently (query runs, returns 0 rows, no error). */
export const sinceWhereClause = (sinceDays: number | undefined): string =>
    sinceDays && sinceDays > 0 ? `WHERE ts > time::now() - ${sinceDays}d` : "";

/** `AND ts > time::now() - Nd` continuation variant of {@link sinceWhereClause},
 *  for appending to a query that already has a `WHERE`. Same empty-string
 *  semantics when there is no time filter. */
export const sinceAndClause = (sinceDays: number | undefined): string =>
    sinceDays && sinceDays > 0 ? `AND ts > time::now() - ${sinceDays}d` : "";

/** Declarative metadata for a stage. The `key` field is narrowed per stage at
 *  construction time; deps/tags reference Schema unions defined in
 *  `./registry.ts` and `./tags.ts`. */
export class StageMeta extends Schema.Class<StageMeta>("StageMeta")({
    key: Schema.String, // tightened at the registry level to IngestStageKey
    deps: Schema.Array(Schema.String),
    tags: Schema.Array(IngestStageTag),
}) {}

/** A stage = metadata + a typed Effect runner. `R` is the union of Effect
 *  services the stage actually consumes; the pipeline composes the union. */
export interface StageDef<
    S extends BaseStageStats = BaseStageStats,
    R = never,
> {
    readonly meta: StageMeta;
    readonly run: (ctx: IngestContext) => Effect.Effect<S, DbError, R>;
}
