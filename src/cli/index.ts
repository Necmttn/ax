#!/usr/bin/env bun
import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { AppLayer } from "../lib/layers.ts";
import { ingestSkills } from "../ingest/skills.ts";
import { ingestTranscripts } from "../ingest/transcripts.ts";
import { ingestCodex } from "../ingest/codex.ts";
import { ingestGit } from "../ingest/git.ts";
import { deriveSignals } from "../ingest/derive-signals.ts";
import { cmdInstall, cmdUninstall } from "./install.ts";

const HELP = `agentctl - agent telemetry & taste graph

Usage:
  agentctl ingest [--skills-only|--transcripts-only|--codex-only|--git-only|--claude-only] [--since=DAYS]
  agentctl derive-signals [--since=DAYS]
  agentctl search <query> [--limit=N]
  agentctl stats <skill>
  agentctl recent [--limit=N]
  agentctl unused [--days=N]
  agentctl taste [--limit=N]
  agentctl pairs <skill> [--limit=N]
  agentctl recovery [--limit=N]
  agentctl tui
  agentctl install            # one-shot setup: daemon + watcher + symlink
  agentctl uninstall
  agentctl help
`;

function flag(name: string, args: string[]): string | undefined {
    const found = args.find((a) => a.startsWith(`--${name}=`));
    return found?.split("=")[1];
}

const cmdIngest = (args: string[]) =>
    Effect.gen(function* () {
        const skillsOnly = args.includes("--skills-only");
        const transcriptsOnly = args.includes("--transcripts-only");
        const claudeOnly = args.includes("--claude-only");
        const codexOnly = args.includes("--codex-only");
        const gitOnly = args.includes("--git-only");
        const sinceArg = flag("since", args);
        const sinceDays = sinceArg ? parseInt(sinceArg, 10) : undefined;
        // Each "--X-only" flag suppresses every step except its own. Combining
        // multiple is effectively "only run nothing", which we treat as a no-op
        // (consistent with how the existing skills/codex flags compose).
        if (!transcriptsOnly && !codexOnly && !gitOnly) yield* ingestSkills();
        if (!skillsOnly && !codexOnly && !gitOnly)
            yield* ingestTranscripts({ sinceDays });
        if (!skillsOnly && !claudeOnly && !gitOnly && !transcriptsOnly)
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
        const sinceArg = flag("since", args);
        const sinceDays = sinceArg ? parseInt(sinceArg, 10) : undefined;
        yield* deriveSignals({ sinceDays });
    });

const cmdSearch = (args: string[]) =>
    Effect.gen(function* () {
        const query = args
            .filter((a) => !a.startsWith("--"))
            .join(" ")
            .toLowerCase();
        const limit = parseInt(flag("limit", args) ?? "10", 10);
        if (!query) {
            console.error("agentctl search: missing query");
            process.exit(1);
        }
        const db = yield* SurrealClient;
        // Lexical contains + recent-use boost
        // NOTE: Time-window counts use explicit `invoked WHERE out = $parent.id`
        // form rather than `<-invoked WHERE ts > ...`. The graph-traversal form
        // materialises the edges first and the WHERE filter then drops every
        // row (returns 0 even when matches exist). See issue #15.
        const sql = `
SELECT
    name,
    scope,
    description,
    (string::lowercase(name) CONTAINS $q) AS name_match,
    (description IS NONE OR string::lowercase(description ?? '') CONTAINS $q) AS desc_match,
    array::len(<-invoked) AS total_inv,
    (SELECT count() FROM invoked WHERE out = $parent.id AND ts > time::now() - 30d GROUP ALL)[0].count ?? 0 AS inv_30d,
    (SELECT ts FROM invoked WHERE out = $parent.id ORDER BY ts DESC LIMIT 1)[0].ts AS last_used
FROM skill
WHERE
    string::lowercase(name) CONTAINS $q
    OR string::lowercase(description ?? '') CONTAINS $q
ORDER BY name_match DESC, inv_30d DESC, total_inv DESC
LIMIT ${limit};`;
        const result = yield* db.query<[Array<Record<string, unknown>>]>(sql, { q: query });
        const rows = result?.[0];
        if (!rows || rows.length === 0) {
            console.log("(no matches)");
            return;
        }
        for (const r of rows) {
            const usage = `${r.inv_30d ?? 0}×30d / ${r.total_inv ?? 0}×total`;
            const desc = (r.description as string | null) ?? "";
            const truncDesc = desc.length > 100 ? desc.slice(0, 97) + "…" : desc;
            console.log(`${r.name}  [${r.scope}]  ${usage}`);
            if (truncDesc) console.log(`  ${truncDesc}`);
        }
    });

const cmdStats = (args: string[]) =>
    Effect.gen(function* () {
        const name = args.filter((a) => !a.startsWith("--"))[0];
        if (!name) {
            console.error("agentctl stats: missing skill name");
            process.exit(1);
        }
        const db = yield* SurrealClient;
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
        SELECT in.session.project AS project, in.ts AS ts
        FROM invoked
        WHERE out = $s.id
        ORDER BY ts DESC
        LIMIT 5
    )
};`;
        const result = yield* db.query<unknown[]>(sql, { name });
        const payload = (Array.isArray(result)
            ? [...result].reverse().find((r) => r != null)
            : result) as
            | { skill?: { dir_path?: string | null } | null }
            | undefined;
        // Read body lazily from disk via dir_path (DB no longer stores body -
        // multi-file skills + cache-staleness make on-disk the canonical source).
        const dirPath = payload?.skill?.dir_path;
        if (typeof dirPath === "string" && dirPath.length > 0) {
            try {
                const { readFile } = yield* Effect.promise(() => import("node:fs/promises"));
                const { join } = yield* Effect.promise(() => import("node:path"));
                const content = yield* Effect.promise(() =>
                    readFile(join(dirPath, "SKILL.md"), "utf8"),
                );
                const m = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
                const body = (m?.[1] ?? content).trim();
                if (body.length > 0) {
                    const excerpt = body.length > 500 ? body.slice(0, 500) + "…" : body;
                    console.log("--- body excerpt ---");
                    console.log(excerpt);
                    console.log("--- end body ---\n");
                }
            } catch {
                // Skill file unreadable - fall through to JSON dump only.
            }
        }
        console.log(JSON.stringify(payload, null, 2));
    });

const cmdRecent = (args: string[]) =>
    Effect.gen(function* () {
        const limit = parseInt(flag("limit", args) ?? "20", 10);
        const db = yield* SurrealClient;
        const sql = `
