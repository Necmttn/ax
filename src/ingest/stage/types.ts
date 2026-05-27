import { Effect, Schema } from "effect";
import { DbError } from "../../lib/errors.ts";
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
}) {}

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
