import { Schema } from "effect";

/**
 * Shared tagged errors for the config-front-door spine (hooks / skills /
 * agents). Domain-specific errors (HookValidationError, SkillReadOnlyError, …)
 * live in each domain's own `errors.ts`; these are the ones every domain reuses.
 */

/** A registry `select(name)` miss. `domain` = "hook-provider" | "skill-source" | … */
export class AdapterNotFoundError extends Schema.TaggedErrorClass<AdapterNotFoundError>(
    "AdapterNotFoundError",
)("AdapterNotFoundError", {
    domain: Schema.String,
    name: Schema.String,
    known: Schema.Array(Schema.String),
}) {}

/** Frontmatter / JSON / TOML decode failure for a config or definition file. */
export class ConfigParseError extends Schema.TaggedErrorClass<ConfigParseError>(
    "ConfigParseError",
)("ConfigParseError", {
    file: Schema.String,
    reason: Schema.String,
}) {}

/** The agent file targeted by a scope edit is missing or not a valid agent. */
export class ScopeTargetError extends Schema.TaggedErrorClass<ScopeTargetError>(
    "ScopeTargetError",
)("ScopeTargetError", {
    agentFile: Schema.String,
    reason: Schema.String,
}) {}
