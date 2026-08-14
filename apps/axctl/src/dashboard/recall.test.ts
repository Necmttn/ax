/**
 * `ax recall` end to end, against a REAL DuckDB.
 *
 * Nothing is mocked. Each case builds a live database in a temp directory from
 * the REAL `schema.duckdb.sql`, writes fixture rows through the seam's write
 * path (holding the ingest lock, exactly as ingest does), builds the FTS
 * indexes, publishes a snapshot, and then reads it back through `CacheRead` -
 * the same service the CLI, the HTTP handler and the MCP tool resolve.
 *
 * This replaces the old suite, which asserted on SQL TEXT (`expect(sql).toContain(...)`).
 * That style could not tell a working query from a query that merely looked
 * right - and the port from Surreal changed BM25 from a boolean operator into a
 * score, which a text assertion would have waved through. The text-level
 * properties worth keeping (every value is a bound parameter) moved to
 * `../queries/recall.test.ts`, where they belong.
 */
import { describe, expect } from "bun:test";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Path } from "effect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DUCKDB_SCHEMA_SQL } from "@ax/schema/duckdb-ddl";
import { withIngestLock } from "@ax/lib/ingest-lock";
import { buildFtsIndexes } from "@ax/lib/duckdb/fts";
import { CacheRead, CacheReadLayer, withCacheWrite, type CacheWriteService } from "@ax/lib/duckdb/seam";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import type { RecallResponse } from "@ax/lib/shared/dashboard-types";
import { fetchRecall, type RecallParams } from "./recall.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("ax recall");

const Platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

/** A written, published snapshot plus the read layer that serves it. */
interface Fixture {
    readonly dir: string;
    readonly snapshotPath: string;
}

const T = (iso: string): Date => new Date(iso);

/** Turns need a session to join to; this is the minimum a session row needs. */
const session = (
    id: string,
    fields: Readonly<Record<string, string | Date | null>> = {},
) => ({ id, source: "claude", ...fields });

const turn = (
    id: string,
    sessionId: string,
    seq: number,
    text: string,
    ts: string,
    role = "user",
) => ({
    id,
    session: sessionId,
    seq,
    ts: T(ts),
    role,
    text,
    text_excerpt: text,
    has_tool_use: false,
    has_error: false,
});

/**
 * Build a live database from the real DDL, run `write`, index, publish.
 *
 * The ingest lock is held for the whole write, because the seam refuses to open
 * the live database otherwise - the lock IS the write capability.
 */
const publish = (
    prefix: string,
    write: (w: CacheWriteService) => Effect.Effect<unknown, unknown, never>,
): Effect.Effect<Fixture, unknown, FileSystem.FileSystem | Path.Path> =>
    Effect.suspend(() => {
        const dir = tempDir(prefix);
        const fixture: Fixture = { dir, snapshotPath: join(dir, "snapshot.duckdb") };
        return withIngestLock(
            {
                lockPath: join(dir, "ingest.lock"),
                command: "recall-test",
                staleMs: 60_000,
                onBusy: () => Effect.die("the ingest lock was busy in a single-process test"),
            },
            withCacheWrite(
                {
                    livePath: join(dir, "live.duckdb"),
                    lockPath: join(dir, "ingest.lock"),
                    snapshotPath: fixture.snapshotPath,
                    schemaSql: DUCKDB_SCHEMA_SQL,
                    ...(dylibPath === null ? {} : { assetPath: dylibPath }),
                },
                (w) =>
                    Effect.gen(function* () {
                        yield* write(w);
                        // FTS is a BUILD STEP, not DDL: the index must exist
                        // before any `match_bm25` call, and recall's turn and
                        // commit sources both depend on it.
                        yield* buildFtsIndexes(w);
                    }),
            ),
        ).pipe(Effect.map(() => fixture));
    });

/** Read `params` back out of a published fixture, through the real read seam. */
const recall = (
    fixture: Fixture,
    params: RecallParams,
): Effect.Effect<RecallResponse, unknown> =>
    fetchRecall(params).pipe(
        Effect.provide(
            CacheReadLayer({
                snapshotPath: fixture.snapshotPath,
                ...(dylibPath === null ? {} : { assetPath: dylibPath }),
            }),
        ),
    );

