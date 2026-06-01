/**
 * Validation helpers for role names and skill names used in SurrealDB record
 * literals. These are validated at the boundary (on user-controlled input)
 * rather than at interpolation time, giving clear error messages before any
 * broken value reaches a SurrealQL string.
 *
 * Background: `recordLiteral` (src/lib/ids.ts) embeds names as
 * `table:\`<name>\`` - a backtick, semicolon, or null byte in the name breaks
 * out of the literal (local SQL injection via brief / frontmatter / CLI args).
 */

/** Role names: lowercase alphanumeric + underscore/hyphen, starting with a letter. */
export const ROLE_NAME_RE = /^[a-z][a-z0-9_-]*$/;

/**
 * Validate + normalise a role name.
 *
 * Trims + lowercases first, then checks against ROLE_NAME_RE.
 * Throws a descriptive Error when the name is invalid (never returns bad input).
 */
export function validateRoleName(name: string): string {
    const norm = name.trim().toLowerCase();
    if (!ROLE_NAME_RE.test(norm)) {
        throw new Error(
            `invalid role name "${name}" (must match ${ROLE_NAME_RE.source})`,
        );
    }
    return norm;
}

/**
 * Skill names: allow alphanumeric + underscore/hyphen, optionally
 * plugin-namespaced with exactly one colon (e.g. "superpowers:tdd").
 */
export const SKILL_NAME_RE = /^[a-zA-Z0-9_-]+(:[a-zA-Z0-9_-]+)?$/;

/**
 * Validate a skill name.
 *
 * Trims the input; does NOT lowercase (skill names are case-sensitive in the
 * catalog). Throws a descriptive Error when the name is invalid.
 */
export function validateSkillName(name: string): string {
    const trimmed = name.trim();
    if (!SKILL_NAME_RE.test(trimmed)) {
        throw new Error(
            `invalid skill name "${name}" (must match ${SKILL_NAME_RE.source})`,
        );
    }
    return trimmed;
}
