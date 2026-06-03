import { Schema } from "effect";

/**
 * Domain-specific errors for the agents config front door. Parse failures reuse
 * the shared `ConfigParseError`; scope-edit target failures reuse the shared
 * `ScopeTargetError` (both from `../config-core/errors.ts`). These two cover the
 * agent-only cases: a named agent that does not resolve to a file on disk, and a
 * mutation attempt against a read-only source.
 */

/** No agent matched the given name across the discovered sources/scopes. */
export class AgentNotFoundError extends Schema.TaggedErrorClass<AgentNotFoundError>(
    "AgentNotFoundError",
)("AgentNotFoundError", {
    name: Schema.String,
    /** Names that WERE found, to help the caller suggest a fix. */
    known: Schema.Array(Schema.String),
}) {}

/** A mutation (rm/park/unpark/scope) was attempted on a read-only agent source. */
export class AgentReadOnlyError extends Schema.TaggedErrorClass<AgentReadOnlyError>(
    "AgentReadOnlyError",
)("AgentReadOnlyError", {
    name: Schema.String,
    source: Schema.String,
    reason: Schema.String,
}) {}