const run = <A>(effect: Effect.Effect<A, unknown, FileSystem.FileSystem | Path.Path>): Promise<A> =>
    Effect.runPromise(effect.pipe(Effect.provide(Platform)) as Effect.Effect<A, unknown>);

/** Publish a fixture, run one recall against it, and hand back the response. */
const withRecall = (
    prefix: string,
    write: (w: CacheWriteService) => Effect.Effect<unknown, unknown, never>,
    params: RecallParams,
): Promise<RecallResponse> =>
    run(publish(prefix, write).pipe(Effect.flatMap((fixture) => recall(fixture, params))));

/** The corpus most cases share: two sessions, four turns, two commits, two skills. */
const CORPUS = (w: CacheWriteService) =>
    Effect.gen(function* () {
        yield* w.putMany("session", [
            session("session:a", { project: "ax", cwd: "/w/ax", repository: "repository:ax" }),
            session("session:b", { project: "other", cwd: "/w/other", repository: "repository:other" }),
        ]);
        yield* w.putMany("turn", [
            turn("turn:1", "session:a", 1, "the duckdb seam replaces surreal", "2026-08-10T10:00:00.000Z"),
            turn("turn:2", "session:a", 2, "an unrelated note about pancakes", "2026-08-11T10:00:00.000Z"),
            turn("turn:3", "session:b", 1, "duckdb again, in another project", "2026-08-12T10:00:00.000Z"),
            turn("turn:4", "session:b", 2, "duckdb in the distant past", "2026-01-01T10:00:00.000Z"),
        ]);
        yield* w.putMany("commit", [
            {
                id: "commit:1",
                sha: "aaa1111",
                repo: "ax",
                message: "feat: duckdb snapshot publisher",
                ts: T("2026-08-10T11:00:00.000Z"),
                repository: "repository:ax",
            },
            {
                id: "commit:2",
                sha: "bbb2222",
                repo: "other",
                message: "chore: bump pancake mix",
                ts: T("2026-08-11T11:00:00.000Z"),
                repository: "repository:other",
            },
        ]);
        yield* w.putMany("skill", [
            {
                id: "skill:duckdb-ops",
                name: "duckdb-ops",
                scope: "user",
                dir_path: "/skills/duckdb-ops",
                description: "run duckdb maintenance",
                content_hash: "h1",
            },
            {
                id: "skill:pancakes",
                name: "pancakes",
                scope: "user",
                dir_path: "/skills/pancakes",
                description: "unrelated",
                content_hash: "h2",
            },
        ]);
    });

describe("recall: turn source", () => {
    dtest("returns only turns whose text matches, newest first", async () => {
        const res = await withRecall("ax-recall-turns-", CORPUS, { q: "duckdb" });

        expect(res.hits.map((h) => h.turn_id)).toEqual(["turn:3", "turn:1", "turn:4"]);
        expect(res.total_counts.turn).toBe(3);
        // The non-matching turn is genuinely absent, not merely ranked low.
        expect(res.hits.map((h) => h.turn_id)).not.toContain("turn:2");
    });

    dtest("carries the joined session's project, source and cwd onto each hit", async () => {
        const res = await withRecall("ax-recall-join-", CORPUS, { q: "surreal" });

        expect(res.hits).toHaveLength(1);
        expect(res.hits[0]).toMatchObject({
            turn_id: "turn:1",
            session_id: "session:a",
            project: "ax",
            source: "claude",
            cwd: "/w/ax",
            role: "user",
        });
        // The seam decodes TIMESTAMP to a Date; the API contract is an ISO string.
        expect(res.hits[0]?.ts).toBe("2026-08-10T10:00:00.000Z");
    });

    dtest("filters by project", async () => {
        const res = await withRecall("ax-recall-project-", CORPUS, { q: "duckdb", project: "ax" });
        expect(res.hits.map((h) => h.turn_id)).toEqual(["turn:1"]);
        expect(res.total_counts.turn).toBe(1);
    });

    dtest("filters by since", async () => {
        const res = await withRecall("ax-recall-since-", CORPUS, {
            q: "duckdb",
            since: "2026-08-01T00:00:00.000Z",
        });
        expect(res.hits.map((h) => h.turn_id)).toEqual(["turn:3", "turn:1"]);
    });

    dtest("scope=here filters by the session's repository", async () => {
        const res = await withRecall("ax-recall-scope-", CORPUS, {
            q: "duckdb",
            scope: { kind: "here", repositoryKey: "repository:other" },
        });
        expect(res.hits.map((h) => h.turn_id)).toEqual(["turn:3", "turn:4"]);
    });

    dtest("paginates, and reports the FULL match count with the page", async () => {
        const fixture = await run(publish("ax-recall-page-", CORPUS));
        const first = await run(recall(fixture, { q: "duckdb", offset: 0, limit: 2 }));
        const second = await run(recall(fixture, { q: "duckdb", offset: 2, limit: 2 }));

        expect(first.hits.map((h) => h.turn_id)).toEqual(["turn:3", "turn:1"]);
        expect(first.total_counts.turn).toBe(3);
        expect(first.truncated).toBe(true);
        expect(second.hits.map((h) => h.turn_id)).toEqual(["turn:4"]);
        expect(second.truncated).toBe(false);
    });
});

