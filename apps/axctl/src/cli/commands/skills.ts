// Extracted from cli/index.ts (Phase 2 CLI split)
import { Effect, FileSystem, Path } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { SurrealClient } from "@ax/lib/db";
import { prettyPrint } from "@ax/lib/json";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { prettifyProjectSlug } from "@ax/lib/shared/project-slug";
import { fetchSkillsWeighted } from "../../dashboard/skills-weighted.ts";
import {
    fetchSkillsByRole,
    fetchRolesForSkill,
    fetchAllRoles,
} from "../../dashboard/role-queries.ts";
import { loadAgentScopeMap } from "../../ingest/agent-scope.ts";
import {
    buildSkillsWeightedNext,
    buildSkillsByRoleNext,
    buildSkillsRolesNext,
    buildRolesNext,
} from "../../nav/next-links.ts";
import { fetchSkillStats } from "../../queries/skill-stats.ts";
import { fetchUnusedSkills } from "../../queries/unused-skills.ts";
import { skillsConfigSubcommands } from "../../skills/cli.ts";
import { printNextLinks } from "../next-format.ts";
import { catchDbErrorAndExit, stderrExit, wantsJsonFlag } from "../output.ts";
import {
    renderSkillsByRoleTable,
    renderSkillsByRoleJson,
    renderRolesForSkillTable,
    renderRolesForSkillJson,
    renderAllRolesTable,
    renderAllRolesJson,
} from "../role-format.ts";
import { cmdSkillsClassify } from "../skills-classify.ts";
import { cmdSkillsLint } from "../skills-lint.ts";
import { cmdSkillsTag } from "../skills-tag.ts";
import { renderWeightedTable, renderWeightedJson } from "../skills-weighted-format.ts";
import type { RuntimeManifest } from "./manifest.ts";
import {
    fmtCount,
    jsonFlag,
    optionValue,
    positiveLimit,
    requirePositiveInt,
    requireOptionalPositiveInt,
} from "./shared.ts";

interface SearchInput {
    readonly query: string;
    readonly limit: number;
}

const cmdSearch = (input: SearchInput) =>
    Effect.gen(function* () {
        const query = input.query;
        const limit = requirePositiveInt("search", "limit", input.limit);
        // Keep the empty-query guard: the variadic <query> argument has
        // min 1, but a quoted empty string ("") can still arrive.
        if (!query) {
            console.error("axctl skills search: missing query");
            process.exit(1);
        }
        const db = yield* SurrealClient;
        // Primary path: SurrealDB v3 BM25 FTS via the skill_search_name +
        // skill_search_desc indexes (defined in schema/schema.surql with
        // ngram(2, 8) tokenisation, so "test" hits "test-driven"). The
        // `@N@` matches operator references an index by *position in the
        // WHERE clause* (not field), and `search::score(N)` returns the
        // BM25 score for predicate N. Combined score = sum of name +
        // description BM25 scores; either side is NONE when only one
        // matched, so we coerce via `math::max([score, 0])`.
        //
        // Time-window counts use explicit `invoked WHERE out = $parent.id`
        // form rather than `<-invoked WHERE ts > ...`. The graph-traversal
        // form materialises edges first then the WHERE drops every row
        // (returns 0 even when matches exist). See issue #15.
        // PERF (issue #31): The per-row `(SELECT count() FROM invoked
        // WHERE out = $parent.id AND ts > 30d ...)` subquery costs ~1.5s
        // per matched skill that happens to be one of the high-volume
        // ones (e.g. codex:exec_command @ ~500k edges). For a search hit
        // that includes them, total runtime jumps to 30s+. The fix is the
        // same as cmdTaste: do the per-skill recent counters in one
        // GROUP BY scan, then merge with the FTS-ranked result list.
        const ftsSql = `
SELECT
    id,
    name,
    scope,
    description,
    (math::max([search::score(0), 0.0]) + math::max([search::score(1), 0.0])) AS score
FROM skill
WHERE name @0@ $q OR description @1@ $q
ORDER BY score DESC
LIMIT ${limit};`;
        const legacySql = `
SELECT
    id,
    name,
    scope,
    description,
    (IF string::lowercase(name) CONTAINS $q THEN 2.0 ELSE 0.0 END
     + IF string::lowercase(description ?? '') CONTAINS $q THEN 1.0 ELSE 0.0 END) AS score
FROM skill
WHERE
    string::lowercase(name) CONTAINS $q
    OR string::lowercase(description ?? '') CONTAINS $q
ORDER BY score DESC
LIMIT ${limit};`;
        // Per-skill aggregates over `invoked` in one full scan
        // (~1-2s) - cheap relative to repeating it per matched skill.
        const aggSql = `
SELECT
    out AS skill_id,
    count() AS total_inv,
    math::sum(IF ts > time::now() - 30d THEN 1 ELSE 0 END) AS inv_30d,
    math::max(ts) AS last_used
FROM invoked
GROUP BY out;`;
        const matchResult = yield* db
            .query<[Array<Record<string, unknown>>]>(ftsSql, { q: query })
            .pipe(
                Effect.catch(() =>
                    db.query<[Array<Record<string, unknown>>]>(legacySql, {
                        q: query.toLowerCase(),
                    }),
                ),
            );
        const aggResult = yield* db.query<[Array<Record<string, unknown>>]>(aggSql);
        const matched = (matchResult?.[0] ?? []) as Array<Record<string, unknown>>;
        const aggMap = new Map<string, Record<string, unknown>>();
        for (const a of (aggResult?.[0] ?? []) as Array<Record<string, unknown>>) {
            aggMap.set(String(a.skill_id ?? ""), a);
        }
        const rows = matched
            .map((m) => {
                const agg = aggMap.get(String(m.id ?? ""));
                return {
                    name: m.name,
                    scope: m.scope,
                    description: m.description,
                    score: m.score,
                    total_inv: agg ? Number(agg.total_inv ?? 0) : 0,
                    inv_30d: agg ? Number(agg.inv_30d ?? 0) : 0,
                    last_used: agg?.last_used ?? null,
                };
            })
            .sort((a, b) => {
                const ds = Number(b.score ?? 0) - Number(a.score ?? 0);
                if (ds !== 0) return ds;
                const d30 = b.inv_30d - a.inv_30d;
                if (d30 !== 0) return d30;
                return b.total_inv - a.total_inv;
            });
        if (!rows || rows.length === 0) {
            console.log("(no matches)");
            return;
        }
        for (const r of rows) {
            const score = Number(r.score ?? 0);
            const scoreStr = score.toFixed(2);
            const usage = `${fmtCount(r.inv_30d ?? 0)}×30d / ${fmtCount(r.total_inv ?? 0)}×total`;
            const desc = (r.description as string | null) ?? "";
            const truncDesc = desc.length > 100 ? desc.slice(0, 97) + "…" : desc;
            console.log(`${r.name}  [${r.scope}]  score=${scoreStr}  ${usage}`);
            if (truncDesc) console.log(`  ${truncDesc}`);
        }
    });

