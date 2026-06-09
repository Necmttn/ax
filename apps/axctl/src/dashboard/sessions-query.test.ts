/**
 * Tests for src/dashboard/sessions-query.ts
 *
 * Uses a mock SurrealClient to verify that each function emits the expected
 * SurrealQL clauses without requiring a live DB connection.
 */
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { RecordId } from "surrealdb";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { AxConfig, AxConfigTest } from "@ax/lib/config";
import {
    listSessionsHere,
    listSessionsAround,
    listSessionsNear,
} from "./sessions-query.ts";

// ---------------------------------------------------------------------------
// Mock DB helper
// ---------------------------------------------------------------------------

interface QueryCapture {
    sql: string;
    bindings: Record<string, unknown> | undefined;
}

function makeMockDb(opts?: {
    sessionRows?: ReadonlyArray<Record<string, unknown>>;
}): { layer: Layer.Layer<SurrealClient>; captured: QueryCapture[] } {
    const captured: QueryCapture[] = [];
    let calls = 0;
    const impl: SurrealClientShape = {
        query: <T extends unknown[] = unknown[]>(sql: string, bindings?: Record<string, unknown>) => {
            captured.push({ sql, bindings });
            calls += 1;
            if (calls === 1 && opts?.sessionRows) {
                return Effect.succeed([opts.sessionRows] as unknown as T);
            }
            return Effect.succeed([[]] as unknown as T);
        },
        upsert: (_id: RecordId, _content: Record<string, unknown>) => Effect.void,
        relate: () => Effect.void,
        putFile: () => Effect.void,
        getFile: () => Effect.succeed(""),
        raw: undefined as unknown as import("surrealdb").Surreal,
    };
    return { layer: Layer.succeed(SurrealClient, impl), captured };
}

// enrichSessions reads its fan-out width from AxConfig.knobs, so the mock DB
// layer is merged with a test AxConfig (defaults; no env overrides needed).
const configLayer = AxConfigTest({}).pipe(Layer.provide(BunFileSystem.layer));

async function run<A>(
    eff: Effect.Effect<A, unknown, SurrealClient | AxConfig>,
    layer: Layer.Layer<SurrealClient>,
): Promise<A> {
    return Effect.runPromise(eff.pipe(Effect.provide(Layer.mergeAll(layer, configLayer))));
}

// ---------------------------------------------------------------------------
// Tests: listSessionsHere
// ---------------------------------------------------------------------------

describe("listSessionsHere", () => {
    test("uses repository literal and default days=14", async () => {
        const { layer, captured } = makeMockDb();

        await run(
            listSessionsHere({ repositoryKey: "remote__github_com_foo_bar__abc123" }),
            layer,
        );

        expect(captured).toHaveLength(1);
        const { sql, bindings } = captured[0]!;
        // Record literal must be embedded in SQL - NOT a binding
        expect(sql).toContain("repository = repository:`remote__github_com_foo_bar__abc123`");
        expect(sql).not.toContain("$repository");
        expect(bindings?.["repository"]).toBeUndefined();
        expect(sql).toContain("14d");
        expect(sql).toContain("time::now()");
    });

    test("respects custom --days value", async () => {
        const { layer, captured } = makeMockDb();

        await run(
            listSessionsHere({ repositoryKey: "remote__test__abc", days: 7 }),
            layer,
        );

        expect(captured[0]!.sql).toContain("7d");
        expect(captured[0]!.sql).not.toContain("14d");
    });

    test("enriches turn_count and first_user_message via per-session indexed lookups", async () => {
        const { layer, captured } = makeMockDb({
            sessionRows: [
                {
                    id: "session:`s1`",
                    started_at: "2026-05-28T00:00:00Z",
                    ended_at: null,
                    source: "claude",
                    project: "p",
                    repository: "repository:`r`",
                },
            ],
        });

        await run(
            listSessionsHere({ repositoryKey: "remote__test__abc" }),
            layer,
        );

        // First call: session list (no turn_count/first_user_message in projection).
        expect(captured[0]!.sql).not.toContain("turn_count");
        // One enrichment query per session, using the literal session id (NOT a
        // `session IN [...]` membership scan) so the turn_session_seq index is hit.
        expect(captured).toHaveLength(2);
        const enrich = captured[1]!.sql;
        expect(enrich).toContain("FROM ONLY session:`s1`");
        expect(enrich).toContain("count() FROM turn WHERE session = session:`s1`");
        expect(enrich).toContain("AND role = 'user'");
        expect(enrich).toContain("LIMIT 1");
        expect(enrich).not.toContain("session IN");
    });

    test("orders by started_at DESC", async () => {
        const { layer, captured } = makeMockDb();
        await run(
            listSessionsHere({ repositoryKey: "remote__test__abc" }),
            layer,
        );
        expect(captured[0]!.sql).toContain("ORDER BY started_at DESC");
    });
});

