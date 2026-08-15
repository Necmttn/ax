/**
 * `ax skills tag <skill> <role>` - record (or remove) a user's role tag on a
 * skill.
 *
 * A REQUEST-TIME JUDGMENT WRITE, and the reason the SQLite sidecar exists. There
 * is no ingest run to attach this to: the user typed a command and expects the
 * decision recorded now. The DuckDB cache refuses a write outside the ingest
 * lock by construction, so before the sidecar this command had nowhere to go.
 *
 * The two engines split the work exactly as their contracts say:
 *   - the CACHE answers "does this skill exist, and what is its row id" - a skill
 *     exists because it is installed on disk, which is a derived fact;
 *   - the SIDECAR stores the tag, keyed by that row id.
 *
 * KEYED BY ID, NOT BY NAME. The tag has to survive a re-derive, and the thing
 * that makes it survive is the content-hash id contract: re-deriving the same
 * skill file rewrites a byte-identical id, so the tag still finds it.
 * `@ax/lib/sqlite/integrity` counts the tags where that fails.
 *
 * Idempotent per (skill, role), and ATOMIC: the role upsert, the removal of any
 * prior user tag, and the new tag are one transaction, so a failure halfway
 * cannot leave the pair tagless after having deleted the old tag.
 */
import { Effect } from "effect";
import { edgeRowId, roleRowId } from "@ax/lib/stable-id";
import { CacheRead, type CacheReadError } from "@ax/lib/duckdb/seam";
import { Judgment, type JudgmentError } from "@ax/lib/sqlite";
import { validateRoleName, validateSkillName } from "@ax/lib/role-name";
import { Schema } from "effect";
import { fail } from "./commands/shared.ts";

export interface SkillsTagOptions {
    readonly skillName: string;
    readonly roleName: string;
    readonly confidence: number;
    readonly rationale: string | undefined;
    readonly remove: boolean;
}

const safeSkillName = (name: string): string | null => {
    try {
        return validateSkillName(name);
    } catch {
        return null;
    }
};

const safeRoleName = (name: string): string | null => {
    try {
        return validateRoleName(name);
    } catch {
        return null;
    }
};

const SkillIdRow = Schema.Struct({ id: Schema.String });

/**
 * The tag's own row id.
 *
 * `edgeRowId` - the SAME helper every cache edge uses, not a private hash. A
 * plays_role row is an edge between a skill and a role, and it gets an edge id
 * for the same reason a cache edge does: re-running `ax skills tag composto
 * verification` must land on the SAME user row rather than appending a second
 * one. The source discriminator lets a mined row for the same pair remain.
 */
const tagId = (skillId: string, role: string): string =>
    edgeRowId("plays_role", skillId, role, "user");

export const cmdSkillsTag = (
    opts: SkillsTagOptions,
): Effect.Effect<void, CacheReadError | JudgmentError, CacheRead | Judgment> =>
    Effect.gen(function* () {
        const judgment = yield* Judgment;
        const read = yield* CacheRead;

        // 1. Validate inputs BEFORE opening anything. These names reach SQL only
        //    as bound parameters, so this is not injection defence (the seam's
        //    identifier rule covers that) - it is a refusal to record a decision
        //    about a name that cannot be a skill or a role.
        const trimmedSkill = safeSkillName(opts.skillName);
        if (trimmedSkill === null) {
            fail(
                `axctl skills tag: invalid skill name "${opts.skillName}" (must be alphanumeric, _ or -, optionally plugin:namespaced)`,
            );
        }

        const roleName = safeRoleName(opts.roleName);
        if (roleName === null) {
            fail(
                `axctl skills tag: invalid role name "${opts.roleName}" (must be lowercase alphanumeric, _ or -)`,
            );
        }
        if (opts.confidence < 0 || opts.confidence > 1) {
            fail(`axctl skills tag: --confidence must be between 0 and 1 (got ${opts.confidence})`);
        }

        // 2. Resolve the skill's CACHE row id by name.
        const skill = yield* read.first(SkillIdRow, "SELECT id FROM skill WHERE name = ? LIMIT 1", [
            trimmedSkill,
        ]);
        if (skill._tag === "None") {
            fail(`axctl skills tag: unknown skill "${trimmedSkill}"`);
        }
        const skillId = skill.value.id;
        const role = roleRowId(roleName);

        yield* judgment.transaction((transaction) =>
            Effect.gen(function* () {
                // 3. The role must exist before a tag can point at it. CREATE
                //    IF MISSING, never modify: a role's `weight` is judgment of
                //    its own (`ax roles` shows it, the weighted views multiply by
                //    it), and tagging a skill is not a statement about it. The
                //    DDL's DEFAULT seeds 1.0 on the create path.
                //
                //    (`put` would ALSO preserve the weight - the seam's upsert
                //    only writes the columns a caller names, so a two-column put
                //    leaves `weight` alone. DO NOTHING is here for the intent, not
                //    to fix a bug in `put`: it says this command never modifies an
                //    existing role, which is stronger than "happens not to".)
                yield* transaction.exec(
                    "INSERT INTO role (id, name) VALUES (?, ?) ON CONFLICT (id) DO NOTHING",
                    [role, roleName],
                );

                // 4. Drop any prior USER tag for this pair. Scoped to
                //    source='user' because a mined tag (frontmatter, classifier)
                //    is somebody else's opinion: a user removing their own tag
                //    must not erase it.
                yield* transaction.exec(
                    "DELETE FROM plays_role WHERE in_id = ? AND out_id = ? AND source = 'user'",
                    [skillId, role],
                );

                if (opts.remove) return;

                yield* transaction.put("plays_role", {
                    id: tagId(skillId, role),
                    in_id: skillId,
                    out_id: role,
                    source: "user",
                    confidence: opts.confidence,
                    rationale: opts.rationale ?? null,
                    since: new Date(),
                });
            }),
        );

        console.log(
            opts.remove
                ? `removed plays_role edge: ${trimmedSkill} -> ${roleName} (source=user)`
                : `tagged ${trimmedSkill} -> ${roleName} (source=user, confidence=${opts.confidence})`,
        );
    });