/**
 * Issue #40: Pre-flight existence check so unknown skill names get a
 * dedicated error instead of an empty-but-success rendering. Returns true
 * if the skill exists. Pulls the SurrealClient itself rather than taking
 * it as a parameter so the helper composes naturally inside Effect.gen.
 */
const skillExists = (name: string) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const result = yield* db.query<[unknown[]]>(
            "SELECT id FROM skill WHERE name = $name LIMIT 1;",
            { name },
        );
        const rows = result?.[0];
        return Array.isArray(rows) && rows.length > 0;
    });

interface StatsInput {
    /** Optional on purpose: a bare `ax skills stats` reaches the teaching error below. */
    readonly name: string | undefined;
}

const cmdStats = (input: StatsInput) =>
    Effect.gen(function* () {
        const name = input.name;
        if (!name) {
            // Errors-as-teaching: name the command that answers the likely
            // intent (aggregate ranking) instead of a bare usage error.
            console.error(
                "axctl skills stats: missing <skill> (per-skill detail). " +
                    "For the aggregate usage ranking use `ax skills weighted`; " +
                    "to find a skill name use `ax recall \"<query>\" --sources=skill`.",
            );
            process.exit(1);
        }
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exists = yield* skillExists(name);
        if (!exists) {
            const hint = name.length > 20 ? name.slice(0, 20) : name;
            console.error(
                `axctl: no skill named "${name}". try: axctl skills search "${hint}"`,
            );
            process.exit(2);
        }
        const payload = yield* fetchSkillStats(name);

        // Read body lazily from disk via dir_path (DB no longer stores body -
        // multi-file skills + cache-staleness make on-disk the canonical source).
        const dirPath = payload.skill?.dir_path;
        // Issue #36: codex-side tools are recorded with a synthetic dir_path
        // sentinel. They have no SKILL.md, so skip the disk read entirely
        // instead of letting Effect.promise(...) crash with ENOENT.
        if (
            typeof dirPath === "string" &&
            dirPath.length > 0 &&
            dirPath !== "(synthetic)"
        ) {
            // Use plain Effect.promise with an inner try/catch that resolves
            // to `null` on read failures (e.g. SKILL.md missing for the rare
            // legacy plugin row whose dir_path is stale). Avoids tripping
            // tryPromise's typed-error machinery when we just want a fall
            // through. Catches issue #36 too: synthetic dir_path was already
            // skipped above, but defence-in-depth keeps a future "(synthetic-
            // like)" sentinel from regressing.
            const body = yield* fs
                .readFileString(path.join(dirPath, "SKILL.md"))
                .pipe(orAbsent<string | null>(null));
            if (body !== null) {
                const m = body.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
                const trimmed = (m?.[1] ?? body).trim();
                if (trimmed.length > 0) {
                    const excerpt =
                        trimmed.length > 500 ? trimmed.slice(0, 500) + "…" : trimmed;
                    console.log("--- body excerpt ---");
                    console.log(excerpt);
                    console.log("--- end body ---\n");
                }
            }
        }
        console.log(prettyPrint(payload));
    });

