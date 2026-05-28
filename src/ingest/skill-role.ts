import { Effect } from "effect";
import { RecordId } from "../lib/db.ts";
import type { SurrealClientShape } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";

export const relateSkillRoles = (
    db: SurrealClientShape,
    args: { skillId: RecordId; roles: ReadonlyArray<string> },
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

        // Inline record id literal - bypasses SDK RecordId binding which
        // silently produces empty results against live SurrealDB (see
        // src/lib/shared/graph-query.ts:132 and src/dashboard/session-detail.ts:33).
        const skillLit = `skill:\`${args.skillId.id}\``;

        // Sweep ALL frontmatter-sourced edges for this skill before writing
        // the current set. This handles role shrinkage (e.g. [framing,execution]
        // → [framing]) and the empty-roles case in one pass.
        yield* db.query(
            `DELETE plays_role WHERE in = ${skillLit} AND source = "frontmatter";`,
        );

        if (cleaned.length === 0) {
            return { rolesUpserted: 0, edgesWritten: 0 };
        }

        let rolesUpserted = 0;
        let edgesWritten = 0;
        for (const roleName of cleaned) {
            const roleId = new RecordId("role", roleName);
            yield* db.upsert(roleId, { name: roleName });
            rolesUpserted += 1;

            const roleLit = `role:\`${roleName}\``;
            yield* db.query(
                `RELATE ${skillLit}->plays_role->${roleLit} SET source = "frontmatter", confidence = 1.0, since = time::now();`,
            );
            edgesWritten += 1;
        }
        return { rolesUpserted, edgesWritten };
    });
