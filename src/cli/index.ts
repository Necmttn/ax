#!/usr/bin/env bun
import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { AppLayer } from "../lib/layers.ts";
import { ingestSkills } from "../ingest/skills.ts";
import { ingestTranscripts } from "../ingest/transcripts.ts";
import { ingestCodex } from "../ingest/codex.ts";

const HELP = `agentctl - agent telemetry & taste graph

Usage:
  agentctl ingest [--skills-only|--transcripts-only] [--since=DAYS]
  agentctl search <query> [--limit=N]
  agentctl stats <skill>
  agentctl recent [--limit=N]
  agentctl unused [--days=N]
  agentctl taste [--limit=N]
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
        const sinceArg = flag("since", args);
        const sinceDays = sinceArg ? parseInt(sinceArg, 10) : undefined;
        if (!transcriptsOnly && !codexOnly) yield* ingestSkills();
        if (!skillsOnly && !codexOnly) yield* ingestTranscripts({ sinceDays });
        if (!skillsOnly && !claudeOnly) yield* ingestCodex({ sinceDays });
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
        const sql = `
SELECT
    name,
    scope,
    description,
    (string::lowercase(name) CONTAINS $q) AS name_match,
    (description IS NONE OR string::lowercase(description ?? '') CONTAINS $q) AS desc_match,
    array::len(<-invoked) AS total_inv,
    array::len((SELECT * FROM <-invoked WHERE ts > time::now() - 30d)) AS inv_30d,
    (SELECT ts FROM <-invoked ORDER BY ts DESC LIMIT 1)[0].ts AS last_used
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
        // SurrealDB returns one entry per statement; the LET yields null,
        // the RETURN yields the payload. Pick the last non-null result.
        const payload = (Array.isArray(result)
            ? [...result].reverse().find((r) => r != null)
            : result) as
            | { skill?: { body?: string | null } | null }
            | undefined;
        const body = payload?.skill?.body;
        if (typeof body === "string" && body.length > 0) {
            const excerpt = body.length > 500 ? body.slice(0, 500) + "…" : body;
            console.log("--- body excerpt ---");
            console.log(excerpt);
            console.log("--- end body ---\n");
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
        const sql = `
SELECT
    name,
    scope,
    array::len(<-invoked) AS total_inv,
    (SELECT ts FROM <-invoked ORDER BY ts DESC LIMIT 1)[0].ts AS last_used
FROM skill
WHERE array::len((SELECT * FROM <-invoked WHERE ts > time::now() - ${days}d)) = 0
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
        // Composite signal: invocations (positive), errors near invocation (negative),
        // edits-following-invocation in same session (positive - work happened).
        const sql = `
SELECT
    name,
    scope,
    array::len(<-invoked) AS inv_total,
    array::len((SELECT * FROM <-invoked WHERE ts > time::now() - 7d))  AS inv_7d,
    array::len((SELECT * FROM <-invoked WHERE ts > time::now() - 30d)) AS inv_30d,
    array::len((
        SELECT * FROM <-invoked
        WHERE in.has_error = false
    )) AS clean_inv
FROM skill
WHERE array::len(<-invoked) > 0
ORDER BY inv_30d DESC, clean_inv DESC, inv_total DESC
LIMIT ${limit};`;
        const result = yield* db.query<[Array<Record<string, unknown>>]>(sql);
        const rows = result?.[0];
        console.log(
            `${"skill".padEnd(50)}  ${"scope".padEnd(16)}  7d  30d  total  clean`,
        );
        for (const r of rows ?? []) {
            console.log(
                `${String(r.name).padEnd(50)}  ${String(r.scope).padEnd(16)}  ${String(r.inv_7d).padStart(2)}  ${String(r.inv_30d).padStart(3)}  ${String(r.inv_total).padStart(5)}  ${String(r.clean_inv).padStart(5)}`,
            );
        }
    });

const dispatch = (
    cmd: string | undefined,
    rest: string[],
): Effect.Effect<void, unknown, SurrealClient> | null => {
    switch (cmd) {
        case "ingest":
            return cmdIngest(rest);
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