interface RecentInput {
    readonly limit: number;
}

const cmdRecent = (input: RecentInput) =>
    Effect.gen(function* () {
        const limit = requirePositiveInt("recent", "limit", input.limit);
        const db = yield* SurrealClient;
        const sql = `
SELECT ts, out.name AS skill, in.session.project AS project
FROM invoked
ORDER BY ts DESC
LIMIT ${limit};`;
        const result = yield* db.query<[Array<Record<string, unknown>>]>(sql);
        const rows = result?.[0];
        for (const r of rows ?? []) {
            console.log(
                `${r.ts}  ${r.skill}  (${prettifyProjectSlug(r.project)})`,
            );
        }
    });

interface UnusedInput {
    readonly days: number;
    readonly includeScoped: boolean;
}

const cmdUnused = (input: UnusedInput) =>
    Effect.gen(function* () {
        const days = requirePositiveInt("unused", "days", input.days);
        const includeScoped = input.includeScoped;
        // Skills declared in a subagent's `skills:` frontmatter load only when
        // that agent is spawned - they're not global dead weight. Recover the
        // skill → agent(s) map from disk so they can be hidden/tagged here.
        const agentScope = yield* loadAgentScopeMap();
        const unused = yield* fetchUnusedSkills({ days });
        let hiddenScoped = 0;
        for (const r of unused) {
            const last = r.last_used ?? "never";
            const agents = agentScope.get(r.name);
            if (agents && agents.length > 0) {
                // Agent-scoped: not global dead weight. Hide unless asked,
                // and when shown, tag with the owning agent(s) instead of scope.
                if (!includeScoped) {
                    hiddenScoped++;
                    continue;
                }
                console.log(
                    `${r.name}  [agent:${agents.join(",")}]  total=${fmtCount(r.total_inv)}  last=${last}`,
                );
                continue;
            }
            console.log(
                `${r.name}  [${r.scope}]  total=${fmtCount(r.total_inv)}  last=${last}`,
            );
        }
        const shown = unused.length - (includeScoped ? 0 : hiddenScoped);
        console.log(`\n${shown} skills unused in last ${days} days.`);
        if (hiddenScoped > 0 && !includeScoped) {
            console.log(
                `${hiddenScoped} agent-scoped skills hidden (load only inside a subagent); --include-scoped to show.`,
            );
        }
    });

interface SkillsWeightedInput {
    readonly limit: number;
    readonly windowDays: number | undefined;
    readonly doctorThreshold: number;
    readonly includeTools: boolean;
    readonly json: boolean;
}

const cmdSkillsWeighted = (input: SkillsWeightedInput) =>
    Effect.gen(function* () {
        const limit = requirePositiveInt("skills weighted", "limit", input.limit);
        const windowDays = requireOptionalPositiveInt("skills weighted", "window", input.windowDays);
        const doctorThreshold = requirePositiveInt("skills weighted", "doctor-threshold", input.doctorThreshold);
        const json = input.json;
        const includeTools = input.includeTools;

        // --window=0 is invalid: requireOptionalPositiveInt rejects it (n <= 0)
        // with exit 2, mirroring the old parseOptionalPositiveIntFlag behavior.

        const result = yield* fetchSkillsWeighted({
            ...(windowDays !== undefined ? { windowDays } : {}),
            limit,
            doctorThreshold,
            includeTools,
        }).pipe(
            catchDbErrorAndExit("axctl skills weighted"),
        );

        if (json) {
            console.log(renderWeightedJson(result));
        } else {
            printNextLinks(buildSkillsWeightedNext(result));
            console.log(renderWeightedTable(result));
        }
    });

// ---------------------------------------------------------------------------
// P3.7: Role read commands
// ---------------------------------------------------------------------------

