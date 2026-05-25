#!/usr/bin/env bun
/**
 * Table coverage CI gate (Phase D, plan
 * docs/superpowers/plans/2026-05-25-experiment-loop-cleanup-and-rebuild.md).
 *
 * Root-cause fix for the documented 5-cluster pattern of write-only orphan
 * tables (learning_match, gotcha, harness_learning, intervention,
 * recommendation, etc) that landed schema + writer + CLI stub then never
 * shipped a real reader. Hard CI fail.
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

const SRC_DIR = "src";
const WRITER_GLOBS = ["src/ingest", "src/improve", "src/dogfood", "src/project", "src/hooks"];
const READER_GLOBS = ["src/cli", "src/dashboard", "src/queries", "src/improve", "src/ingest"];

/**
 * Tables that legitimately have no reader yet. ONLY shrink this list.
 * Add a comment with the reason and an issue/plan ref before adding.
 */
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
    const upserts = rgJson(`\\b(UPSERT|CREATE|INSERT INTO)\\s+\\\`?([a-z][a-z0-9_]*)\\\`?`, WRITER_GLOBS);
    const relates = rgJson(`->([a-z][a-z0-9_]*):`, WRITER_GLOBS);
    return new Set([
        ...collectMatches(/\b(?:UPSERT|CREATE|INSERT INTO)\s+`?([a-z][a-z0-9_]*)`?/g, upserts),
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
