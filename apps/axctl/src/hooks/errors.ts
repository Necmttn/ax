import { Schema } from "effect";

/**
 * Domain-specific errors for the hooks "config front door". Shared spine
 * errors (AdapterNotFoundError, ConfigParseError) live in
 * `../config-core/errors.ts`; these are the ones unique to hook CRUD.
 *
 * Every error is a `Schema.TaggedErrorClass` so CLI handlers can discriminate
 * them with `Effect.catchTags` at the boundary and render clean stderr.
 */

/** A provider config file (json/toml) could not be decoded into entries. */
export class HookConfigParseError extends Schema.TaggedErrorClass<HookConfigParseError>(
    "HookConfigParseError",
)("HookConfigParseError", {
    provider: Schema.String,
    file: Schema.String,
    reason: Schema.String,
}) {}

/** A decoded config file did not match the expected provider schema shape. */
export class HookConfigSchemaError extends Schema.TaggedErrorClass<HookConfigSchemaError>(
    "HookConfigSchemaError",
)("HookConfigSchemaError", {
    provider: Schema.String,
    file: Schema.String,
    reason: Schema.String,
}) {}

/** A hook id resolved to zero rows, or to more than one (ambiguous). */
export class HookNotFoundError extends Schema.TaggedErrorClass<HookNotFoundError>(
    "HookNotFoundError",
)("HookNotFoundError", {
    id: Schema.String,
    /** "missing" | "ambiguous" */
    reason: Schema.String,
    /** candidate ids when ambiguous, [] when missing */
    candidates: Schema.Array(Schema.String),
}) {}

/**
 * A requested hook input is structurally invalid for its provider: the event
 * is not in the provider vocab, a matcher was supplied to a matcher:"none"
 * provider, or a glob matcher was required (opencode file_edited) but missing.
 */
export class HookValidationError extends Schema.TaggedErrorClass<HookValidationError>(
    "HookValidationError",
)("HookValidationError", {
    provider: Schema.String,
    /** "unknown_event" | "matcher_not_supported" | "missing_matcher" | "empty_command" */
    reason: Schema.String,
    detail: Schema.String,
}) {}

/** A provider name was requested that the registry does not know about. */
export class HookProviderNotFoundError extends Schema.TaggedErrorClass<HookProviderNotFoundError>(
    "HookProviderNotFoundError",
)("HookProviderNotFoundError", {
    name: Schema.String,
    known: Schema.Array(Schema.String),
}) {}
