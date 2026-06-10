/**
 * Branded domain primitives (`@ax/lib/brands`).
 *
 * Nominal string brands for values whose underlying type is `string` but
 * which must not be mixed: a bare session id is not a skill name is not a
 * record key. Branded values are assignable TO `string`, so producers can
 * adopt a brand on their return type with zero call-site churn; consumers
 * opt in by tightening parameter/field types as they migrate.
 *
 * Current applications (kept deliberately narrow):
 *   - `toBareSessionId` (shared/session-id.ts) returns `SessionId`
 *   - `resolveSkillName` (skill-id.ts) returns `SkillName`
 *
 * Expansion path: migrate `shared/session-id.ts`'s `type SessionId = string`
 * wire alias onto this brand (dashboard DTOs in `shared/dashboard-types.ts`
 * then need their DB-row mappers to construct via `SessionId.make`), and
 * tighten `toSessionRid`/`shortSessionId` params once all producers brand.
 */
import { Schema } from "effect";

/** A bare session id in wire form (no `session:` prefix, backticks, or ⟨⟩
 *  record-id decoration) - e.g. a claude UUID v7 or a synthetic
 *  `claude-subagent-<agentId>` id. Produced by `toBareSessionId`. */
export const SessionId = Schema.String.pipe(Schema.brand("SessionId"));
export type SessionId = typeof SessionId.Type;

/** A canonical skill name as it appears in the on-disk catalog - bare
 *  (`subagent-driven-development`) or plugin-namespaced
 *  (`superpowers:subagent-driven-development`). Produced by
 *  `resolveSkillName`, which maps inconsistently-recorded invocation names
 *  back onto the catalog. */
export const SkillName = Schema.String.pipe(Schema.brand("SkillName"));
export type SkillName = typeof SkillName.Type;
