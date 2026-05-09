#!/usr/bin/env bun
import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { AppLayer } from "../lib/layers.ts";
import { ingestSkills } from "../ingest/skills.ts";
import { ingestCommands } from "../ingest/commands.ts";
import { ingestTranscripts } from "../ingest/transcripts.ts";
import { ingestCodex } from "../ingest/codex.ts";
import { ingestGit } from "../ingest/git.ts";
import { ingestClaudeInsights } from "../ingest/claude-insights.ts";
import { deriveSignals } from "../ingest/derive-signals.ts";
import { insightSqlForView, isInsightView } from "../queries/insights.ts";
import { cmdInstall, cmdUninstall } from "./install.ts";
import { cmdProject } from "./project.ts";

const HELP = `agentctl - agent telemetry & taste graph

Usage:
  agentctl ingest [filters] [--since=DAYS]
  agentctl ingest-insights
  agentctl derive-signals [--since=DAYS]
  agentctl insights [repositories|friction|tools|sessions] [--limit=N]
  agentctl search <query> [--limit=N]
  agentctl stats <skill>
  agentctl recent [--limit=N]
  agentctl unused [--days=N]
  agentctl taste [--limit=N]
  agentctl pairs <skill> [--limit=N]
  agentctl recovery [--limit=N]
  agentctl project context [--json]
  agentctl project verify [--json]
  agentctl tui
  agentctl install            # one-shot setup: daemon + watcher + symlink
  agentctl uninstall
  agentctl help

Ingest filters (suppress everything else; combine to narrow further):
  --skills-only        only re-scan SKILL.md files
  --transcripts-only   only ingest Claude transcripts
  --codex-only         only ingest Codex sessions
  --git-only           only ingest git history
  --claude-only        only Claude side: skills + transcripts (no Codex/git)
`;

function flag(name: string, args: string[]): string | undefined {
    const found = args.find((a) => a.startsWith(`--${name}=`));
    return found?.split("=")[1];
}

/**
 * Parse a positive-integer CLI flag. Rejects NaN, ≤0 and (when a default is
 * not provided) absent values. Exits 2 with a clear message instead of letting
 * the bad value reach the SQL layer (which leaks bunfs source paths in errors -
 * see issues #38, #45).
 */
function parsePositiveIntFlag(
    cmd: string,
    flagName: string,
    args: string[],
    fallback?: number,
): number {
    const raw = flag(flagName, args);
    if (raw === undefined) {
        if (fallback !== undefined) return fallback;
        console.error(
            `agentctl ${cmd}: --${flagName} is required (must be a positive integer)`,
        );
        process.exit(2);
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
        console.error(
            `agentctl ${cmd}: --${flagName} must be a positive integer (got "${raw}")`,
        );
        process.exit(2);
    }
    return n;
}

/**
 * Optional positive-integer flag (for `--since`-style values that may be
 * omitted entirely). Returns undefined when not present; errors on garbage.
 */
function parseOptionalPositiveIntFlag(
    cmd: string,
    flagName: string,
    args: string[],
): number | undefined {
    const raw = flag(flagName, args);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
        console.error(
            `agentctl ${cmd}: --${flagName} must be a positive integer (got "${raw}")`,
        );
        process.exit(2);
    }
    return n;
}

/**
 * Cheap human-friendly project label from either a Claude-style cwd-slug like
 * `-Users-necmttn-Projects-quera` or a real path like `/Users/necmttn/quera`.
 * Falls back to the raw value when nothing else produces something useful.
 */
function prettifyProjectSlug(raw: unknown): string {
    if (raw == null) return "?";
    const s = String(raw);
    if (!s) return "?";
    // Real filesystem path: just take the last segment.
    if (s.includes("/")) {
        const parts = s.split("/").filter((p) => p.length > 0);
        if (parts.length > 0) return parts[parts.length - 1];
    }
    // Claude slug form: leading dash, segments joined by dashes.
    const trimmed = s.startsWith("-") ? s.slice(1) : s;
    const parts = trimmed.split("-").filter((p) => p.length > 0);
    return parts.length > 0 ? parts[parts.length - 1] : s;
}

