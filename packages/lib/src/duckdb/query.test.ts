/**
 * The typed read helpers, against a REAL published snapshot.
 *
 * The interesting behaviour here is the ERROR POLICY, and it cannot be shown
 * with a mock: the defensive helpers have to degrade on a decode failure, on a
 * malformed statement, AND on the single most common real-world state - a cache
 * that has never been ingested - while `cachePaged` propagates. Each of those
 * arrives from a different layer of the seam, so each is provoked for real.
 */
import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import { publishCacheFixture, readFixture, runWithPlatform } from "../testing/cache-fixture.ts";
import { duckdbTestSetup } from "../testing/duckdb-dylib.ts";
import { eqClause, limitOffset, type Clause } from "./clause.ts";
import { TimestampColumn } from "./columns.ts";
import {
    cacheFirst,
    cachePaged,
    cacheRows,
    CountRow,
    defineCacheQuery,
    defineCacheSingleQuery,
    runCacheQuery,
    runCacheSingleQuery,
} from "./query.ts";
import { CacheRead } from "./seam.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("cache query helpers", {
    requireFts: true,
});

const SessionRow = Schema.Struct({
    id: Schema.String,
    project: Schema.NullOr(Schema.String),
    started_at: TimestampColumn,
});

const STARTED = "2026-08-01T10:00:00.000Z";

/** Three sessions across two projects, so filters and pagination have something
 *  to be wrong about. */
const fixture = (name: string) =>
    runWithPlatform(
        publishCacheFixture(tempDir(name), dylibPath, (w) =>
            w.putMany("session", [
                { id: "session-a", project: "ax", source: "claude", started_at: new Date(STARTED) },
                {
                    id: "session-b",
                    project: "ax",
                    source: "claude",
                    started_at: new Date("2026-08-02T10:00:00.000Z"),
                },
                {
                    id: "session-c",
                    project: "other",
                    source: "codex",
                    started_at: new Date("2026-08-03T10:00:00.000Z"),
                },
            ]),
        ),
    );

const overFixture = <A, E>(
    snapshotPath: string,
    effect: Effect.Effect<A, E, CacheRead>,
): Promise<A> =>
    Effect.runPromise(
        effect.pipe(Effect.provide(readFixture(snapshotPath, dylibPath))) as Effect.Effect<A, E>,
    );

/** A `CacheRead` over a snapshot that does not exist - the first-run state. */
const overMissingSnapshot = <A, E>(effect: Effect.Effect<A, E, CacheRead>): Promise<A> =>
    Effect.runPromise(
        effect.pipe(
            Effect.provide(readFixture("/nonexistent/ax-cache/never-ingested.duckdb", dylibPath)),
        ) as Effect.Effect<A, E>,
    );

/** Capture `console.error` for the duration of `body`. The defensive policy is
 *  "degrade AND say so"; a test that only checked the value would pass on a
 *  helper that swallowed failures silently. */
const capturingErrors = async <A>(body: () => Promise<A>): Promise<[A, ReadonlyArray<string>]> => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: ReadonlyArray<unknown>) => {
        lines.push(args.map((a) => String(a)).join(" "));
    };
    try {
        return [await body(), lines];
    } finally {
        console.error = original;
    }
};

const ALL_SESSIONS: Clause = { sql: "SELECT id, project, started_at FROM session ORDER BY id", params: [] };

