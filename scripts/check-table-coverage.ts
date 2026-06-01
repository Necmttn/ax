#!/usr/bin/env bun
/**
 * Table coverage CI gate (Phase D, plan
 * docs/superpowers/plans/2026-05-25-experiment-loop-cleanup-and-rebuild.md).
 *
 * Root-cause fix for write-only orphan tables that land schema + writer + CLI
 * stub without a real reader. Hard CI fail.
 *
 * Rule: every table that has an `UPSERT <table>` / `CREATE <table>` /
 * `INSERT INTO <table>` / `RELATE ...-><table>` site under src/ingest/
 * (writers) MUST also have at least one `SELECT ... FROM <table>` /
 * `FROM <table>` site under src/cli/, src/dashboard/, src/queries/, or
 * src/improve/ (readers).
 *
 * Tables listed in GRANDFATHER below are tolerated without a reader. The
 * list must only shrink - adding a table to it requires a comment with the
 * justification + an issue ref. The CI flag --strict-grandfather also
 * fails on any *new* grandfather entry vs the committed snapshot, but
 * that's a follow-up; today we just block fresh writer-no-reader pairs.
 */

import { spawnSync } from "node:child_process";

interface SearchHit {
    readonly file: string;
    readonly line: number;
    readonly text: string;
}

const SRC_DIR = "apps/axctl/src";
// CLI handlers MUST be in WRITER_GLOBS too. `axctl improve accept` writes the
// `experiment` table from src/cli/index.ts; without this glob the gate misses
// it. Original (Phase D) commit shipped without this and reviewer demonstrated
// a synthetic CLI-resident writer slipping past green.
const WRITER_GLOBS = ["apps/axctl/src/ingest", "apps/axctl/src/improve", "apps/axctl/src/dogfood", "apps/axctl/src/project", "apps/axctl/src/hooks", "apps/axctl/src/cli"];
const READER_GLOBS = ["apps/axctl/src/cli", "apps/axctl/src/dashboard", "apps/axctl/src/queries", "apps/axctl/src/improve", "apps/axctl/src/ingest"];

/**
 * Tables that legitimately have no reader yet. ONLY shrink this list.
 * Add a comment with the reason and an issue/plan ref before adding.
 */
// Tables listed here are tolerated without a `FROM <table>` reader. Add
// entries only with a justification comment AND a follow-up plan to remove.
const GRANDFATHER: ReadonlySet<string> = new Set([
    // Phase B: kept as evidence input for the new proposal pipeline.
    // Reader lands when derive-proposals starts ranking per stack (post-C1).
    "stack",

    // Guidance sources/revisions are ingest-only evidence; downstream
    // surface (axctl guidance show + dashboard /guidance) is planned.
    // Tracked in 2026-05-15-graph-explorer-delivery-telemetry.md.
    "guidance_source",
    "guidance_revision",

    // Workflow epochs - coarse session-bucketing labels; consumed only by
    // session-health derivations today. Direct CLI surface deferred.
    "workflow_epoch",

    // Telemetry/observability tables: written by every ingest run, dumped
    // ad-hoc for debugging via `surreal sql`. Surfacing in CLI/dashboard
    // is a separate task.
    "ingest_run",
    "ingest_stage",
    "ingest_event",
    "query_sample",
    "graph_health_check",
    "tool",
    "plan",
    "plan_item",

    // Core graph tables read via record-link fetch (e.g.
    // `SELECT tool.name FROM tool_call`) rather than `FROM tool`. The
    // dotted-fetch syntax isn't detected by the regex - adding it would
    // false-positive on every property access. Live readers exist:
    //   - tool       → src/ingest/derive-signals.ts (tool.name AS tool_name)
    //   - plan       → joined via plan_snapshot.plan record link
    //   - plan_item  → joined via plan_item.plan back-link
]);

const rgJson = (pattern: string, paths: readonly string[]): SearchHit[] => {
    const args = ["--json", "-n", "--no-heading", "-e", pattern, "--", ...paths];
    const proc = spawnSync("rg", args, { encoding: "utf8" });
    if (proc.status !== 0 && proc.status !== 1) {
        process.stderr.write(`rg failed (${proc.status}): ${proc.stderr}\n`);
        process.exit(2);
    }
    const out: SearchHit[] = [];
    for (const line of (proc.stdout ?? "").split("\n")) {
        if (line.length === 0) continue;
        try {
            const ev = JSON.parse(line) as { type: string; data?: { path?: { text: string }; line_number?: number; lines?: { text: string } } };
            if (ev.type !== "match") continue;
            const file = ev.data?.path?.text ?? "";
            const ln = ev.data?.line_number ?? 0;
            const text = (ev.data?.lines?.text ?? "").trim();
            if (file.endsWith(".test.ts")) continue;
            // Skip doc/code comments so phrases like "CREATE with baseline"
            // in a JSDoc don't trigger false-positive table writes.
            if (text.startsWith("*") || text.startsWith("//") || text.startsWith("/*")) continue;
            out.push({ file, line: ln, text });
        } catch { /* skip non-JSON lines */ }
    }
    return out;
};