/**
 * Format a numeric counter with thousand-separators (issue #46). Keeps short
 * values short; long ones become e.g. `597,508` rather than blowing the
 * column.
 */
function fmtCount(v: unknown): string {
    const n = Number(v ?? 0);
    if (!Number.isFinite(n)) return "0";
    return n.toLocaleString("en-US");
}

const cmdIngest = (args: string[]) =>
    Effect.gen(function* () {
        const skillsOnly = args.includes("--skills-only");
        const transcriptsOnly = args.includes("--transcripts-only");
        const claudeOnly = args.includes("--claude-only");
        const codexOnly = args.includes("--codex-only");
        const gitOnly = args.includes("--git-only");
        // Issue #44: silent contradictions like `--codex-only --claude-only`
        // turn the command into a no-op. Bail loudly instead.
        const onlyFlags = [
            ["--skills-only", skillsOnly],
            ["--transcripts-only", transcriptsOnly],
            ["--claude-only", claudeOnly],
            ["--codex-only", codexOnly],
            ["--git-only", gitOnly],
        ] as const;
        const setOnly = onlyFlags.filter(([, v]) => v).map(([k]) => k);
        if (setOnly.length > 1) {
            console.error(
                `agentctl ingest: ${setOnly.join(", ")} are mutually exclusive (each is a complete-source filter)`,
            );
            process.exit(2);
        }
        const sinceDays = parseOptionalPositiveIntFlag("ingest", "since", args);
        // Issue #44: --claude-only is the *Claude* side of the world, which
        // includes both `~/.claude/skills` and `~/.claude/projects`
        // transcripts. Codex + git stay suppressed.
        // Each `--X-only` flag suppresses every step except the matching one
        // (and, for `--claude-only`, the matching pair: skills + transcripts).
        // The mutual-exclusion check above guarantees at most one is set, so
        // these conditions just enumerate "is some other --only filter on".
        if (!transcriptsOnly && !codexOnly && !gitOnly) {
            yield* ingestSkills();
            // Slash commands live in `~/.claude/commands/` (and plugin
            // command dirs) and aren't indexed by ingestSkills. Without
            // this, every Skill-tool call against a slash command becomes
            // an orphan `invoked` edge. See issues #41 / #42.
            yield* ingestCommands();
        }
        if (!skillsOnly && !codexOnly && !gitOnly)
            yield* ingestTranscripts({ sinceDays });
        if (!skillsOnly && !transcriptsOnly && !claudeOnly && !gitOnly)
            yield* ingestCodex({ sinceDays });
        if (!skillsOnly && !transcriptsOnly && !codexOnly && !claudeOnly)
            yield* ingestGit({ sinceDays });
        // Auto-derive signals so taste queries always see fresh
        // corrected_by / proposed edges. Cheap: O(turns) in-memory walk.
        // Skip when only running git ingest - signals don't depend on commits.
        if (!skillsOnly && !gitOnly) yield* deriveSignals({ sinceDays });
    });

const cmdDeriveSignals = (args: string[]) =>
    Effect.gen(function* () {
        const sinceDays = parseOptionalPositiveIntFlag(
            "derive-signals",
            "since",
            args,
        );
        yield* deriveSignals({ sinceDays });
    });

const cmdIngestInsights = () => ingestClaudeInsights().pipe(Effect.asVoid);

const cmdInsights = (args: string[]) =>
    Effect.gen(function* () {
        const rawView =
            args.filter((a) => !a.startsWith("--"))[0] ?? "repositories";
        if (!isInsightView(rawView)) {
            console.error(
                `agentctl insights: unknown view "${rawView}" (expected repositories, friction, tools, or sessions)`,
            );
            process.exit(2);
        }
        const limit = parsePositiveIntFlag("insights", "limit", args, 20);
        const db = yield* SurrealClient;
        const result = yield* db.query<[Array<Record<string, unknown>>]>(
            insightSqlForView(rawView, limit),
        );
        console.log(JSON.stringify(result?.[0] ?? [], null, 2));
    });

