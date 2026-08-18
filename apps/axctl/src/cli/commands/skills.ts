// Extracted from cli/index.ts (Phase 2 CLI split)
import { Effect, FileSystem, Path, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { cacheFirst, cacheRows } from "@ax/lib/duckdb/query";
import { NumberFromBigIntColumn } from "@ax/lib/duckdb/columns";
import { prettyPrint } from "@ax/lib/json";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { prettifyProjectSlug } from "@ax/lib/shared/project-slug";
import {
    fetchSkillsWeighted,
    normalizeSkillsWeightedParams,
} from "../../dashboard/skills-weighted.ts";
import {
    fetchSkillsByRole,
    fetchRolesForSkill,
    fetchAllRoles,
    normalizeSkillsByRoleParams,
} from "../../dashboard/role-queries.ts";
import { loadAgentScopeMap } from "../../ingest/agent-scope.ts";
import {
    buildSkillsWeightedNext,
    buildSkillsByRoleNext,
    buildSkillsRolesNext,
    buildRolesNext,
} from "../../nav/next-links.ts";
import { fetchSkillBloat } from "../../queries/skill-bloat.ts";
import { fetchSkillLoaded } from "../../queries/skill-loaded.ts";
import { fetchSkillStats } from "../../queries/skill-stats.ts";
import { fetchUnusedSkills, formatLastUsed } from "../../queries/unused-skills.ts";
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
    fail,
    fmtCount,
    jsonFlag,
    optionValue,
    parseOptionalPositiveDayWindow,
    positiveLimit,
    requirePositiveInt,
} from "./shared.ts";

interface SearchInput {
    readonly query: string;
    readonly limit: number;
}

const SearchMatchRow = Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    scope: Schema.String,
    description: Schema.NullOr(Schema.String),
    score: Schema.Number,
});
const SearchAggRow = Schema.Struct({
    skill_id: Schema.String,
    total_inv: NumberFromBigIntColumn,
    inv_30d: NumberFromBigIntColumn,
    last_used: Schema.NullOr(Schema.DateValid),
});