// ---------------------------------------------------------------------------
// Tests: listSessionsAround
// ---------------------------------------------------------------------------

describe("listSessionsAround", () => {
    test("passes from/to as Date bindings and uses default days=3", async () => {
        const { layer, captured } = makeMockDb();
        const centre = new Date("2025-03-15T12:00:00Z");

        await run(listSessionsAround({ date: centre }), layer);

        expect(captured).toHaveLength(1);
        const { sql, bindings } = captured[0]!;
        expect(sql).toContain("$from");
        expect(sql).toContain("$to");
        expect(bindings).toBeDefined();
        expect(bindings!.from).toBeInstanceOf(Date);
        expect(bindings!.to).toBeInstanceOf(Date);

        // window should be ±3 days around centre
        const from = bindings!.from as Date;
        const to = bindings!.to as Date;
        const diffDays = (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
        expect(diffDays).toBeCloseTo(6, 1);
    });

    test("respects custom days", async () => {
        const { layer, captured } = makeMockDb();
        const centre = new Date("2025-03-15T12:00:00Z");

        await run(listSessionsAround({ date: centre, days: 7 }), layer);

        const from = captured[0]!.bindings!.from as Date;
        const to = captured[0]!.bindings!.to as Date;
        const diffDays = (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
        expect(diffDays).toBeCloseTo(14, 1);
    });

    test("includes project filter clause when project is set", async () => {
        const { layer, captured } = makeMockDb();

        await run(
            listSessionsAround({ date: new Date(), project: "-Users-foo-bar" }),
            layer,
        );

        const { sql, bindings } = captured[0]!;
        expect(sql).toContain("AND project = $project");
        expect(bindings!.project).toBe("-Users-foo-bar");
    });

    test("omits project clause when project is null", async () => {
        const { layer, captured } = makeMockDb();

        await run(
            listSessionsAround({ date: new Date(), project: null }),
            layer,
        );

        expect(captured[0]!.sql).not.toContain("$project");
    });

    test("no repository WHERE filter (around is not repo-scoped)", async () => {
        const { layer, captured } = makeMockDb();
        await run(listSessionsAround({ date: new Date() }), layer);
        // The SELECT projection contains "repository" but the WHERE clause should not
        expect(captured[0]!.sql).not.toContain("AND repository");
    });
});

// ---------------------------------------------------------------------------
// Tests: listSessionsNear
// ---------------------------------------------------------------------------

describe("listSessionsNear", () => {
    test("passes from/to Date bindings", async () => {
        const { layer, captured } = makeMockDb();
        const from = new Date("2025-03-14T12:00:00Z");
        const to = new Date("2025-03-15T18:00:00Z");

        await run(listSessionsNear({ from, to }), layer);

        const { sql, bindings } = captured[0]!;
        expect(sql).toContain("$from");
        expect(sql).toContain("$to");
        expect(bindings!.from).toBe(from);
        expect(bindings!.to).toBe(to);
    });

    test("includes repository literal when repositoryKey is provided", async () => {
        const { layer, captured } = makeMockDb();

        await run(
            listSessionsNear({
                from: new Date("2025-03-14T00:00:00Z"),
                to: new Date("2025-03-15T00:00:00Z"),
                repositoryKey: "remote__github_com_foo_bar__abc123",
            }),
            layer,
        );

        const { sql: nearSql, bindings: nearBindings } = captured[0]!;
        // Record literal must be embedded in SQL - NOT a binding
        expect(nearSql).toContain("AND repository = repository:`remote__github_com_foo_bar__abc123`");
        expect(nearSql).not.toContain("$repository");
        expect(nearBindings?.["repository"]).toBeUndefined();
    });

    test("omits repository WHERE filter when repositoryKey is null", async () => {
        const { layer, captured } = makeMockDb();

        await run(
            listSessionsNear({
                from: new Date(),
                to: new Date(),
                repositoryKey: null,
            }),
            layer,
        );

        // SELECT projection always has "repository" column; WHERE must not have it
        expect(captured[0]!.sql).not.toContain("AND repository");
    });

    test("orders by started_at DESC", async () => {
        const { layer, captured } = makeMockDb();
        await run(listSessionsNear({ from: new Date(), to: new Date() }), layer);
        expect(captured[0]!.sql).toContain("ORDER BY started_at DESC");
    });
});