const cmdSearch = (args: string[]) =>
    Effect.gen(function* () {
        const query = args
            .filter((a) => !a.startsWith("--"))
            .join(" ");
        const limit = parsePositiveIntFlag("search", "limit", args, 10);
        if (!query) {
            console.error("agentctl search: missing query");
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

const cmdStats = (args: string[]) =>
    Effect.gen(function* () {
        const name = args.filter((a) => !a.startsWith("--"))[0];
        if (!name) {
            console.error("agentctl stats: missing skill name");
            process.exit(1);
        }
        const db = yield* SurrealClient;
        const exists = yield* skillExists(name);
        if (!exists) {
            const hint = name.length > 20 ? name.slice(0, 20) : name;
            console.error(
                `agentctl: no skill named "${name}". try: agentctl search "${hint}"`,
            );
            process.exit(2);
        }
        // Issue #43: order recent_sessions by ts DESC (verified server-side),
        // include the session id so we can de-dup in TS, and capture cwd so
        // we can render a human-friendly project label rather than the raw
        // Claude slug.
        const sql = `
LET $s = (SELECT * FROM skill WHERE name = $name)[0];
RETURN {
    skill: $s,
    invocations: {
        total: array::len((SELECT * FROM invoked WHERE out = $s.id)),
        d7:    array::len((SELECT * FROM invoked WHERE out = $s.id AND ts > time::now() - 7d)),
        d30:   array::len((SELECT * FROM invoked WHERE out = $s.id AND ts > time::now() - 30d)),
        d90:   array::len((SELECT * FROM invoked WHERE out = $s.id AND ts > time::now() - 90d)),
        last:  (SELECT ts FROM invoked WHERE out = $s.id ORDER BY ts DESC LIMIT 1)[0].ts,
    },
    recent_sessions: (
        SELECT
            in.session AS session_id,
            in.session.project AS project_slug,
            in.session.cwd AS cwd,
            ts
        FROM invoked
        WHERE out = $s.id
        ORDER BY ts DESC
        LIMIT 50
    )
};`;
        const result = yield* db.query<unknown[]>(sql, { name });
        const payload = (Array.isArray(result)
            ? [...result].reverse().find((r) => r != null)
            : result) as
            | {
                  skill?: { dir_path?: string | null } | null;
                  recent_sessions?: Array<Record<string, unknown>>;
              }
            | undefined;

        // Dedupe + cap to the most recent 5 distinct sessions, then prettify.
        if (payload?.recent_sessions) {
            const seen = new Set<string>();
            const clean: Array<{
                project: string;
                ts: unknown;
            }> = [];
            for (const row of payload.recent_sessions) {
                const sid = String(row.session_id ?? "");
                if (sid && seen.has(sid)) continue;
                if (sid) seen.add(sid);
                // cwd may come back as an array (per-edge projection) - take
                // the first scalar for display purposes.
                const cwdRaw = Array.isArray(row.cwd) ? row.cwd[0] : row.cwd;
                const slugRaw = Array.isArray(row.project_slug)
                    ? row.project_slug[0]
                    : row.project_slug;
                let project: string;
                if (typeof cwdRaw === "string" && cwdRaw.length > 0) {
                    // Mirrors path.basename without pulling node:path here.
                    const parts = cwdRaw.split("/").filter((p) => p.length > 0);
                    project = parts.length > 0 ? parts[parts.length - 1] : cwdRaw;
                } else {
                    project = prettifyProjectSlug(slugRaw);
                }
                clean.push({ project, ts: row.ts });
                if (clean.length >= 5) break;
            }
            (payload as Record<string, unknown>).recent_sessions = clean;
        }

        // Read body lazily from disk via dir_path (DB no longer stores body -
        // multi-file skills + cache-staleness make on-disk the canonical source).
        const dirPath = payload?.skill?.dir_path;
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
            const body = yield* Effect.promise(async () => {
                try {
                    const { readFile } = await import("node:fs/promises");
                    const { join } = await import("node:path");
                    return await readFile(join(dirPath, "SKILL.md"), "utf8");
                } catch {
                    return null;
                }
            });
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
        console.log(JSON.stringify(payload, null, 2));
    });

const cmdRecent = (args: string[]) =>
    Effect.gen(function* () {
        const limit = parsePositiveIntFlag("recent", "limit", args, 20);
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

const cmdUnused = (args: string[]) =>
    Effect.gen(function* () {
        const days = parsePositiveIntFlag("unused", "days", args, 7);
        const db = yield* SurrealClient;
        // PERF (issue #31): Previous form ran a correlated subquery per skill
        // (`SELECT count() FROM invoked WHERE out = $parent.id AND ts > N`).
        // On the largest skill (~500k invoked edges) the index walk took
        // ~1.5s × 137 skills = enough to make this multi-minute.
        //
        // Now we (a) compute the recent-active set in one full-scan
        // GROUP BY over `invoked`, (b) compute total_inv + last_used in
        // bulk, (c) anti-join in TS. Net round-trip: ~2 cheap queries.
        const recentSql = `
SELECT out AS skill_id, count() AS recent
FROM invoked
WHERE ts > time::now() - ${days}d
GROUP BY out;`;
        // Issue #34: `out.name AS name` over a GROUP BY scan returns the
        // per-edge name array (e.g. ~500k entries for codex:exec_command).
        // String() of that is a 17 MB single line. Aggregate over the edge
        // table only, then look up the skill row by id in a separate cheap
        // query and merge in TS.
        const summarySql = `
SELECT
    out AS skill_id,
    count() AS total_inv,
    math::max(ts) AS last_used
FROM invoked
GROUP BY out;`;
        const skillSql = `SELECT id, name, scope FROM skill;`;
        // Skills with literally zero invocations don't show up in the
        // GROUP BY scan; pull them straight from the skill table so the
        // "never used" rows still appear.
        const noInvSql = `
SELECT name, scope FROM skill WHERE array::len(<-invoked) = 0;`;
        const [recentRes, summaryRes, skillRes, noInvRes] = yield* Effect.all(
            [
                db.query<[Array<Record<string, unknown>>]>(recentSql),
                db.query<[Array<Record<string, unknown>>]>(summarySql),
                db.query<[Array<Record<string, unknown>>]>(skillSql),
                db.query<[Array<Record<string, unknown>>]>(noInvSql),
            ],
            { concurrency: 4 },
        );
        const recent = new Set<string>(
            (recentRes?.[0] ?? []).map((r) => String(r.skill_id ?? "")),
        );
        const skillById = new Map<
            string,
            { name: string; scope: string }
        >();
        for (const s of (skillRes?.[0] ?? []) as Array<Record<string, unknown>>) {
            skillById.set(String(s.id ?? ""), {
                name: String(s.name ?? ""),
                scope: String(s.scope ?? ""),
            });
        }
        const summary = (summaryRes?.[0] ?? []) as Array<Record<string, unknown>>;
        const fmtTs = (v: unknown): string => {
            if (v == null) return "never";
            // SurrealDB's math::max returns -Infinity for empty groups; surface
            // it as "never" rather than the literal "-Infinity" string.
            if (typeof v === "number" && !Number.isFinite(v)) return "never";
            if (typeof v === "string") return v;
            if (v instanceof Date) return v.toISOString();
            return String(v);
        };
        const unused: Array<{
            name: string;
            scope: string;
            total_inv: number;
            last_used: string;
        }> = [];
        for (const r of summary) {
            const id = String(r.skill_id ?? "");
            if (recent.has(id)) continue;
            const meta = skillById.get(id);
            // Drop orphan invocations whose target skill never had a row
            // UPSERTed (matches the original FROM-skill behaviour, which
            // started from skill rows and naturally excluded these).
            if (!meta || !meta.name) continue;
            unused.push({
                name: meta.name,
                scope: meta.scope,
                total_inv: Number(r.total_inv ?? 0),
                last_used: fmtTs(r.last_used),
            });
        }
        for (const r of (noInvRes?.[0] ?? []) as Array<Record<string, unknown>>) {
            unused.push({
                name: String(r.name ?? ""),
                scope: String(r.scope ?? ""),
                total_inv: 0,
                last_used: "never",
            });
        }
        unused.sort(
            (a, b) =>
                a.total_inv - b.total_inv || a.name.localeCompare(b.name),
        );
        for (const r of unused) {
            console.log(
                `${r.name}  [${r.scope}]  total=${fmtCount(r.total_inv)}  last=${r.last_used}`,
            );
        }
        console.log(`\n${unused.length} skills unused in last ${days} days.`);
    });

const cmdTaste = (args: string[]) =>
    Effect.gen(function* () {
        const limit = parsePositiveIntFlag("taste", "limit", args, 30);
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
    WHERE skill_id.name IS NOT NONE
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
WHERE array::len(<-invoked) = 0 AND array::len(<-proposed) > 0;`;

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
WHERE array::len(<-invoked) = 0 AND array::len(<-proposed) = 0;`;

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

const cmdPairs = (args: string[]) =>
    Effect.gen(function* () {
        const name = args.filter((a) => !a.startsWith("--"))[0];
        if (!name) {
            console.error("agentctl pairs: missing skill name");
            process.exit(1);
        }
        const limit = parsePositiveIntFlag("pairs", "limit", args, 20);
        const db = yield* SurrealClient;
        const exists = yield* skillExists(name);
        if (!exists) {
            const hint = name.length > 20 ? name.slice(0, 20) : name;
            console.error(
                `agentctl: no skill named "${name}". try: agentctl search "${hint}"`,
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

const cmdRecovery = (args: string[]) =>
    Effect.gen(function* () {
        const limit = parsePositiveIntFlag("recovery", "limit", args, 20);
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

const dispatch = (
    cmd: string | undefined,
    rest: string[],
): Effect.Effect<void, unknown, SurrealClient> | null => {
    switch (cmd) {
        case "ingest":
            return cmdIngest(rest);
        case "derive-signals":
            return cmdDeriveSignals(rest);
        case "ingest-insights":
            return cmdIngestInsights();
        case "insights":
            return cmdInsights(rest);
        case "search":
            return cmdSearch(rest);
        case "stats":
            return cmdStats(rest);
        case "recent":
            return cmdRecent(rest);
        case "unused":
            return cmdUnused(rest);
        case "taste":
            return cmdTaste(rest);
        case "pairs":
            return cmdPairs(rest);
        case "recovery":
            return cmdRecovery(rest);
        case "project":
            return cmdProject(rest);
        default:
            return null;
    }
};

async function main() {
    const [, , cmd, ...rest] = process.argv;
    if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
        console.log(HELP);
        return;
    }
    if (cmd === "tui") {
        // TUI manages its own AppLayer scope so the SurrealDB connection
        // outlives the React tree. Dynamic import keeps React/opentui out
        // of the load path for non-TUI commands.
        const { runTui } = await import("../tui/index.tsx");
        await runTui();
        return;
    }
    if (cmd === "install") {
        await cmdInstall();
        return;
    }
    if (cmd === "uninstall") {
        await cmdUninstall();
        return;
    }
    const program = dispatch(cmd, rest);
    if (program === null) {
        console.error(`agentctl: unknown command "${cmd}"`);
        console.error(HELP);
        process.exit(1);
    }
    await Effect.runPromise(
        program.pipe(Effect.provide(AppLayer), Effect.scoped) as Effect.Effect<void>,
    );
}

main().catch((err) => {
    console.error("agentctl error:", err);
    process.exit(1);
});