describe("cacheRows", () => {
    dtest("decodes every row through the schema", async () => {
        const f = await fixture("ax-q-rows-");
        const rows = await overFixture(f.snapshotPath, cacheRows(SessionRow, ALL_SESSIONS, "test"));

        expect(rows.map((r) => r.id)).toEqual(["session-a", "session-b", "session-c"]);
        expect(rows[0]?.started_at).toBeInstanceOf(Date);
        expect(rows[0]?.started_at.toISOString()).toBe(STARTED);
    });

    dtest("binds the clause parameters in order", async () => {
        const f = await fixture("ax-q-bind-");
        const clause: Clause = {
            sql: "SELECT id, project, started_at FROM session WHERE project = ? AND source = ? ORDER BY id",
            params: ["ax", "claude"],
        };
        const rows = await overFixture(f.snapshotPath, cacheRows(SessionRow, clause, "test"));

        expect(rows.map((r) => r.id)).toEqual(["session-a", "session-b"]);
    });

    dtest("degrades to [] and names the caller's context on a decode failure", async () => {
        const f = await fixture("ax-q-decode-");
        // `project` is a VARCHAR; asking for a number is a decode failure, not a
        // database failure - a different layer from the one below.
        const WrongRow = Schema.Struct({ id: Schema.String, project: Schema.Number });
        const [rows, logged] = await capturingErrors(() =>
            overFixture(
                f.snapshotPath,
                cacheRows(WrongRow, { sql: "SELECT id, project FROM session", params: [] }, "sessions list"),
            ),
        );

        expect(rows).toEqual([]);
        expect(logged.join("\n")).toContain("sessions list");
    });

    dtest("degrades to [] on a malformed statement", async () => {
        const f = await fixture("ax-q-badsql-");
        const [rows] = await capturingErrors(() =>
            overFixture(
                f.snapshotPath,
                cacheRows(SessionRow, { sql: "SELECT nope FROM nowhere", params: [] }, "broken"),
            ),
        );

        expect(rows).toEqual([]);
    });

    dtest("tells the user to run `ax ingest` when there is no cache at all", async () => {
        // The most common first-run state. The seam already writes the sentence
        // that fixes it; a defensive helper that logged a bare error would throw
        // that away and leave an empty dashboard with no explanation.
        const [rows, logged] = await capturingErrors(() =>
            overMissingSnapshot(cacheRows(SessionRow, ALL_SESSIONS, "sessions list")),
        );

        expect(rows).toEqual([]);
        expect(logged.join("\n")).toContain("ax ingest");
    });
});

describe("cacheFirst", () => {
    dtest("returns the first row, or null when there are none", async () => {
        const f = await fixture("ax-q-first-");
        const found = await overFixture(
            f.snapshotPath,
            cacheFirst(
                SessionRow,
                {
                    sql: "SELECT id, project, started_at FROM session WHERE project = ? LIMIT 1",
                    params: ["other"],
                },
                "test",
            ),
        );
        expect(found?.id).toBe("session-c");

        const missing = await overFixture(
            f.snapshotPath,
            cacheFirst(
                SessionRow,
                { sql: "SELECT id, project, started_at FROM session WHERE project = ?", params: ["nope"] },
                "test",
            ),
        );
        expect(missing).toBeNull();
    });
});

describe("cachePaged", () => {
    const page = (offset: number, limit: number): Clause => ({
        sql: `SELECT id, project, started_at FROM session ORDER BY id ${limitOffset(limit, offset).sql}`,
        params: limitOffset(limit, offset).params,
    });
    const countAll: Clause = { sql: "SELECT count(*) AS total FROM session", params: [] };

    dtest("returns the page plus the BIGINT total as a number", async () => {
        const f = await fixture("ax-q-paged-");
        const result = await overFixture(
            f.snapshotPath,
            cachePaged(SessionRow, page(0, 2), countAll, (row) => row.id),
        );

        expect(result.items).toEqual(["session-a", "session-b"]);
        // `count(*)` is a BIGINT; a helper that typed it Schema.Number would
        // fail to decode, so the total has to go through the bigint contract.
        expect(result.total).toBe(3);
        expect(typeof result.total).toBe("number");
    });

    dtest("walks the pages without overlap", async () => {
        const f = await fixture("ax-q-paged2-");
        const first = await overFixture(
            f.snapshotPath,
            cachePaged(SessionRow, page(0, 2), countAll, (row) => row.id),
        );
        const second = await overFixture(
            f.snapshotPath,
            cachePaged(SessionRow, page(2, 2), countAll, (row) => row.id),
        );

        expect([...first.items, ...second.items]).toEqual(["session-a", "session-b", "session-c"]);
    });

    dtest("PROPAGATES a failure instead of reporting an empty page", async () => {
        // A paginated view that degrades silently renders "0 results" for a
        // broken query, which is indistinguishable from a genuinely empty
        // result - so this one keeps its typed error channel.
        const f = await fixture("ax-q-paged-fail-");
        const outcome = await overFixture(
            f.snapshotPath,
            Effect.result(
                cachePaged(
                    SessionRow,
                    { sql: "SELECT nope FROM nowhere", params: [] },
                    countAll,
                    (r) => r.id,
                ),
            ),
        );

        expect(outcome._tag).toBe("Failure");
    });
});