describe("recall: session prefilters", () => {
    const withInvocation = (w: CacheWriteService) =>
        Effect.gen(function* () {
            yield* CORPUS(w);
            // session:a invoked duckdb-ops; session:b invoked nothing.
            yield* w.put("invoked", {
                id: "invoked:1",
                in_id: "turn:1",
                out_id: "skill:duckdb-ops",
                ts: T("2026-08-10T10:00:01.000Z"),
                session: "session:a",
                turn_has_error: false,
                was_corrected: false,
            });
            yield* w.put("content_type", {
                id: "content_type:image",
                category: "binary",
                label: "image",
            });
            yield* w.put("has_content", {
                id: "has_content:1",
                in_id: "tool_call:1",
                out_id: "content_type:image",
                method: "sniff",
                confidence: 1,
                bytes: 10,
                session: "session:b",
                ts: T("2026-08-12T10:00:01.000Z"),
            });
        });

    dtest("--skill narrows turns to sessions that invoked it", async () => {
        const res = await withRecall("ax-recall-skillfilter-", withInvocation, {
            q: "duckdb",
            skill: "duckdb-ops",
        });
        expect(res.hits.map((h) => h.turn_id)).toEqual(["turn:1"]);
    });

    dtest("--types narrows turns to sessions with that content category", async () => {
        const res = await withRecall("ax-recall-types-", withInvocation, {
            q: "duckdb",
            types: ["binary"],
        });
        expect(res.hits.map((h) => h.turn_id)).toEqual(["turn:3", "turn:4"]);
    });

    dtest("two prefilters INTERSECT, and an empty intersection returns nothing", async () => {
        // session:a matched the skill, session:b matched the content type.
        const res = await withRecall("ax-recall-intersect-", withInvocation, {
            q: "duckdb",
            skill: "duckdb-ops",
            types: ["binary"],
        });
        expect(res.hits).toEqual([]);
        expect(res.total_counts.turn).toBe(0);
    });

    dtest("a prefilter that matches no session short-circuits to zero", async () => {
        const res = await withRecall("ax-recall-noskill-", withInvocation, {
            q: "duckdb",
            skill: "nonexistent-skill",
        });
        expect(res.hits).toEqual([]);
        expect(res.total_counts.turn).toBe(0);
    });
});

describe("recall: commit source", () => {
    dtest("matches commit messages and carries a snippet + score", async () => {
        const res = await withRecall("ax-recall-commits-", CORPUS, {
            q: "duckdb",
            sources: ["commit"],
        });

        expect(res.commits.map((c) => c.sha)).toEqual(["aaa1111"]);
        expect(res.commits[0]?.snippet).toBe("feat: duckdb snapshot publisher");
        expect(res.commits[0]?.score).toBeGreaterThan(0);
        expect(res.total_counts.commit).toBe(1);
        // Turn hits are not fetched when turns were not requested.
        expect(res.hits).toEqual([]);
        expect(res.total_counts.turn).toBe(0);
    });

    dtest("scope=here filters commits by repository", async () => {
        const res = await withRecall("ax-recall-commitscope-", CORPUS, {
            q: "pancake",
            sources: ["commit"],
            scope: { kind: "here", repositoryKey: "repository:ax" },
        });
        // The pancake commit belongs to repository:other, so scoping here hides it.
        expect(res.commits).toEqual([]);
    });
});

