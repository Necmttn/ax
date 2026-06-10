import { Effect, Option, Schema } from "effect";

/**
 * Tolerant Effect Schemas for the transcript IO boundaries (Claude / Codex /
 * Pi JSONL lines).
 *
 * Transcripts are messy real-world data, so these schemas are tolerant BY
 * DESIGN: every field is `lenient` - a missing key, an explicit `undefined`,
 * or a value of the wrong type all decode to `undefined` instead of failing
 * the whole line. This mirrors the legacy hand-rolled `stringField` /
 * `numberField` probe semantics while giving the parsers typed access.
 *
 * The decode helpers return `null` only when the input is not a record at
 * all (which callers count as a malformed line and skip) - never throw.
 */

/**
 * Decode-tolerant optional struct field. Decodes to `schema`'s type when the
 * value matches, `undefined` otherwise (missing key, wrong type, failed
 * refinement). Never fails the surrounding struct.
 */
export const lenient = <S extends Schema.Top>(schema: S) => {
    const orUndefined = Schema.UndefinedOr(schema);
    const tolerant = Schema.catchDecoding<typeof orUndefined>(() =>
        Effect.succeed(Option.some(undefined as (typeof orUndefined)["Type"])),
    )(orUndefined);
    return Schema.optionalKey(tolerant);
};

/** JSON numbers are finite by spec, but `JSON.parse("1e999")` yields
 *  `Infinity`; `Schema.Finite` + `lenient` reproduces the legacy
 *  `Number.isFinite` probe (non-finite → `undefined` → caller default). */
const lenientFiniteNumber = lenient(Schema.Finite);

/**
 * One Claude Code transcript JSONL line (`~/.claude/projects/<slug>/*.jsonl`).
 * Head fields only - content blocks, hook `data`/`attachment` payloads and
 * other nested shapes stay `unknown`/raw and are probed by the parser.
 */
export const ClaudeTranscriptLine = Schema.Struct({
    type: lenient(Schema.String),
    timestamp: lenient(Schema.String),
    ts: lenient(Schema.String),
    cwd: lenient(Schema.String),
    uuid: lenient(Schema.String),
    model: lenient(Schema.String),
    isCompactSummary: lenient(Schema.Boolean),
    message: lenient(Schema.Struct({
        model: lenient(Schema.String),
        isCompactSummary: lenient(Schema.Boolean),
        content: Schema.optionalKey(Schema.Unknown),
        usage: lenient(Schema.Struct({
            input_tokens: lenientFiniteNumber,
            output_tokens: lenientFiniteNumber,
            cache_creation_input_tokens: lenientFiniteNumber,
            cache_read_input_tokens: lenientFiniteNumber,
        })),
    })),
});
export type ClaudeTranscriptLine = typeof ClaudeTranscriptLine.Type;

/**
 * One Codex session JSONL line head (`~/.codex/sessions/**.jsonl`). The
 * `payload` stays raw - its shape varies per `type` and is probed downstream.
 */
export const CodexTranscriptLine = Schema.Struct({
    type: lenient(Schema.String),
    timestamp: lenient(Schema.String),
});
export type CodexTranscriptLine = typeof CodexTranscriptLine.Type;

/**
 * One Pi session JSONL line head (`~/.pi/agent/sessions/*.jsonl`). The
 * `message` payload stays raw (role/content/usage are probed downstream).
 */
export const PiTranscriptLine = Schema.Struct({
    type: lenient(Schema.String),
    id: lenient(Schema.String),
    parentId: lenient(Schema.String),
    timestamp: lenient(Schema.String),
    cwd: lenient(Schema.String),
    modelId: lenient(Schema.String),
    version: lenientFiniteNumber,
});
export type PiTranscriptLine = typeof PiTranscriptLine.Type;

const decodeClaudeLineOption = Schema.decodeUnknownOption(ClaudeTranscriptLine);
const decodeCodexLineOption = Schema.decodeUnknownOption(CodexTranscriptLine);
const decodePiLineOption = Schema.decodeUnknownOption(PiTranscriptLine);

/** Typed view of a parsed Claude transcript line. `null` = not a record. */
export const decodeClaudeTranscriptLine = (input: unknown): ClaudeTranscriptLine | null => {
    const result = decodeClaudeLineOption(input);
    return Option.isSome(result) ? result.value : null;
};

/** Typed view of a parsed Codex session line head. `null` = not a record. */
export const decodeCodexTranscriptLine = (input: unknown): CodexTranscriptLine | null => {
    const result = decodeCodexLineOption(input);
    return Option.isSome(result) ? result.value : null;
};

/** Typed view of a parsed Pi session line head. `null` = not a record. */
export const decodePiTranscriptLine = (input: unknown): PiTranscriptLine | null => {
    const result = decodePiLineOption(input);
    return Option.isSome(result) ? result.value : null;
};
