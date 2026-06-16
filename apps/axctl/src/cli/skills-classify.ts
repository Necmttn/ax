/**
 * `ax skills classify [<skill>...]` - emit one classify-brief per unclassified
 * skill with ≥3 invocations into `.ax/tasks/classify-<skill-slug>.md`.
 *
 * Default mode (no names): all unclassified skills with invocations >= 3.
 * Explicit mode (one+ names): only those skills, no invocation threshold.
 */
import { Effect, FileSystem, Path, type PlatformError } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { prettyPrint } from "@ax/lib/json";
import { skillNameToSlug, renderClassifyBrief } from "./skills-classify-template.ts";
import { validateSkillName } from "@ax/lib/role-name";
import { fail } from "./commands/shared.ts";
import { fetchSkillHygiene, SKILL_HYGIENE_MIN_INVOCATIONS } from "../queries/skill-hygiene.ts";

export interface ClassifyRow {
    readonly name: string;
    readonly invocations: number;
    readonly sessions: number;
}

export interface ClassifyResult {
    readonly selected: ClassifyRow[];
    readonly written: string[];
    readonly skipped: string[];
}

// Default mode ("unclassified skills with ≥3 invocations") no longer has its own
// SurrealQL here. It delegates to fetchSkillHygiene - the single source of truth
// shared with `ax skills weighted`. The old correlated predicate
// (`NOT (SELECT ... )[0]`) was broken: that subquery yields NONE for an
// unclassified skill, and `NOT NONE` is NONE (not true), so the WHERE clause
// silently excluded EVERY unclassified skill and classify always reported
// "none found" while weighted reported a positive count.

/**
 * SurrealQL for explicit mode: named skills only, no invocation threshold and
 * no unclassified guard (user-requested re-classification must be allowed).
 */
const buildExplicitSql = (names: readonly string[]) => {
    const nameList = names.map((n) => `"${n.replace(/"/g, '\\"')}"`).join(", ");
    return `
SELECT
    name,
    array::len((SELECT id FROM invoked WHERE out = $parent.id)) AS invocations,
    array::len(array::distinct((SELECT in.session FROM invoked WHERE out = $parent.id).in.session)) AS sessions
FROM skill
WHERE name IN [${nameList}]
ORDER BY invocations DESC;
`.trim();
};

const safeSkillName = (name: string): string | null => {
    try {
        return validateSkillName(name);
    } catch {
        return null;
    }
};

export interface ClassifyOptions {
    readonly names: readonly string[];
    readonly outDir: string;
    readonly dryRun: boolean;
    readonly json: boolean;
}

export const cmdSkillsClassify = (
    opts: ClassifyOptions,
): Effect.Effect<void, DbError | PlatformError.PlatformError, SurrealClient | FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        // Validate any explicitly-provided skill names at the boundary.
        if (opts.names.length > 0) {
            for (const name of opts.names) {
                if (safeSkillName(name) === null) {
                    fail(
                        `axctl skills classify: invalid skill name "${name}" (must be alphanumeric, _ or -, optionally plugin:namespaced)`,
                    );
                }
            }
        }

        // Default mode shares fetchSkillHygiene with `ax skills weighted` so the
        // two surfaces can never disagree on what counts as unclassified.
        // Explicit mode keeps its own query (named skills, no threshold, no
        // classified filter - re-classification must be allowed).
        let selected: ClassifyRow[];
        if (opts.names.length > 0) {
            const result = yield* db.query<[Array<Record<string, unknown>>]>(
                buildExplicitSql(opts.names),
            );
            const rows = (result?.[0] ?? []) as Array<Record<string, unknown>>;
            selected = rows.map((r) => ({
                name: String(r.name ?? ""),
                invocations: Number(r.invocations ?? 0),
                sessions: Number(r.sessions ?? 0),
            })).filter((r) => r.name.length > 0);
        } else {
            const hygiene = yield* fetchSkillHygiene({
                minInvocations: SKILL_HYGIENE_MIN_INVOCATIONS,
            });
            selected = hygiene.map((r) => ({
                name: r.name,
                invocations: r.invocations,
                sessions: r.sessions,
            }));
        }

        if (opts.json) {
            const out = selected.map((r) => ({
                skill: r.name,
                invocations: r.invocations,
                sessions: r.sessions,
                path: path.join(opts.outDir, `classify-${skillNameToSlug(r.name)}.md`),
            }));
            console.log(prettyPrint(out));
            return;
        }

        if (selected.length === 0) {
            console.log("no unclassified skills found (all have roles or < 3 invocations)");
            return;
        }

        if (opts.dryRun) {
            for (const row of selected) {
                const brief = renderClassifyBrief({
                    skillName: row.name,
                    invocations: row.invocations,
                    sessions: row.sessions,
                });
                console.log(`\n--- classify-${skillNameToSlug(row.name)}.md ---`);
                console.log(brief);
            }
            console.log(`\n(dry-run: ${selected.length} skills would be written)`);
            return;
        }

        // Ensure output directory exists
        yield* fs.makeDirectory(opts.outDir, { recursive: true });

        const written: string[] = [];
        const skipped: string[] = [];

        for (const row of selected) {
            const slug = skillNameToSlug(row.name);
            const filePath = path.join(opts.outDir, `classify-${slug}.md`);

            // Idempotent: skip if file already exists. Original used access() in
            // a try/catch where ANY failure meant "not present"; orAbsent keeps
            // that probe semantics.
            const exists = yield* fs.exists(filePath).pipe(orAbsent(false));

            if (exists) {
                skipped.push(filePath);
                continue;
            }

            const brief = renderClassifyBrief({
                skillName: row.name,
                invocations: row.invocations,
                sessions: row.sessions,
            });

            yield* fs.writeFileString(filePath, brief);
            written.push(filePath);
        }

        for (const p of written) {
            console.log(`wrote ${p}`);
        }
        for (const p of skipped) {
            console.log(`skipped ${p} (already exists)`);
        }
        const total = written.length;
        const skipCount = skipped.length;
        if (total === 0 && skipCount === 0) {
            console.log("nothing to write");
        } else {
            console.log(`${total} skills classified${skipCount > 0 ? `, ${skipCount} skipped` : ""}`);
        }
    });
