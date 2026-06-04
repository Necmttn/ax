import { Effect } from "effect";
import { RecordId } from "@ax/lib/db";
import type { SurrealClientShape } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { recordLiteral } from "@ax/lib/ids";
import { validateRoleName } from "@ax/lib/role-name";

const safeRoleName = (name: string): string | null => {
    try {
        return validateRoleName(name);
    } catch {
        return null;
    }
};

export const relateSkillRoles = (
    db: SurrealClientShape,
    args: { skillId: RecordId; roles: ReadonlyArray<string> },
): Effect.Effect<{ rolesUpserted: number; edgesWritten: number; rolesSkipped: number }, DbError> =>
    Effect.gen(function* () {
        const seen = new Set<string>();
        const cleaned: string[] = [];
        let rolesSkipped = 0;
        for (const r of args.roles) {
            const norm = safeRoleName(r);
            if (norm === null) {
                // Invalid role name (e.g. contains backtick, semicolon, or
                // doesn't match the allowed pattern). Skip rather than crash
                // the whole stage - the caller accumulates the skip count.
                rolesSkipped += 1;
                continue;
            }
            if (seen.has(norm)) continue;
            seen.add(norm);
            cleaned.push(norm);
        }

        // Inline record id literal - bypasses SDK RecordId binding which
        // silently produces empty results against live SurrealDB (see
        // src/lib/shared/graph-query.ts:132 and src/dashboard/session-detail.ts:33).
        const skillLit = recordLiteral("skill", String(args.skillId.id));

        // Sweep ALL frontmatter-sourced edges for this skill before writing
        // the current set. This handles role shrinkage (e.g. [framing,execution]
        // → [framing]) and the empty-roles case in one pass.
        yield* db.query(
            `DELETE plays_role WHERE in = ${skillLit} AND source = "frontmatter";`,
        );

        if (cleaned.length === 0) {
            return { rolesUpserted: 0, edgesWritten: 0, rolesSkipped };
        }

        let rolesUpserted = 0;
        let edgesWritten = 0;
        for (const roleName of cleaned) {
            const roleLit = recordLiteral("role", roleName);
            // UPSERT ... SET (not CONTENT) so an existing role's tunable
            // `weight` survives re-ingest. A CONTENT upsert replaces the whole
            // record, dropping `weight` to NONE; the next write then crashes
            // with "Expected `float` but found `NONE`" because `weight ON role`
            // is non-optional (Pi dogfood, 2026-06-04). SET only touches `name`
            // - `weight` keeps its value, or gets DEFAULT 1.0 on first create.
            // roleName is validated by validateRoleName (^[a-z][a-z0-9_-]*$),
            // so it can't break out of the double-quoted string literal.
            yield* db.query(`UPSERT ${roleLit} SET name = "${roleName}";`);
            rolesUpserted += 1;

            yield* db.query(
                `RELATE ${skillLit}->plays_role->${roleLit} SET source = "frontmatter", confidence = 1.0, since = time::now();`,
            );
            edgesWritten += 1;
        }
        return { rolesUpserted, edgesWritten, rolesSkipped };
    });