interface SkillsByRoleInput {
    readonly role: string;
    readonly limit: number;
    readonly json: boolean;
}

/**
 * `ax skills by-role <role> [--json] [--limit=N]`
 * List skills classified as a given role, ranked by invocations.
 */
const cmdSkillsByRole = (input: SkillsByRoleInput) =>
    Effect.gen(function* () {
        // The old missing-role guard is dead: <role> is a required
        // Argument.string, so the CLI parser rejects the bare invocation.
        const role = input.role;
        const json = wantsJsonFlag(input.json);
        const limit = requirePositiveInt("skills by-role", "limit", input.limit);

        const result = yield* fetchSkillsByRole({ role, limit }).pipe(
            catchDbErrorAndExit("axctl skills by-role"),
        );

        if (json) {
            console.log(renderSkillsByRoleJson(result, role));
        } else {
            printNextLinks(buildSkillsByRoleNext(result, role));
            console.log(renderSkillsByRoleTable(result, role));
        }
    });

interface RolesForSkillInput {
    readonly skill: string;
    readonly json: boolean;
}

/**
 * `ax skills roles <skill> [--json]`
 * List all roles for a given skill.
 */
const cmdRolesForSkill = (input: RolesForSkillInput) =>
    Effect.gen(function* () {
        // The old missing-skill guard is dead: <skill> is a required
        // Argument.string, so the CLI parser rejects the bare invocation.
        const skill = input.skill;
        const json = wantsJsonFlag(input.json);

        const result = yield* fetchRolesForSkill({ skill }).pipe(
            catchDbErrorAndExit("axctl skills roles"),
        );

        if (!result.skillExists) {
            process.stderr.write(`axctl skills roles: unknown skill "${skill}"\n`);
            process.exit(2);
        }

        if (json) {
            console.log(renderRolesForSkillJson(result, skill));
        } else {
            printNextLinks(buildSkillsRolesNext(result, skill));
            console.log(renderRolesForSkillTable(result, skill));
        }
    });

interface RolesInput {
    readonly json: boolean;
}

/**
 * `ax roles [--json]`
 * List all roles with skill counts.
 */
const cmdRoles = (input: RolesInput) =>
    Effect.gen(function* () {
        const json = wantsJsonFlag(input.json);

        const result = yield* fetchAllRoles().pipe(
            catchDbErrorAndExit("axctl roles"),
        );

        if (json) {
            console.log(renderAllRolesJson(result));
        } else {
            printNextLinks(buildRolesNext(result));
            console.log(renderAllRolesTable(result));
        }
    });

interface TasteInput {
    readonly limit: number;
    readonly includeTools: boolean;
}