SELECT ts, out.name AS skill, in.session.project AS project
FROM invoked
ORDER BY ts DESC
LIMIT ${limit};`;
        const result = yield* db.query<[Array<Record<string, unknown>>]>(sql);
        const rows = result?.[0];
        for (const r of rows ?? []) {
            console.log(`${r.ts}  ${r.skill}  (${r.project ?? "?"})`);
        }
    });

const cmdUnused = (args: string[]) =>
    Effect.gen(function* () {
        const days = parseInt(flag("days", args) ?? "7", 10);
        const db = yield* SurrealClient;
        // See issue #15: `<-invoked WHERE ts > ...` materialises edges first
        // then the WHERE drops everything, so the count is always 0. Use the
        // explicit `invoked WHERE out = $parent.id` form instead.
        const sql = `
SELECT
    name,
    scope,
    array::len(<-invoked) AS total_inv,
    (SELECT ts FROM invoked WHERE out = $parent.id ORDER BY ts DESC LIMIT 1)[0].ts AS last_used
FROM skill
WHERE ((SELECT count() FROM invoked WHERE out = $parent.id AND ts > time::now() - ${days}d GROUP ALL)[0].count ?? 0) = 0
ORDER BY total_inv ASC, name ASC;`;
        const result = yield* db.query<[Array<Record<string, unknown>>]>(sql);
        const rows = result?.[0];
        for (const r of rows ?? []) {
            console.log(
                `${r.name}  [${r.scope}]  total=${r.total_inv ?? 0}  last=${r.last_used ?? "never"}`,
            );
        }
        console.log(`\n${rows?.length ?? 0} skills unused in last ${days} days.`);
    });

const cmdTaste = (args: string[]) =>
    Effect.gen(function* () {
        const limit = parseInt(flag("limit", args) ?? "30", 10);
        const db = yield* SurrealClient;
        // Composite signal: invocations (positive), errors near invocation
        // (negative), corrections within 3 turns of invocation in the same
        // session (negative - user pushed back), and proposed-but-not-invoked
        // (signal of mismatch between assistant suggestions and tool firing).
        //
        // `corrections` counts invocations where the next user turn within 3
        // seq steps in the same session triggered a corrected_by edge.
        // `proposals` counts proposed edges into this skill.
        // NOTE: Filtered counts use explicit `invoked WHERE out = $parent.id`
        // form rather than `<-invoked WHERE ...`. The graph-traversal form
        // materialises the edges first and the WHERE filter then drops every
        // row (returns 0 even when matches exist). See issue #15.
        const sql = `
SELECT
    name,
    scope,
    array::len(<-invoked) AS inv_total,
    (SELECT count() FROM invoked WHERE out = $parent.id AND ts > time::now() - 7d  GROUP ALL)[0].count ?? 0 AS inv_7d,
    (SELECT count() FROM invoked WHERE out = $parent.id AND ts > time::now() - 30d GROUP ALL)[0].count ?? 0 AS inv_30d,
    (SELECT count() FROM invoked WHERE out = $parent.id AND in.has_error = false GROUP ALL)[0].count ?? 0 AS clean_inv,
    array::len((
        SELECT * FROM invoked
        WHERE out = $parent.id
          AND array::len((
            SELECT * FROM corrected_by
            WHERE in.session = $parent.in.session
              AND in.seq >= $parent.in.seq
              AND in.seq <= $parent.in.seq + 3
        )) > 0
    )) AS corrections,
    array::len(<-proposed) AS proposals
FROM skill
WHERE array::len(<-invoked) > 0 OR array::len(<-proposed) > 0
ORDER BY inv_30d DESC, clean_inv DESC, inv_total DESC
LIMIT ${limit};`;
        const result = yield* db.query<[Array<Record<string, unknown>>]>(sql);
        const rows = result?.[0];
        console.log(
            `${"skill".padEnd(50)}  ${"scope".padEnd(16)}  7d  30d  total  clean  corr  prop`,
        );
        for (const r of rows ?? []) {
            console.log(
                `${String(r.name).padEnd(50)}  ${String(r.scope).padEnd(16)}  ${String(r.inv_7d).padStart(2)}  ${String(r.inv_30d).padStart(3)}  ${String(r.inv_total).padStart(5)}  ${String(r.clean_inv).padStart(5)}  ${String(r.corrections ?? 0).padStart(4)}  ${String(r.proposals ?? 0).padStart(4)}`,
            );
        }
    });

const cmdPairs = (args: string[]) =>
    Effect.gen(function* () {
        const name = args.filter((a) => !a.startsWith("--"))[0];
        if (!name) {
            console.error("agentctl pairs: missing skill name");
            process.exit(1);
        }
        const limit = parseInt(flag("limit", args) ?? "20", 10);
        const db = yield* SurrealClient;
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
        const limit = parseInt(flag("limit", args) ?? "20", 10);
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
