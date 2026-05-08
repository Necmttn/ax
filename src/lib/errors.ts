import { Schema } from "effect";

/**
 * Frontmatter parse failure for a SKILL.md file.
 */
export class SkillParseError extends Schema.TaggedErrorClass<SkillParseError>(
    "SkillParseError",
)("SkillParseError", {
    file: Schema.String,
    reason: Schema.String,
}) {}

/**
 * SurrealDB query / upsert / relate failure. `sql` is a short excerpt for
 * debugging; `message` carries the original error string.
 */
export class DbError extends Schema.TaggedErrorClass<DbError>("DbError")(
    "DbError",
    {
        operation: Schema.String,
        message: Schema.String,
        sql: Schema.optional(Schema.String),
    },
) {}

/**
 * jsonl line parse failure inside a transcript file.
 */
export class TranscriptCorruptedError extends Schema.TaggedErrorClass<TranscriptCorruptedError>(
    "TranscriptCorruptedError",
)("TranscriptCorruptedError", {
    file: Schema.String,
    reason: Schema.String,
}) {}
