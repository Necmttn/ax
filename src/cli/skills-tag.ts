/**
 * `ax skills tag <skill> <role>` - write/replace a plays_role edge with source="user".
 *
 * Idempotent: deletes any prior user-source edge for the (skill, role) pair
 * before (re-)creating it. Atomic per pair: run the command multiple times
 * with different roles to add multiple roles.
 */
import { Effect } from "effect";
import { RecordId, SurrealClient, type SurrealClientShape } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import { recordLiteral } from "../lib/ids.ts";
import { validateRoleName, validateSkillName } from "../lib/role-name.ts";

export interface SkillsTagOptions {
    readonly skillName: string;
    readonly roleName: string;
    readonly confidence: number;
    readonly rationale: string | undefined;
    readonly remove: boolean;
}

/**
 * Resolve a skill record key (id part) by name. Returns null if not found.
 * Uses a binding for the name value (safe), literal interpolation is only
 * needed for record id references in FROM/WHERE clauses per codebase pattern.
 */
const lookupSkillKey = (
    db: SurrealClientShape,
    skillName: string,
): Effect.Effect<string | null, DbError> =>
    Effect.gen(function* () {
        const result = yield* db.query<[Array<{ id: unknown }>]>(
            "SELECT id FROM skill WHERE name = $name LIMIT 1;",
            { name: skillName },
        );
        const rows = result?.[0] ?? [];
        if (rows.length === 0) return null;
        const id = rows[0]!.id;
        // id comes back as a RecordId object { tb, id } or as a string
        if (typeof id === "string") {
            const colon = id.indexOf(":");
            return colon >= 0 ? id.slice(colon + 1) : id;
        }
        if (id !== null && typeof id === "object" && "id" in id) {
            return String((id as { id: unknown }).id);
        }
        return null;
    });

export const cmdSkillsTag = (opts: SkillsTagOptions): Effect.Effect<void, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;

        // 1. Validate inputs
        let trimmedSkill: string;
        try {
            trimmedSkill = validateSkillName(opts.skillName);
        } catch {
            console.error(
                `axctl skills tag: invalid skill name "${opts.skillName}" (must be alphanumeric, _ or -, optionally plugin:namespaced)`,
            );
            process.exit(2);
            return; // unreachable; satisfies TypeScript
        }

        let roleName: string;
        try {
            roleName = validateRoleName(opts.roleName);
        } catch {
            console.error(
                `axctl skills tag: invalid role name "${opts.roleName}" (must be lowercase alphanumeric, _ or -)`,
            );
            process.exit(2);
            return; // unreachable; satisfies TypeScript
        }
        if (opts.confidence < 0 || opts.confidence > 1) {
            console.error(`axctl skills tag: --confidence must be between 0 and 1 (got ${opts.confidence})`);
            process.exit(2);
        }

        // 2. Resolve skill record id by name
        const skillKey = yield* lookupSkillKey(db, trimmedSkill);
        if (skillKey === null) {
            console.error(`axctl skills tag: unknown skill "${trimmedSkill}"`);
            process.exit(2);
            return; // unreachable but satisfies TypeScript
        }

        // Inline record id literal - bypasses SDK RecordId binding which
        // silently produces empty results against live SurrealDB.
        // See src/lib/shared/graph-query.ts:132 and skill-role.ts:23.
        const skillLit = recordLiteral("skill", skillKey);

        // 3. Upsert role node by name (lowercase, matches P3.2 behaviour)
        const roleId = new RecordId("role", roleName);
        yield* db.upsert(roleId, { name: roleName });

        const roleLit = recordLiteral("role", roleName);

        // 4. Delete any existing user-source edge for this (skill, role) pair
        yield* db.query(
            `DELETE plays_role WHERE in = ${skillLit} AND out = ${roleLit} AND source = "user";`,
        );

        // 5. If --remove: stop here (edge already deleted in step 4)
        if (opts.remove) {
            console.log(`removed plays_role edge: ${trimmedSkill} -> ${roleName} (source=user)`);
            return;
        }

        // 6. RELATE skill->plays_role->role with source="user"
        const setSql = opts.rationale !== undefined
            ? `source = "user", confidence = ${opts.confidence}, rationale = ${JSON.stringify(opts.rationale)}, since = time::now()`
            : `source = "user", confidence = ${opts.confidence}, since = time::now()`;

        yield* db.query(
            `RELATE ${skillLit}->plays_role->${roleLit} SET ${setSql};`,
        );

        console.log(`tagged ${trimmedSkill} -> ${roleName} (source=user, confidence=${opts.confidence})`);
    });