const cmdTaste = (input: TasteInput) =>
    Effect.gen(function* () {
        const limit = requirePositiveInt("taste", "limit", input.limit);
        const includeTools = input.includeTools;
        const syntheticFilter = includeTools
            ? ""
            : ` AND (skill_id.dir_path IS NONE OR skill_id.dir_path != "(synthetic)")`;
        const syntheticSkillFilter = includeTools
            ? ""
            : ` AND (dir_path IS NONE OR dir_path != "(synthetic)")`;
        const db = yield* SurrealClient;
        // Composite signal: invocations (positive), errors near invocation
        // (negative), corrections within 3 turns of invocation in the same
        // session (negative - user pushed back), commits produced by sessions
        // that invoked this skill (positive - led to a real change), and
        // proposed-but-not-invoked (negative - assistant suggested it but
        // never fired, wasted suggestion).
        //
        // `corrections` counts invocations where the next user turn within 3
        // seq steps in the same session triggered a corrected_by edge.
        // `commits_after` counts `produced` edges from sessions that invoked
        // this skill (proxy for "skill use led to a commit").
        // `proposals` counts proposed edges into this skill.
        // taste_score = inv_total - 2*corrections + commits_after - 0.5*proposals
        //
        // PERF (issue #31): The previous form ran 4-5 correlated subqueries
        // per skill (`WHERE out = $parent.id AND <pred>`), each forcing the
        // index scan to walk every edge for that skill. On the largest skill
        // (codex:exec_command, ~500k edges) every subquery cost ~1.5-2s,
        // putting the total at ~167s for 137 skills. SurrealDB's optimiser
        // doesn't push graph traversal `<-invoked WHERE ...` past the edge
        // materialisation either, so neither FETCH nor inline graph-WHERE
        // helped meaningfully (~90s).
        //
        // Current form does the heavy aggregation in ONE pass over the
        // `invoked` table via `GROUP BY out` with conditional `math::sum`.
        // This requires two new denormalised fields on the edge:
        //   - `turn_has_error` (set at ingest from the source turn)
        //   - `was_corrected`  (set by derive-signals when a corrected_by
        //                       edge falls within +3 seq of the invocation)
        // so that the `clean_inv` / `corrections` predicates become pure
        // edge-field filters. End-to-end taste runtime drops to ~13s.
        //
        // The query runs in three server-side stages plus a client-side
        // merge so that *every* skill row gets a slot, not just those with
        // invoked or proposed edges (issue #47):
        //   (a) AGGREGATES_SQL  - per-skill counters from the invoked scan,
        //                         then enriches with `<-proposed` /
        //                         `<-invoked.in.session` traversals and
        //                         `produced` join.
        //   (b) PROPOSED_ONLY_SQL - skills with no invocations but with
        //                           proposals, contributing the negative
        //                           taste_score floor (-0.5 * proposals).
        //   (c) ZERO_SQL          - skills with neither invocations nor
        //                           proposals; rendered with score 0 so the
        //                           total skill count is honest.
        // Results are concatenated and sorted in TS to mirror the original
        // ORDER BY taste_score DESC, inv_30d DESC, inv_total DESC.
        const aggregatesSql = `
SELECT
    name,
    scope,
    inv_total,
    inv_7d,
    inv_30d,
    clean_inv,
    corrections,
    proposals,
    array::len((
        SELECT id FROM produced WHERE in IN $parent.skill_sessions
    )) AS commits_after,
    (
        inv_total
        - 2 * corrections
        + array::len((SELECT id FROM produced WHERE in IN $parent.skill_sessions))
        - 0.5 * proposals
    ) AS taste_score
FROM (
    SELECT
        skill_id.name AS name,
        skill_id.scope AS scope,
        inv_total,
        inv_7d,
        inv_30d,
        clean_inv,
        corrections,
        array::len(skill_id<-proposed) AS proposals,
        array::distinct(skill_id<-invoked.in.session ?? []) AS skill_sessions
    FROM (
        SELECT
            out AS skill_id,
            count() AS inv_total,
            math::sum(IF ts > time::now() - 7d  THEN 1 ELSE 0 END) AS inv_7d,
            math::sum(IF ts > time::now() - 30d THEN 1 ELSE 0 END) AS inv_30d,
            math::sum(IF turn_has_error = false THEN 1 ELSE 0 END) AS clean_inv,
            math::sum(IF was_corrected   = true  THEN 1 ELSE 0 END) AS corrections
        FROM invoked
        GROUP BY out
    )
    -- Drop orphan invocations whose target skill never had its row UPSERTed
    -- (matches the original cmdTaste behaviour, which started FROM skill and
    -- thus naturally excluded these). Currently happens for a handful of
    -- legacy plugin/built-in tool names that didn't get recorded as skills.
    -- Drop synthetic provider tools by default too: these are low-level tool
    -- invocations, not named skills, and otherwise dominate the setup signal.
    WHERE skill_id.name IS NOT NONE
        ${syntheticFilter}
);`;

        // Skills with proposals but no invocations - the GROUP BY scan
        // doesn't see them. Cheap: 137-skill count + per-skill proposal
        // count, all via graph traversal.
        const proposedOnlySql = `
SELECT
    name,
    scope,
    0 AS inv_total,
    0 AS inv_7d,
    0 AS inv_30d,
    0 AS clean_inv,
    0 AS corrections,
    array::len(<-proposed) AS proposals,
    0 AS commits_after,
    -0.5 * array::len(<-proposed) AS taste_score
FROM skill
WHERE array::len(<-invoked) = 0 AND array::len(<-proposed) > 0${syntheticSkillFilter};`;

        // Issue #47: skills with neither invocations nor proposals get
        // dropped entirely from the merged set, so `taste --limit=200`
        // returns ~35 rows instead of all 137. Pull them in with a flat
        // zero score so the table reflects the real catalog.
        const zeroSql = `
SELECT
    name,
    scope,
    0 AS inv_total,
    0 AS inv_7d,
    0 AS inv_30d,
    0 AS clean_inv,
    0 AS corrections,
    0 AS proposals,
    0 AS commits_after,
    0 AS taste_score
FROM skill
WHERE array::len(<-invoked) = 0 AND array::len(<-proposed) = 0${syntheticSkillFilter};`;

        const [aggResult, propResult, zeroResult] = yield* Effect.all(
            [
                db.query<[Array<Record<string, unknown>>]>(aggregatesSql),
                db.query<[Array<Record<string, unknown>>]>(proposedOnlySql),
                db.query<[Array<Record<string, unknown>>]>(zeroSql),
            ],
            { concurrency: 3 },
        );
        const aggRows = aggResult?.[0] ?? [];
        const propRows = propResult?.[0] ?? [];
        const zeroRows = zeroResult?.[0] ?? [];
        // Merge + sort to mirror original ORDER BY (server-side ORDER BY
        // would force a second pass over the merged set, simpler in TS).
        const score = (r: Record<string, unknown>) => Number(r.taste_score ?? 0);
        const merged = [...aggRows, ...propRows, ...zeroRows].sort((a, b) => {
            const ds = score(b) - score(a);
            if (ds !== 0) return ds;
            const d30 = Number(b.inv_30d ?? 0) - Number(a.inv_30d ?? 0);
            if (d30 !== 0) return d30;
            return Number(b.inv_total ?? 0) - Number(a.inv_total ?? 0);
        });
        const totalRows = merged.length;
        const rows = merged.slice(0, limit);
        const fmtScore = (n: unknown): string => {
            const v = Number(n ?? 0);
            return Number.isInteger(v) ? fmtCount(v) : v.toFixed(1);
        };
        // Issue #46: pre-compute column widths from the displayed rows so
        // 6+ digit values (e.g. codex:exec_command at 597,508) don't bleed
        // into the next column. Header width sets the floor.
        const cols = [
            { key: "score", header: "score", get: (r: Record<string, unknown>) => fmtScore(r.taste_score) },
            { key: "7d", header: "7d", get: (r: Record<string, unknown>) => fmtCount(r.inv_7d) },
            { key: "30d", header: "30d", get: (r: Record<string, unknown>) => fmtCount(r.inv_30d) },
            { key: "total", header: "total", get: (r: Record<string, unknown>) => fmtCount(r.inv_total) },
            { key: "clean", header: "clean", get: (r: Record<string, unknown>) => fmtCount(r.clean_inv) },
            { key: "corr", header: "corr", get: (r: Record<string, unknown>) => fmtCount(r.corrections ?? 0) },
            { key: "prop", header: "prop", get: (r: Record<string, unknown>) => fmtCount(r.proposals ?? 0) },
            { key: "cmts", header: "cmts", get: (r: Record<string, unknown>) => fmtCount(r.commits_after ?? 0) },
        ];
        const widths = cols.map((c) =>
            Math.max(c.header.length, ...rows.map((r) => c.get(r).length)),
        );
        const headerCells = cols.map((c, i) => c.header.padStart(widths[i])).join("  ");
        console.log(
            `${"skill".padEnd(50)}  ${"scope".padEnd(16)}  ${headerCells}`,
        );
        for (const r of rows ?? []) {
            const cells = cols.map((c, i) => c.get(r).padStart(widths[i])).join("  ");
            console.log(
                `${String(r.name).padEnd(50)}  ${String(r.scope).padEnd(16)}  ${cells}`,
            );
        }
        console.log(`\n(${rows.length} / ${totalRows} skills shown)`);
    });

