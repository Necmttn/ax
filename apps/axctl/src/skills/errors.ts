import { Schema } from "effect";

/**
 * Domain-2 (skills + commands) tagged errors. The config-front-door SPINE
 * already supplies the shared ones we reuse:
 *   - `SkillParseError`  (`@ax/lib/errors`) - SKILL.md / command frontmatter parse failure.
 *   - `AdapterNotFoundError` (`../config-core/errors.ts`) - registry `select(name)` miss
 *     (the spine's generic form; we re-export it as the skill-source-not-found error).
 *   - `ScopeTargetError` (`../config-core/errors.ts`) - agent file missing / invalid for a
 *     scope edit. Re-exported so callers import skill errors from one place.
 *
 * The skill-only additions are below.
 */

// Re-exported spine errors so `ax skills` code has a single import surface.
export { SkillParseError } from "@ax/lib/errors";
export {
    AdapterNotFoundError as SkillSourceNotFoundError,
    ScopeTargetError,
    ConfigParseError,
} from "../config-core/errors.ts";

/**
 * A skill id/name lookup missed, or matched ambiguously across sources. `name`
 * is the requested name; `candidates` lists the matching `scope:name` records
 * when the miss was an ambiguity (empty when nothing matched at all).
 */
export class SkillNotFoundError extends Schema.TaggedErrorClass<SkillNotFoundError>(
    "SkillNotFoundError",
)("SkillNotFoundError", {
    name: Schema.String,
    candidates: Schema.Array(Schema.String),
}) {}

/**
 * A mutation (`remove`/`park`/`unpark`) targeted a read-only source - a
 * `plugin` skill (owned by the plugin manager) or a codex `.system` skill.
 * Raised BEFORE any disk touch.
 */
export class SkillReadOnlyError extends Schema.TaggedErrorClass<SkillReadOnlyError>(
    "SkillReadOnlyError",
)("SkillReadOnlyError", {
    name: Schema.String,
    source: Schema.String,
    reason: Schema.String,
}) {}
