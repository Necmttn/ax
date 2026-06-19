/**
 * Shared runtime contract for live ingest progress events streamed to the
 * studio SPA over Durable Streams. Lives in @ax/lib/shared so both the axctl
 * daemon (producer, apps/axctl/src/ingest/stream-events.ts) and the studio SPA
 * (consumer, apps/studio/src/use-ingest-stream.ts) validate the same wire
 * payload without reaching across workspace boundaries.
 */
import { Option, Schema } from "effect";

const JsonNumber = Schema.Finite;

/** One skipped file's failure detail, as recorded by the ingest stage's
 *  per-file failure collector (apps/axctl/src/ingest/file-isolation.ts). */
export const IngestFileFailureSchema = Schema.Struct({
    filePath: Schema.String,
    /** Error tag (`DbError`, `SkillParseError`, ...) or constructor name. */
    tag: Schema.String,
    message: Schema.String,
});
export type IngestFileFailure = typeof IngestFileFailureSchema.Type;

export const IngestFileFailureSnapshotSchema = Schema.Struct({
    total: JsonNumber,
    failures: Schema.Array(IngestFileFailureSchema),
});
export type IngestFileFailureSnapshot = typeof IngestFileFailureSnapshotSchema.Type;

export const RunStartedEventSchema = Schema.Struct({
    kind: Schema.Literal("run_started"),
    runId: Schema.String,
    label: Schema.String,
});

export const StageStartedEventSchema = Schema.Struct({
    kind: Schema.Literal("stage_started"),
    runId: Schema.String,
    stage: Schema.String,
});

export const StageProgressEventSchema = Schema.Struct({
    kind: Schema.Literal("stage_progress"),
    runId: Schema.String,
    stage: Schema.String,
    current: JsonNumber,
    total: JsonNumber,
    ratePerSec: JsonNumber,
    etaLeftMs: Schema.NullOr(JsonNumber),
    /** 1-based index of this stage among those started so far. */
    stageIndex: JsonNumber,
});

export const StageFileFailuresEventSchema = Schema.Struct({
    /**
     * Cumulative skipped-file snapshot for one stage. Re-published on each
     * new failure (each snapshot supersedes the previous one for the same
     * stage), so the Live tab shows the count climb while the stage runs
     * AND a Durable Stream replay reconverges on the final list. `failures`
     * is capped by the collector (25 details); `total` is not.
     */
    kind: Schema.Literal("stage_file_failures"),
    runId: Schema.String,
    stage: Schema.String,
    total: JsonNumber,
    failures: Schema.Array(IngestFileFailureSchema),
});

export const StageFinishedEventSchema = Schema.Struct({
    kind: Schema.Literal("stage_finished"),
    runId: Schema.String,
    stage: Schema.String,
    status: Schema.Literals(["ok", "error"]),
    durationMs: JsonNumber,
});

export const RunFinishedEventSchema = Schema.Struct({
    kind: Schema.Literal("run_finished"),
    runId: Schema.String,
    status: Schema.Literals(["completed", "failed"]),
    durationMs: JsonNumber,
});

export const IngestStreamEventSchema = Schema.Union([
    RunStartedEventSchema,
    StageStartedEventSchema,
    StageProgressEventSchema,
    StageFileFailuresEventSchema,
    StageFinishedEventSchema,
    RunFinishedEventSchema,
]);
export type IngestStreamEvent = typeof IngestStreamEventSchema.Type;

export const IngestStreamEventJsonSchema = Schema.fromJsonString(IngestStreamEventSchema);

const decodeEventOption = Schema.decodeUnknownOption(IngestStreamEventSchema);
const decodeFailureSnapshotOption = Schema.decodeUnknownOption(IngestFileFailureSnapshotSchema);
const encodeEventSync = Schema.encodeSync(IngestStreamEventSchema);
const encodeEventJsonSync = Schema.encodeSync(IngestStreamEventJsonSchema);

export const decodeIngestStreamEventOption = (value: unknown) =>
    decodeEventOption(value);

export const decodeIngestFileFailureSnapshotOption = (value: unknown) =>
    decodeFailureSnapshotOption(value);

export const isIngestStreamEvent = (value: unknown): value is IngestStreamEvent =>
    Option.isSome(decodeEventOption(value));

export const encodeIngestStreamEvent = (event: IngestStreamEvent): unknown =>
    encodeEventSync(event);

export const encodeIngestStreamEventJson = (event: IngestStreamEvent): string =>
    encodeEventJsonSync(event);