interface PairsInput {
    readonly name: string;
    readonly limit: number;
}

const cmdPairs = (input: PairsInput) =>
    Effect.gen(function* () {
        // The old missing-name guard is dead: <skill> is a required
        // Argument.string, so the CLI parser rejects the bare invocation.
        const name = input.name;
        const limit = requirePositiveInt("pairs", "limit", input.limit);
        const db = yield* SurrealClient;
        const exists = yield* skillExists(name);
        if (!exists) {
            const hint = name.length > 20 ? name.slice(0, 20) : name;
            console.error(
                `axctl: no skill named "${name}". try: axctl skills search "${hint}"`,
            );
            process.exit(2);
        }
        // Pairs are stored undirected (lexicographically lo->hi). Look the
        // skill up on either endpoint so callers don't have to know the
        // canonical direction. Combine both legs into a single ranked list.
        // Pairs are stored undirected (lexicographically lo->hi), so the
        // queried skill could be on either endpoint. Use IF/ELSE to pick the
        // partner regardless of position; SurrealDB lacks UNION on SELECTs.
        const sql = `
LET $s = (SELECT id FROM skill WHERE name = $name)[0].id;
SELECT
    (IF in = $s THEN out.name ELSE in.name END) AS partner,
    count,
    last_seen
FROM skill_paired
WHERE in = $s OR out = $s
ORDER BY count DESC
LIMIT ${limit};`;
        const result = yield* db.query<unknown[]>(sql, { name });
        const arr = Array.isArray(result)
            ? [...result].reverse().find((r) => Array.isArray(r) && (r as unknown[]).length > 0)
            : undefined;
        const rows = (arr as Array<Record<string, unknown>> | undefined) ?? [];
        if (rows.length === 0) {
            console.log("(no co-occurring skills)");
            return;
        }
        console.log(`${"partner".padEnd(50)}  count  last_seen`);
        for (const r of rows) {
            console.log(
                `${String(r.partner).padEnd(50)}  ${String(r.count).padStart(5)}  ${r.last_seen ?? "-"}`,
            );
        }
    });