describe("recall: skill source", () => {
    dtest("matches on name or description, ranking a name hit higher", async () => {
        const res = await withRecall("ax-recall-skills-", CORPUS, {
            q: "duckdb",
            sources: ["skill"],
        });

        expect(res.skills.map((s) => s.name)).toEqual(["duckdb-ops"]);
        expect(res.skills[0]?.score).toBe(2);
        expect(res.total_counts.skill).toBe(1);
    });

    dtest("a description-only hit still matches, and ranks below a name hit", async () => {
        const res = await withRecall("ax-recall-skilldesc-", CORPUS, {
            q: "maintenance",
            sources: ["skill"],
        });
        expect(res.skills.map((s) => s.name)).toEqual(["duckdb-ops"]);
        expect(res.skills[0]?.score).toBe(1);
    });

    dtest("repository scope does NOT apply to skills (they are not repo-scoped)", async () => {
        const res = await withRecall("ax-recall-skillscope-", CORPUS, {
            q: "duckdb",
            sources: ["skill"],
            scope: { kind: "here", repositoryKey: "repository:other" },
        });
        expect(res.skills.map((s) => s.name)).toEqual(["duckdb-ops"]);
    });
});

describe("recall: fan-out", () => {
    dtest("all three sources: total_count is the sum of the three counts", async () => {
        const res = await withRecall("ax-recall-all-", CORPUS, {
            q: "duckdb",
            sources: ["turn", "commit", "skill"],
        });

        expect(res.total_counts).toEqual({ turn: 3, commit: 1, skill: 1 });
        expect(res.total_count).toBe(5);
        expect(res.hits).toHaveLength(3);
        expect(res.commits).toHaveLength(1);
        expect(res.skills).toHaveLength(1);
    });

    dtest("defaults to turns only when no sources are requested", async () => {
        const res = await withRecall("ax-recall-default-", CORPUS, { q: "duckdb" });
        expect(res.hits).toHaveLength(3);
        expect(res.commits).toEqual([]);
        expect(res.skills).toEqual([]);
        expect(res.total_count).toBe(3);
    });

    dtest("an empty query returns an empty response without touching any source", async () => {
        const res = await withRecall("ax-recall-empty-", CORPUS, {
            q: "   ",
            sources: ["turn", "commit", "skill"],
        });

        expect(res.hits).toEqual([]);
        expect(res.commits).toEqual([]);
        expect(res.skills).toEqual([]);
        expect(res.total_count).toBe(0);
        // `q` is echoed VERBATIM, not the trimmed/lowercased matching form.
        expect(res.q).toBe("   ");
    });

    dtest("echoes the caller's query verbatim while matching case-insensitively", async () => {
        const res = await withRecall("ax-recall-case-", CORPUS, { q: "DuckDB" });
        expect(res.q).toBe("DuckDB");
        expect(res.hits).toHaveLength(3);
    });
});

describe("recall: no snapshot", () => {
    dtest("fails with a typed error naming the missing cache and what to run", async () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-recall-missing-"));
        const exit = await Effect.runPromiseExit(
            fetchRecall({ q: "duckdb" }).pipe(
                Effect.provide(
                    CacheReadLayer({
                        snapshotPath: join(dir, "absent.duckdb"),
                        ...(dylibPath === null ? {} : { assetPath: dylibPath }),
                    }),
                ),
                Effect.provide(Platform),
            ) as Effect.Effect<unknown, unknown>,
        );

        expect(exit._tag).toBe("Failure");
        const rendered = JSON.stringify(exit);
        expect(rendered).toContain("CacheUnavailableError");
        expect(rendered).toContain("ax ingest");
    });
});
