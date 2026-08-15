import { Effect } from "effect";
import { cacheRow } from "@ax/lib/duckdb/row";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { edgeRowId, stableId } from "@ax/lib/stable-id";
import { validateRoleName } from "@ax/lib/role-name";

const safeRoleName = (name: string): string | null => {
    try {
        return validateRoleName(name);
    } catch {
        return null;
    }
};

export const relateSkillRoles = (
    write: CacheWriteService,
    args: { skillId: string; roles: ReadonlyArray<string> },
): Effect.Effect<{ rolesUpserted: number; edgesWritten: number; rolesSkipped: number }, CacheWriteError> =>
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

        // Sweep ALL frontmatter-sourced edges for this skill before writing
        // the current set. This handles role shrinkage (e.g. [framing,execution]
        // → [framing]) and the empty-roles case in one pass.
        yield* write.exec("DELETE FROM plays_role WHERE in_id = ? AND source = 'frontmatter'", [args.skillId]);

        if (cleaned.length === 0) {
            return { rolesUpserted: 0, edgesWritten: 0, rolesSkipped };
        }

        let rolesUpserted = 0;
        let edgesWritten = 0;
        for (const roleName of cleaned) {
            // UPSERT ... SET (not CONTENT) so an existing role's tunable
            // `weight` survives re-ingest. A CONTENT upsert replaces the whole
            // record, dropping `weight` to NONE; the next write then crashes
            // with "Expected `float` but found `NONE`" because `weight ON role`
            // is non-optional (Pi dogfood, 2026-06-04). SET only touches `name`
            // - `weight` keeps its value, or gets DEFAULT 1.0 on first create.
            // roleName is validated by validateRoleName (^[a-z][a-z0-9_-]*$),
            // so it can't break out of the double-quoted string literal.
            const roleId = stableId("role", [roleName]);
            yield* write.put("role", cacheRow({ id: roleId, name: roleName, weight: 1 }));
            rolesUpserted += 1;

            yield* write.put("plays_role", cacheRow({
                id: edgeRowId("plays_role", args.skillId, roleId, "frontmatter"),
                in_id: args.skillId,
                out_id: roleId,
                confidence: 1,
                source: "frontmatter",
                weight: null,
                rationale: null,
            }));
            edgesWritten += 1;
        }
        return { rolesUpserted, edgesWritten, rolesSkipped };
    });