interface RecoveryInput {
    readonly limit: number;
}

const cmdRecovery = (input: RecoveryInput) =>
    Effect.gen(function* () {
        const limit = requirePositiveInt("recovery", "limit", input.limit);
        const db = yield* SurrealClient;
        const sql = `
SELECT out.name AS skill, count() AS hits
FROM recovered_by
GROUP BY skill
ORDER BY hits DESC
LIMIT ${limit};`;
        const result = yield* db.query<[Array<Record<string, unknown>>]>(sql);
        const rows = result?.[0];
        if (!rows || rows.length === 0) {
            console.log("(no recovery edges)");
            return;
        }
        console.log(`${"skill".padEnd(50)}  hits`);
        for (const r of rows) {
            console.log(`${String(r.skill).padEnd(50)}  ${String(r.hits).padStart(4)}`);
        }
    });

const searchCommand = Command.make(
    "search",
    {
        query: Argument.string("query").pipe(Argument.variadic({ min: 1 })),
        limit: positiveLimit(10),
    },
    ({ query, limit }) => cmdSearch({ query: query.join(" "), limit }),
).pipe(Command.withDescription("Search skills by name or description"));

const statsCommand = Command.make(
    "stats",
    // Optional so a bare `ax skills stats` reaches our teaching error instead
    // of the framework's "Missing required argument" dead end - dogfood retro
    // showed an agent guessing this command for the AGGREGATE ranking.
    { skill: Argument.string("skill").pipe(Argument.optional) },
    ({ skill }) => cmdStats({ name: optionValue(skill) }),
).pipe(Command.withDescription("Show detailed stats for ONE skill (requires <skill>). For the aggregate usage ranking use `ax skills weighted`."));

const recentCommand = Command.make(
    "recent",
    { limit: positiveLimit(20) },
    ({ limit }) => cmdRecent({ limit }),
).pipe(Command.withDescription("Show recent skill invocations"));

const unusedCommand = Command.make(
    "unused",
    {
        days: Flag.integer("days").pipe(Flag.withDefault(7)),
        includeScoped: Flag.boolean("include-scoped").pipe(Flag.withDefault(false)),
    },
    ({ days, includeScoped }) => cmdUnused({ days, includeScoped }),
).pipe(
    Command.withDescription(
        "List skills unused within a time window (agent-scoped skills hidden unless --include-scoped)",
    ),
);

const tasteCommand = Command.make(
    "taste",
    {
        limit: positiveLimit(30),
        includeTools: Flag.boolean("include-tools").pipe(Flag.withDefault(false)),
    },
    ({ limit, includeTools }) => cmdTaste({ limit, includeTools }),
).pipe(Command.withDescription(
    "Rank named skills by usage, corrections, proposals, and produced commits. " +
    "Synthetic provider tools are hidden by default; use --include-tools to rank them too.",
));

const pairsCommand = Command.make(
    "pairs",
    {
        skill: Argument.string("skill"),
        limit: positiveLimit(20),
    },
    ({ skill, limit }) => cmdPairs({ name: skill, limit }),
).pipe(Command.withDescription("Show co-occurring skills"));

const recoveryCommand = Command.make(
    "recovery",
    { limit: positiveLimit(20) },
    ({ limit }) => cmdRecovery({ limit }),
).pipe(Command.withDescription("Show skills that recovered failed work"));

const classifyCommand = Command.make(
    "classify",
    {
        names: Argument.string("skill").pipe(Argument.variadic({ min: 0 })),
        outDir: Flag.string("out-dir").pipe(Flag.withDefault(".ax/tasks")),
        dryRun: Flag.boolean("dry-run").pipe(Flag.withDefault(false)),
        json: jsonFlag,
    },
    ({ names, outDir, dryRun, json }) =>
        cmdSkillsClassify({
            names: [...names],
            outDir,
            dryRun,
            json,
        }),
).pipe(
    Command.withDescription(
        "Emit classify-brief task files for unclassified skills with ≥3 invocations. " +
        "With skill names: emit briefs for those specific skills (no threshold). " +
        "--out-dir=<path> (default .ax/tasks)  --dry-run  --json",
    ),
);