const collectMatches = (pattern: RegExp, hits: readonly SearchHit[]): Set<string> => {
    const tables = new Set<string>();
    for (const hit of hits) {
        const matches = hit.text.matchAll(pattern);
        for (const m of matches) {
            const name = m[1];
            if (name && /^[a-z][a-z0-9_]*$/.test(name)) tables.add(name);
        }
    }
    return tables;
};

const findWriters = (): Set<string> => {
    // 1. Literal SurrealQL writes: `UPSERT foo`, `CREATE foo`, `INSERT INTO foo`.
    const literal = rgJson(
        `\\b(UPSERT|CREATE|INSERT INTO)\\s+\\\`?([a-z][a-z0-9_]*)\\\`?`,
        WRITER_GLOBS,
    );
    // 2. Template-literal writes via the shared `recordRef` helper, e.g.
    //    UPSERT ${recordRef("experiment", key)} MERGE { ... }
    //    UPDATE ${recordRef("foo", k)} SET ...
    //    DELETE ${recordRef("bar", k)};
    // The reviewer flagged this as a hole: CLI-resident writers like
    // cmdImproveAccept use this form and the literal regex misses them.
    const templated = rgJson(
        `\\b(UPSERT|UPDATE|DELETE|RELATE|CREATE)\\b.{0,200}recordRef\\(["']([a-z][a-z0-9_]*)["']`,
        WRITER_GLOBS,
    );
    // 3. Literal RELATE that names a relation table inline (`->later_fixed_by:`).
    const relates = rgJson(`->([a-z][a-z0-9_]*):`, WRITER_GLOBS);
    return new Set([
        ...collectMatches(/\b(?:UPSERT|CREATE|INSERT INTO)\s+`?([a-z][a-z0-9_]*)`?/g, literal),
        ...collectMatches(/\b(?:UPSERT|UPDATE|DELETE|RELATE|CREATE)\b.{0,200}recordRef\(["']([a-z][a-z0-9_]*)["']/g, templated),
        ...collectMatches(/->([a-z][a-z0-9_]*):/g, relates),
    ]);
};

const findReaders = (): Set<string> => {
    // Document tables: `FROM <table>` / `SELECT ... FROM <table>`.
    const selects = rgJson(`\\bFROM\\s+\\\`?([a-z][a-z0-9_]*)\\\`?`, READER_GLOBS);
    // Relation traversal: `->relation->`, `<-relation<-`, terminal forms.
    // Edge readers rarely use `FROM`; they walk the graph.
    const traversals = rgJson(`(?:->|<-)([a-z][a-z0-9_]*)(?:->|<-|\\b|$)`, READER_GLOBS);
    return new Set([
        ...collectMatches(/\bFROM\s+`?([a-z][a-z0-9_]*)`?/g, selects),
        ...collectMatches(/(?:->|<-)([a-z][a-z0-9_]*)(?:->|<-|\b|$)/g, traversals),
    ]);
};

const main = () => {
    const writers = findWriters();
    const readers = findReaders();

    const violators: string[] = [];
    for (const table of writers) {
        if (readers.has(table)) continue;
        if (GRANDFATHER.has(table)) continue;
        violators.push(table);
    }

    if (violators.length === 0) {
        process.stdout.write(`[check-table-coverage] OK (${writers.size} writers, ${readers.size} readers, ${GRANDFATHER.size} grandfathered)\n`);
        return;
    }

    process.stderr.write(`[check-table-coverage] ${violators.length} table(s) have writers but no reader:\n`);
    for (const v of violators.sort()) process.stderr.write(`  - ${v}\n`);
    process.stderr.write(`\nFix one of:\n`);
    process.stderr.write(`  1. Add a SELECT site under ${READER_GLOBS.join(", ")} (preferred).\n`);
    process.stderr.write(`  2. Remove the writer if the data is dead.\n`);
    process.stderr.write(`  3. (rarely) Add to GRANDFATHER in scripts/check-table-coverage.ts with a comment + issue ref.\n`);
    process.exit(1);
};

main();
