import { Effect } from "effect";
import { Judgment, type JudgmentError } from "@ax/lib/sqlite";
import { edgeRowId, roleRowId } from "@ax/lib/stable-id";
import { validateRoleName } from "@ax/lib/role-name";

const safeRoleName = (name: string): string | null => {
    try {
        return validateRoleName(name);
    } catch {
        return null;
    }
};

/**
 * Write the frontmatter-sourced role tags for one skill.
 *
 * These rows are DURABLE JUDGMENT, so they go to the SQLite sidecar rather than
 * the rebuildable DuckDB cache - `role.weight` is user-tuned and `plays_role` is
 * a classification, and neither survives a cache re-derive (see the sidecar DDL's
 * "Role registry + role tags" note). `plays_role.in_id` still refs the CACHE
 * skill id, which is what `skillId` carries here.
 *
 * `source` is part of the natural key, so this mined writer and the user writer
 * behind `ax skills tag` can classify the same skill-role pair at once; each
 * removes only its OWN source before writing the current set. That sweep is what
 * makes role SHRINKAGE ([framing, execution] -> [framing]) and the empty-roles
 * case work in one pass.
 *
 * A `Judgment` service tag is safe inside an ingest stage: the sidecar has no
 * snapshot and no publish step, so a row written here is visible to the next
 * statement in the same stage (unlike `CacheRead`, see F1).
 */
export const relateSkillRoles = (
    args: { skillId: string; roles: ReadonlyArray<string> },
): Effect.Effect<{ rolesUpserted: number; edgesWritten: number; rolesSkipped: number }, JudgmentError, Judgment> =>
    Effect.gen(function* () {
        const judgment = yield* Judgment;
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

        // Replace this writer's complete opinion in ONE transaction, matching
        // `ax skills tag` and `ax skills lint`. The sweep and the writes are a
        // single statement of "these are the frontmatter roles now": a failure
        // between them would otherwise leave the skill with its old rows
        // removed and its new ones missing - a silently unclassified skill.
        let rolesUpserted = 0;
        let edgesWritten = 0;
        yield* judgment.transaction((transaction) =>
            Effect.gen(function* () {
                yield* transaction.exec(
                    "DELETE FROM plays_role WHERE in_id = ? AND source = 'frontmatter'",
                    [args.skillId],
                );
                for (const roleName of cleaned) {
                    // CREATE IF MISSING, never modify - the same contract
                    // `ax skills tag` holds. A role's `weight` is judgment of its
                    // own, and a skill's frontmatter naming that role says
                    // nothing about it. The DDL's DEFAULT seeds 1.0 on create.
                    const roleId = roleRowId(roleName);
                    yield* transaction.exec(
                        "INSERT INTO role (id, name) VALUES (?, ?) ON CONFLICT (id) DO NOTHING",
                        [roleId, roleName],
                    );
                    rolesUpserted += 1;

                    yield* transaction.put("plays_role", {
                        id: edgeRowId("plays_role", args.skillId, roleId, "frontmatter"),
                        in_id: args.skillId,
                        out_id: roleId,
                        confidence: 1,
                        source: "frontmatter",
                        weight: null,
                        rationale: null,
                    });
                    edgesWritten += 1;
                }
            }),
        );
        return { rolesUpserted, edgesWritten, rolesSkipped };
    });