describe("CountRow", () => {
    dtest("decodes the BIGINT count(*) shape every ported query uses", async () => {
        const f = await fixture("ax-q-count-");
        const found = await overFixture(
            f.snapshotPath,
            cacheFirst(CountRow, { sql: "SELECT count(*) AS total FROM session", params: [] }, "test"),
        );

        expect(found?.total).toBe(3);
    });
});

describe("defineCacheQuery", () => {
    const projectSessions = defineCacheQuery({
        name: "projectSessions",
        row: SessionRow,
        clause: (project: string) => ({
            sql: `SELECT id, project, started_at FROM session WHERE 1 = 1 ${
                eqClause("project", project).sql
            } ORDER BY id`,
            params: eqClause("project", project).params,
        }),
        mapRow: (row, index) => `${index}:${row.id}`,
    });

    dtest("builds, runs and maps with the row index", async () => {
        const f = await fixture("ax-q-define-");
        const mapped = await overFixture(f.snapshotPath, runCacheQuery(projectSessions, "ax"));

        expect(mapped).toEqual(["0:session-a", "1:session-b"]);
    });

    dtest("degrades to [] and logs the query NAME - no context string to pass", async () => {
        const broken = defineCacheQuery({
            name: "brokenQuery",
            row: SessionRow,
            clause: () => ({ sql: "SELECT nope FROM nowhere", params: [] }),
            mapRow: (row) => row.id,
        });
        const f = await fixture("ax-q-define-fail-");
        const [mapped, logged] = await capturingErrors(() =>
            overFixture(f.snapshotPath, runCacheQuery(broken, undefined)),
        );

        expect(mapped).toEqual([]);
        expect(logged.join("\n")).toContain("brokenQuery");
    });

    dtest("a single query returns the mapped row, or null", async () => {
        const one = defineCacheSingleQuery({
            name: "oneSession",
            row: SessionRow,
            clause: (id: string) => ({
                sql: "SELECT id, project, started_at FROM session WHERE id = ? LIMIT 1",
                params: [id],
            }),
            mapRow: (row) => row.project,
        });
        const f = await fixture("ax-q-single-");

        expect(await overFixture(f.snapshotPath, runCacheSingleQuery(one, "session-c"))).toBe("other");
        expect(await overFixture(f.snapshotPath, runCacheSingleQuery(one, "session-zzz"))).toBeNull();
    });
});

describe("the layer requirement", () => {
    test("a helper needs CacheRead and nothing else", () => {
        // Typed proof that these compose into a command without dragging a
        // SurrealClient (or anything else) into the requirement channel.
        const program: Effect.Effect<ReadonlyArray<string>, never, CacheRead> = cacheRows(
            Schema.Struct({ id: Schema.String }),
            { sql: "SELECT id FROM session", params: [] },
            "test",
        ).pipe(Effect.map((rows) => rows.map((r) => r.id)));

        const provided: Effect.Effect<ReadonlyArray<string>, never, never> = program.pipe(
            Effect.provide(Layer.succeed(CacheRead)({} as never)),
        );
        expect(typeof provided).toBe("object");
    });
});