const tagCommand = Command.make(
    "tag",
    {
        skill: Argument.string("skill"),
        role: Argument.string("role"),
        confidence: Flag.float("confidence").pipe(Flag.withDefault(1.0)),
        rationale: Flag.string("rationale").pipe(Flag.optional),
        remove: Flag.boolean("remove").pipe(Flag.withDefault(false)),
    },
    ({ skill, role, confidence, rationale, remove }) =>
        cmdSkillsTag({
            skillName: skill,
            roleName: role,
            confidence,
            rationale: optionValue(rationale),
            remove,
        }).pipe(
            catchDbErrorAndExit("axctl skills tag"),
        ),
).pipe(
    Command.withDescription(
        "Manually assign a role to a skill (writes a plays_role edge with source=user). " +
        "Idempotent. Use --remove to delete an existing user-source edge. " +
        "--confidence=N (0–1, default 1.0)  --rationale=\"...\""
    ),
);

const skillsLintCommand = Command.make(
    "lint",
    {
        taskDir: Flag.string("task-dir").pipe(Flag.withDefault(".ax/tasks")),
        dryRun: Flag.boolean("dry-run").pipe(Flag.withDefault(false)),
        json: jsonFlag,
    },
    ({ taskDir, dryRun, json }) =>
        cmdSkillsLint({ taskDir, dryRun, json }).pipe(
            Effect.catchTag("PlatformError", (e) =>
                stderrExit(`axctl skills lint: file error - ${e.message}\n`, 1),
            ),
            catchDbErrorAndExit("axctl skills lint"),
        ),
).pipe(
    Command.withDescription(
        "Read filled classify briefs from --task-dir (default .ax/tasks) and write plays_role " +
        "edges with source=\"brief\". Removes applied brief files. " +
        "--dry-run  --json  --task-dir=<path>",
    ),
);

const weightedCommand = Command.make(
    "weighted",
    {
        window: Flag.integer("window").pipe(Flag.optional),
        limit: positiveLimit(25),
        doctorThreshold: Flag.integer("doctor-threshold").pipe(Flag.withDefault(5)),
        includeTools: Flag.boolean("include-tools").pipe(Flag.withDefault(false)),
        json: jsonFlag,
    },
    ({ window, limit, doctorThreshold, includeTools, json }) =>
        cmdSkillsWeighted({
            limit,
            windowDays: optionValue(window),
            doctorThreshold,
            includeTools,
            json,
        }),
).pipe(
    Command.withDescription(
        "Rank skills by usage × role-weight (classified skills score higher). " +
        "Provider built-in tools (codex/pi/etc.) are excluded by default; pass " +
        "--include-tools to rank them too. " +
        "Doctor mode warns when many skills are unclassified. " +
        "--window=Nd  --limit=N  --doctor-threshold=N  --include-tools  --json",
    ),
);

// P3.7: ax skills by-role <role>
const byRoleCommand = Command.make(
    "by-role",
    {
        role: Argument.string("role"),
        limit: positiveLimit(50),
        json: jsonFlag,
    },
    ({ role, limit, json }) => cmdSkillsByRole({ role, limit, json }),
).pipe(
    Command.withDescription(
        "List skills classified as <role>, ranked by invocations. " +
        "--limit=N  --json",
    ),
);

// P3.7: ax skills roles <skill>
const rolesForSkillCommand = Command.make(
    "roles",
    {
        skill: Argument.string("skill"),
        json: jsonFlag,
    },
    ({ skill, json }) => cmdRolesForSkill({ skill, json }),
).pipe(
    Command.withDescription(
        "List all roles assigned to <skill>. Exit 2 if skill is unknown. --json",
    ),
);

export const skillsCommand = Command.make("skills").pipe(
    Command.withDescription("Skill-graph queries: search, stats, usage, pairs, recovery, classify, tag, lint, weighted, by-role, roles"),
    Command.withSubcommands([
        searchCommand,
        statsCommand,
        recentCommand,
        unusedCommand,
        tasteCommand,
        weightedCommand,
        pairsCommand,
        recoveryCommand,
        classifyCommand,
        tagCommand,
        skillsLintCommand,
        byRoleCommand,
        rolesForSkillCommand,
        ...skillsConfigSubcommands,
    ]),
);

// P3.7: ax roles (top-level)
export const rolesCommand = Command.make(
    "roles",
    { json: jsonFlag },
    ({ json }) => cmdRoles({ json }),
).pipe(
    Command.withDescription(
        "List all roles with skill counts (includes roles with 0 skills). " +
        "Role labels are semantic categories (framing, execution, verification...) tagged on skills via plays_role edges. " +
        "--json",
    ),
);

export const skillsRuntime: RuntimeManifest = {
    skills: "db",
    roles: "db",
};