export const cmdSearch = (input: SearchInput) =>
    Effect.gen(function* () {
        const query = input.query;
        const limit = requirePositiveInt("search", "limit", input.limit);
        // Keep the empty-query guard: the variadic <query> argument has
        // min 1, but a quoted empty string ("") can still arrive.
        if (!query) {
            console.error("axctl skills search: missing query");
            process.exit(1);
        }
        // DuckDB carries no FTS index over `skill` (only turn/commit text get
        // one), so this is a case-insensitive substring match - not a
        // downgrade: it mirrors the same fallback behavior a missing/cold FTS
        // index already produced before this port.
        const lowerQuery = query.toLowerCase();
        const matched = yield* cacheRows(SearchMatchRow, {
            sql: `
SELECT id, name, scope, description,
       CAST((CASE WHEN lower(name) LIKE '%' || ? || '%' THEN 2.0 ELSE 0.0 END
        + CASE WHEN lower(coalesce(description, '')) LIKE '%' || ? || '%' THEN 1.0 ELSE 0.0 END) AS DOUBLE) AS score
FROM skill
WHERE lower(name) LIKE '%' || ? || '%' OR lower(coalesce(description, '')) LIKE '%' || ? || '%'
ORDER BY score DESC
LIMIT ?`,
            params: [lowerQuery, lowerQuery, lowerQuery, lowerQuery, limit],
        }, "skills search matches");
        // Per-skill aggregates over `invoked` in one full scan - cheap
        // relative to repeating a per-skill subquery for every matched row.
        const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);
        const aggRows = yield* cacheRows(SearchAggRow, {
            sql: `
SELECT out_id AS skill_id, count(*) AS total_inv,
       count(*) FILTER (WHERE ts > ?) AS inv_30d,
       max(ts) AS last_used
FROM invoked
GROUP BY out_id`,
            params: [thirtyDaysAgo],
        }, "skills search aggregates");
        const aggMap = new Map(aggRows.map((a) => [a.skill_id, a] as const));
        const rows = matched
            .map((m) => {
                const agg = aggMap.get(m.id);
                return {
                    name: m.name,
                    scope: m.scope,
                    description: m.description,
                    score: m.score,
                    total_inv: agg ? agg.total_inv : 0,
                    inv_30d: agg ? agg.inv_30d : 0,
                    last_used: agg?.last_used ?? null,
                };
            })
            .sort((a, b) => {
                const ds = b.score - a.score;
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
 * dedicated error instead of an empty-but-success rendering. `null` means
 * no skill has this name.
 */
const SkillIdRow = Schema.Struct({ id: Schema.String });

/** The skill's cache row id, or `null` if no skill has this name. */
const resolveSkillId = (name: string) =>
    cacheFirst(SkillIdRow, { sql: "SELECT id FROM skill WHERE name = ? LIMIT 1", params: [name] }, "skills resolve id");

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
        const payload = yield* fetchSkillStats(name);
        // Issue #40 existence check, folded into the stats fetch: a null
        // `payload.skill` already means "no such skill", so the separate
        // skillExists roundtrip is redundant here.
        if (payload.skill === null) {
            const hint = name.length > 20 ? name.slice(0, 20) : name;
            fail(`axctl: no skill named "${name}". try: axctl skills search "${hint}"`);
        }

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

const RecentInvocationRow = Schema.Struct({
    ts: Schema.DateValid,
    skill: Schema.String,
    project: Schema.NullOr(Schema.String),
});

export const cmdRecent = (input: RecentInput) =>
    Effect.gen(function* () {
        const limit = requirePositiveInt("recent", "limit", input.limit);
        // `invoked.session` is denormalized directly onto the edge (see
        // schema.duckdb.sql), so no extra hop through `turn` is needed to
        // reach `session.project`.
        const rows = yield* cacheRows(RecentInvocationRow, {
            sql: `
SELECT i.ts AS ts, sk.name AS skill, s.project AS project
FROM invoked i
JOIN skill sk ON sk.id = i.out_id
LEFT JOIN session s ON s.id = i.session
ORDER BY i.ts DESC
LIMIT ?`,
            params: [limit],
        }, "skills recent");
        for (const r of rows) {
            console.log(
                `${r.ts.toISOString()}  ${r.skill}  (${prettifyProjectSlug(r.project ?? "")})`,
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
            const last = formatLastUsed(r.last_used);
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

interface SkillsBloatInput {
    readonly budgetTokens: number;
    readonly limit: number;
    readonly json: boolean;
}

const cmdSkillsBloat = (input: SkillsBloatInput) =>
    Effect.gen(function* () {
        const budgetTokens = requirePositiveInt("skills bloat", "budget", input.budgetTokens);
        const limit = requirePositiveInt("skills bloat", "limit", input.limit);
        const { rows, total } = yield* fetchSkillBloat({ budgetTokens, limit });

        if (input.json) {
            console.log(prettyPrint({ budgetTokens, total, skills: rows }));
            return;
        }
        if (rows.length === 0) {
            console.log(
                `No skills over ${fmtCount(budgetTokens)} tokens. ` +
                `(Compact is good - SkillOpt deploys skills at ~300-2,000 tok.)`,
            );
            return;
        }
        for (const r of rows) {
            console.log(
                `${r.name}  ~${fmtCount(r.estTokens)} tok  (+${fmtCount(r.overBy)} over)  ` +
                `${fmtCount(r.bytes)} B  used=${fmtCount(r.invocations)}`,
            );
        }
        // Say what was withheld. Reporting the page size as the total made
        // `--limit` silently change a number the user reads as a fact.
        const shown = rows.length < total ? ` (showing top ${fmtCount(rows.length)})` : "";
        console.log(
            `\n${fmtCount(total)} skill${total === 1 ? "" : "s"} over the ` +
            `${fmtCount(budgetTokens)}-token budget${shown}. ` +
            `Trim toward high-signal; length is not effort.`,
        );
    });

interface SkillsLoadedInput {
    readonly limit: number;
    readonly json: boolean;
}

const cmdSkillsLoaded = (input: SkillsLoadedInput) =>
    Effect.gen(function* () {
        const limit = requirePositiveInt("skills loaded", "limit", input.limit);
        const rows = yield* fetchSkillLoaded({ limit });
        if (input.json) {
            console.log(prettyPrint({ skills: rows }));
            return;
        }
        if (rows.length === 0) {
            console.log(
                "No auto-load activations recorded. (The loaded-skills stage " +
                "stamps these from subagent `skills:` frontmatter at ingest.)",
            );
            return;
        }
        for (const r of rows) {
            console.log(`${r.name}  loaded=${fmtCount(r.activations)}`);
        }
        console.log(
            `\n${rows.length} skill${rows.length === 1 ? "" : "s"} auto-loaded via subagent ` +
            "frontmatter (no Skill-tool call; invisible to invoked-based usage views).",
        );
    });

interface SkillsWeightedInput {
    readonly limit: number;
    readonly windowDays: string | undefined;
    readonly doctorThreshold: number;
    readonly includeTools: boolean;
    readonly json: boolean;
}

const cmdSkillsWeighted = (input: SkillsWeightedInput) =>
    Effect.gen(function* () {
        const limit = requirePositiveInt("skills weighted", "limit", input.limit);
        const windowDays = parseOptionalPositiveDayWindow("skills weighted", "window", input.windowDays);
        const doctorThreshold = requirePositiveInt("skills weighted", "doctor-threshold", input.doctorThreshold);
        const json = input.json;
        const includeTools = input.includeTools;

        // --window=0 is invalid: requireOptionalPositiveInt rejects it (n <= 0)
        // with exit 2, mirroring the old parseOptionalPositiveIntFlag behavior.
        // Validation stays here; defaults/presence come from the shared normalizer.

        const result = yield* fetchSkillsWeighted(
            normalizeSkillsWeightedParams({
                ...(windowDays !== undefined ? { windowDays } : {}),
                limit,
                doctorThreshold,
                includeTools,
            }),
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

        // No `catchDbErrorAndExit`: this vertical's failures are
        // `CacheReadError`/`JudgmentError`, not `DbError`. They bubble to the
        // CLI edge exactly as `ax recall`'s do (the v2 template).
        const result = yield* fetchSkillsByRole(normalizeSkillsByRoleParams({ role, limit }));

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

        const result = yield* fetchRolesForSkill({ skill });

        if (!result.skillExists) {
            fail(`axctl skills roles: unknown skill "${skill}"`);
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

        const result = yield* fetchAllRoles();

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

const TasteSkillRow = Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    scope: Schema.String,
    dir_path: Schema.NullOr(Schema.String),
});
const TasteInvokedAggRow = Schema.Struct({
    skill_id: Schema.String,
    inv_total: NumberFromBigIntColumn,
    inv_7d: NumberFromBigIntColumn,
    inv_30d: NumberFromBigIntColumn,
    clean_inv: NumberFromBigIntColumn,
    corrections: NumberFromBigIntColumn,
});
const TasteProposedAggRow = Schema.Struct({ skill_id: Schema.String, proposals: NumberFromBigIntColumn });
const TasteCommitsAggRow = Schema.Struct({ skill_id: Schema.String, commits_after: NumberFromBigIntColumn });

export const cmdTaste = (input: TasteInput) =>
    Effect.gen(function* () {
        const limit = requirePositiveInt("taste", "limit", input.limit);
        const includeTools = input.includeTools;
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
        // Ported to a catalog-first join over four flat statements, so
        // *every* skill row gets a slot (issue #47) in ONE pass instead of
        // the original three-branch (invoked / proposed-only / zero) union:
        //   (1) the full skill catalog (id/name/scope/dir_path - small table)
        //   (2) per-skill invoked aggregates (inv_total/7d/30d/clean/corrections)
        //   (3) per-skill proposed counts
        //   (4) per-skill commits_after - `produced` rows in the DISTINCT set
        //       of sessions that invoked this skill (a single JOIN + COUNT
        //       DISTINCT, rather than a per-skill correlated subquery)
        // A skill absent from (2)/(3)/(4) defaults to zero in the JS join,
        // which is exactly the proposed-only/zero union the original
        // three-branch query existed to reconstruct.
        const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
        const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);
        const [skillRows, invokedAgg, proposedAgg, commitsAgg] = yield* Effect.all(
            [
                cacheRows(TasteSkillRow, { sql: "SELECT id, name, scope, dir_path FROM skill", params: [] }, "skills taste catalog"),
                cacheRows(TasteInvokedAggRow, {
                    sql: `
SELECT out_id AS skill_id, count(*) AS inv_total,
       count(*) FILTER (WHERE ts > ?) AS inv_7d,
       count(*) FILTER (WHERE ts > ?) AS inv_30d,
       count(*) FILTER (WHERE turn_has_error = false) AS clean_inv,
       count(*) FILTER (WHERE was_corrected = true) AS corrections
FROM invoked
GROUP BY out_id`,
                    params: [sevenDaysAgo, thirtyDaysAgo],
                }, "skills taste invoked aggregates"),
                cacheRows(TasteProposedAggRow, {
                    sql: "SELECT out_id AS skill_id, count(*) AS proposals FROM proposed GROUP BY out_id",
                    params: [],
                }, "skills taste proposed aggregates"),
                cacheRows(TasteCommitsAggRow, {
                    sql: `
SELECT i.out_id AS skill_id, count(DISTINCT p.id) AS commits_after
FROM invoked i JOIN produced p ON p.in_id = i.session
GROUP BY i.out_id`,
                    params: [],
                }, "skills taste commits aggregate"),
            ],
            { concurrency: 4 },
        );
        const invokedById = new Map(invokedAgg.map((r) => [r.skill_id, r] as const));
        const proposedById = new Map(proposedAgg.map((r) => [r.skill_id, r.proposals] as const));
        const commitsById = new Map(commitsAgg.map((r) => [r.skill_id, r.commits_after] as const));
        interface TasteRow {
            readonly name: string;
            readonly scope: string;
            readonly inv_total: number;
            readonly inv_7d: number;
            readonly inv_30d: number;
            readonly clean_inv: number;
            readonly corrections: number;
            readonly proposals: number;
            readonly commits_after: number;
            readonly taste_score: number;
        }
        const merged: TasteRow[] = [];
        for (const s of skillRows) {
            if (!includeTools && s.dir_path === "(synthetic)") continue;
            const inv = invokedById.get(s.id);
            const proposals = proposedById.get(s.id) ?? 0;
            const commitsAfter = commitsById.get(s.id) ?? 0;
            const invTotal = inv?.inv_total ?? 0;
            const corrections = inv?.corrections ?? 0;
            merged.push({
                name: s.name,
                scope: s.scope,
                inv_total: invTotal,
                inv_7d: inv?.inv_7d ?? 0,
                inv_30d: inv?.inv_30d ?? 0,
                clean_inv: inv?.clean_inv ?? 0,
                corrections,
                proposals,
                commits_after: commitsAfter,
                taste_score: invTotal - 2 * corrections + commitsAfter - 0.5 * proposals,
            });
        }
        // Sort to mirror the original ORDER BY taste_score DESC, inv_30d DESC, inv_total DESC.
        merged.sort((a, b) => {
            const ds = b.taste_score - a.taste_score;
            if (ds !== 0) return ds;
            const d30 = b.inv_30d - a.inv_30d;
            if (d30 !== 0) return d30;
            return b.inv_total - a.inv_total;
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
            { key: "score", header: "score", get: (r: TasteRow) => fmtScore(r.taste_score) },
            { key: "7d", header: "7d", get: (r: TasteRow) => fmtCount(r.inv_7d) },
            { key: "30d", header: "30d", get: (r: TasteRow) => fmtCount(r.inv_30d) },
            { key: "total", header: "total", get: (r: TasteRow) => fmtCount(r.inv_total) },
            { key: "clean", header: "clean", get: (r: TasteRow) => fmtCount(r.clean_inv) },
            { key: "corr", header: "corr", get: (r: TasteRow) => fmtCount(r.corrections) },
            { key: "prop", header: "prop", get: (r: TasteRow) => fmtCount(r.proposals) },
            { key: "cmts", header: "cmts", get: (r: TasteRow) => fmtCount(r.commits_after) },
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

const PairedRow = Schema.Struct({
    partner: Schema.String,
    count: NumberFromBigIntColumn,
    last_seen: Schema.DateValid,
});

export const cmdPairs = (input: PairsInput) =>
    Effect.gen(function* () {
        // The old missing-name guard is dead: <skill> is a required
        // Argument.string, so the CLI parser rejects the bare invocation.
        const name = input.name;
        const limit = requirePositiveInt("pairs", "limit", input.limit);
        const skill = yield* resolveSkillId(name);
        if (!skill) {
            const hint = name.length > 20 ? name.slice(0, 20) : name;
            fail(`axctl: no skill named "${name}". try: axctl skills search "${hint}"`);
        }
        // Pairs are stored undirected (lexicographically lo->hi). Look the
        // skill up on either endpoint so callers don't have to know the
        // canonical direction; CASE picks the partner regardless of position.
        const rows = yield* cacheRows(PairedRow, {
            sql: `
SELECT (CASE WHEN sp.in_id = ? THEN so.name ELSE si.name END) AS partner, sp.count, sp.last_seen
FROM skill_paired sp
JOIN skill si ON si.id = sp.in_id
JOIN skill so ON so.id = sp.out_id
WHERE sp.in_id = ? OR sp.out_id = ?
ORDER BY sp.count DESC
LIMIT ?`,
            params: [skill.id, skill.id, skill.id, limit],
        }, "skills pairs");
        if (rows.length === 0) {
            console.log("(no co-occurring skills)");
            return;
        }
        console.log(`${"partner".padEnd(50)}  count  last_seen`);
        for (const r of rows) {
            console.log(
                `${r.partner.padEnd(50)}  ${String(r.count).padStart(5)}  ${r.last_seen.toISOString()}`,
            );
        }
    });

interface RecoveryInput {
    readonly limit: number;
}

const RecoveryRow = Schema.Struct({ skill: Schema.String, hits: NumberFromBigIntColumn });

export const cmdRecovery = (input: RecoveryInput) =>
    Effect.gen(function* () {
        const limit = requirePositiveInt("recovery", "limit", input.limit);
        const rows = yield* cacheRows(RecoveryRow, {
            sql: `
SELECT sk.name AS skill, count(*) AS hits
FROM recovered_by r JOIN skill sk ON sk.id = r.out_id
GROUP BY sk.name
ORDER BY hits DESC
LIMIT ?`,
            params: [limit],
        }, "skills recovery");
        if (rows.length === 0) {
            console.log("(no recovery edges)");
            return;
        }
        console.log(`${"skill".padEnd(50)}  hits`);
        for (const r of rows) {
            console.log(`${r.skill.padEnd(50)}  ${String(r.hits).padStart(4)}`);
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
        }),
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
        ),
).pipe(
    Command.withDescription(
        "Read filled classify briefs from --task-dir (default .ax/tasks) and write plays_role " +
        "edges with source=\"brief\". Removes applied brief files. " +
        "--dry-run  --json  --task-dir=<path>",
    ),
);

const bloatCommand = Command.make(
    "bloat",
    {
        budget: Flag.integer("budget").pipe(Flag.withDefault(2000)),
        limit: positiveLimit(25),
        json: jsonFlag,
    },
    ({ budget, limit, json }) =>
        cmdSkillsBloat({ budgetTokens: budget, limit, json }).pipe(
            catchDbErrorAndExit("axctl skills bloat"),
        ),
).pipe(
    Command.withDescription(
        "List installed skills whose body exceeds a token budget (est ~4 B/token " +
        "from stored bytes). Sorted by size, with all-time invocations so " +
        "bloated-and-used skills surface first. SkillOpt deploys skills at " +
        "~300-2,000 tokens. --budget=N (default 2000)  --limit=N  --json",
    ),
);

const loadedCommand = Command.make(
    "loaded",
    {
        limit: positiveLimit(25),
        json: jsonFlag,
    },
    ({ limit, json }) =>
        cmdSkillsLoaded({ limit, json }).pipe(
            catchDbErrorAndExit("axctl skills loaded"),
        ),
).pipe(
    Command.withDescription(
        "List skills auto-loaded via a subagent's `skills:` frontmatter (activated " +
        "with no Skill-tool call, so absent from invoked-based usage views), ranked " +
        "by activation count. Reads the `loaded` edge. --limit=N  --json",
    ),
);

const weightedCommand = Command.make(
    "weighted",
    {
        window: Flag.string("window").pipe(Flag.optional),
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
    Command.withDescription("Skill-graph queries: search, stats, usage, pairs, recovery, classify, tag, lint, bloat, loaded, weighted, by-role, roles"),
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
        bloatCommand,
        loadedCommand,
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
    skills: {
        kind: "db-conditional",
        fallback: "cache",
        subcommands: {
            search: "cache",
            stats: "cache",
            recent: "cache",
            unused: "cache",
            taste: "cache",
            weighted: "cache",
            pairs: "cache",
            recovery: "cache",
            classify: "cache",
            tag: "cache",
            lint: "cache",
            bloat: "cache",
            loaded: "cache",
            "by-role": "cache",
            roles: "cache",
            config: "none",
            reconcile: "none",
            scope: "none",
            park: "none",
            unpark: "none",
            rm: "none",
        },
    },
    // `ax roles` is PURE JUDGMENT - the role vocabulary and the tag counts both
    // live in the SQLite sidecar - so it needs no published snapshot at all, and
    // answers on a machine that has never run an ingest.
    // roles-daemonless.test.ts spawns the real CLI with a snapshot path that
    // does not exist, which an in-process test cannot check.
    roles: "cache",
};
