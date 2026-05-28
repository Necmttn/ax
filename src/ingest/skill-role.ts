import { Effect } from "effect";
import { RecordId } from "../lib/db.ts";
import type { SurrealClientShape } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";

// Stable key for role node id. Just use the lowercase name.
const ROLE_KEY = (name: string) => name;

export const relateSkillRoles = (
    db: SurrealClientShape,
    args: { skillId: RecordId; skillName: string; roles: ReadonlyArray<string> },
): Effect.Effect<{ rolesUpserted: number; edgesWritten: number }, DbError> =>
    Effect.gen(function* () {
        const seen = new Set<string>();
        const cleaned: string[] = [];
        for (const r of args.roles) {
            const norm = r.trim().toLowerCase();
            if (!norm || seen.has(norm)) continue;
            seen.add(norm);
            cleaned.push(norm);
        }

        // When cleaned is empty (no roles / all dropped), sweep stale
        // frontmatter-source edges so a skill that had roles then dropped them
        // is cleaned up on re-ingest.
        if (cleaned.length === 0) {
            yield* db.query(
                `DELETE plays_role WHERE in = $skill AND source = "frontmatter";`,
                { skill: args.skillId },
            );
            return { rolesUpserted: 0, edgesWritten: 0 };
        }

        let rolesUpserted = 0;
        let edgesWritten = 0;
        for (const roleName of cleaned) {
            const roleId = new RecordId("role", ROLE_KEY(roleName));
            yield* db.upsert(roleId, { name: roleName });
            rolesUpserted += 1;

            // Idempotent: delete prior frontmatter-sourced edge for this pair,
            // then relate fresh. User/brief edges (other source values) are
            // preserved.
            yield* db.query(
                `DELETE plays_role WHERE in = $skill AND out = $role AND source = "frontmatter";`,
                { skill: args.skillId, role: roleId },
            );
            yield* db.query(
                `RELATE $skill->plays_role->$role SET source = "frontmatter", confidence = 1.0, since = time::now();`,
                { skill: args.skillId, role: roleId },
            );
            edgesWritten += 1;
        }
        return { rolesUpserted, edgesWritten };
    });
