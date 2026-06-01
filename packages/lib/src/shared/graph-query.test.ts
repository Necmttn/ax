import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient, type SurrealClientShape } from "../db.ts";
import { DbError } from "../errors.ts";
import {
    interpolateRid,
    queryMany,
    queryOptional,
    queryPagedWithCount,
} from "./graph-query.ts";

/** Builds a fake SurrealClient that yields `result` from `query` (or fails
 *  with `DbError` when `result` is an Error). Captures the SQL/bindings the
 *  helper passed so tests can assert on them. */
function fakeClient(result: unknown, capture?: { sql?: string; bindings?: unknown }): SurrealClientShape {
    return {
        query: <T extends unknown[]>(sql: string, bindings?: Record<string, unknown>) =>
            Effect.suspend(() => {
                if (capture) {
                    capture.sql = sql;
                    capture.bindings = bindings;
                }
                if (result instanceof Error) {
                    return Effect.fail(
                        new DbError({ operation: "query", message: result.message }),
                    );
                }
                return Effect.succeed(result as T);
            }),
        upsert: () => Effect.void,
        relate: () => Effect.void,
        putFile: () => Effect.void,
        getFile: () => Effect.succeed(""),
        raw: {} as never,
    };
}

const provideClient = (client: SurrealClientShape) =>
    Effect.provide(Layer.succeed(SurrealClient, client));

let consoleErrorSpy: ReturnType<typeof mock>;
let originalConsoleError: typeof console.error;

beforeEach(() => {
    originalConsoleError = console.error;
    consoleErrorSpy = mock(() => {});
    console.error = consoleErrorSpy as unknown as typeof console.error;
});

afterEach(() => {
    console.error = originalConsoleError;
});

describe("queryOptional", () => {
    test("returns mapped value when a row exists", async () => {
        const client = fakeClient([[{ name: "alice" }]]);
        const result = await Effect.runPromise(
            queryOptional<{ name: string }, string>(
                "SELECT name FROM person LIMIT 1;",
                (row) => row.name.toUpperCase(),
                "test:get-name",
            ).pipe(provideClient(client)),
        );
        expect(result).toBe("ALICE");
    });

    test("returns null when the result set is empty", async () => {
        const client = fakeClient([[]]);
        const result = await Effect.runPromise(
            queryOptional<{ name: string }, string>(
                "SELECT name FROM person WHERE name = 'nobody' LIMIT 1;",
                (row) => row.name,
                "test:get-name-empty",
            ).pipe(provideClient(client)),
        );
        expect(result).toBeNull();
    });

    test("returns null and logs context on DB error", async () => {
        const client = fakeClient(new Error("connection refused"));
        const result = await Effect.runPromise(
            queryOptional<{ name: string }, string>(
                "SELECT name FROM person LIMIT 1;",
                (row) => row.name,
                "test:db-error",
            ).pipe(provideClient(client)),
        );
        expect(result).toBeNull();
        expect(consoleErrorSpy).toHaveBeenCalled();
        // First arg is the prefixed message including the context label.
        const firstCall = consoleErrorSpy.mock.calls[0]!;
        expect(firstCall[0]).toContain("test:db-error");
    });

    test("forwards bindings to the SDK", async () => {
        const capture: { sql?: string; bindings?: unknown } = {};
        const client = fakeClient([[{ name: "bob" }]], capture);
        await Effect.runPromise(
            queryOptional<{ name: string }, string>(
                "SELECT name FROM person WHERE id = $id LIMIT 1;",
                (row) => row.name,
                "test:bindings",
                { id: "person:bob" },
            ).pipe(provideClient(client)),
        );
        expect(capture.bindings).toEqual({ id: "person:bob" });
    });
});

describe("queryMany", () => {
    test("maps every row and exposes the index", async () => {
        const client = fakeClient([
            [{ v: "a" }, { v: "b" }, { v: "c" }],
        ]);
        const result = await Effect.runPromise(
            queryMany<{ v: string }, string>(
                "SELECT v FROM thing;",
                (row, idx) => `${idx}:${row.v}`,
                "test:many",
            ).pipe(provideClient(client)),
        );
        expect(result).toEqual(["0:a", "1:b", "2:c"]);
    });

    test("returns [] on empty result set", async () => {
        const client = fakeClient([[]]);
        const result = await Effect.runPromise(
            queryMany<{ v: string }, string>(
                "SELECT v FROM nothing;",
                (row) => row.v,
                "test:many-empty",
            ).pipe(provideClient(client)),
        );
        expect(result).toEqual([]);
    });

    test("returns [] and logs context on DB error", async () => {
        const client = fakeClient(new Error("query timeout"));
        const result = await Effect.runPromise(
            queryMany<{ v: string }, string>(
                "SELECT v FROM thing;",
                (row) => row.v,
                "test:many-error",
            ).pipe(provideClient(client)),
        );
        expect(result).toEqual([]);
        expect(consoleErrorSpy).toHaveBeenCalled();
        expect(consoleErrorSpy.mock.calls[0]![0]).toContain("test:many-error");
    });

    test("mapper exceptions propagate (programmer error, not runtime degradation)", async () => {
        const client = fakeClient([[{ v: "ok" }]]);
        await expect(
            Effect.runPromise(
                queryMany<{ v: string }, string>(
                    "SELECT v FROM thing;",
                    () => { throw new Error("mapper bug"); },
                    "test:mapper-throws",
                ).pipe(provideClient(client)),
            ),
        ).rejects.toThrow(/mapper bug/);
    });
});

describe("queryPagedWithCount", () => {
    test("returns items + total from a two-statement page+count result", async () => {
        const client = fakeClient([
            [{ id: 1 }, { id: 2 }],
            [{ total: 42 }],
        ]);
        const result = await Effect.runPromise(
            queryPagedWithCount<{ id: number }, { total: number }, number>(
                "SELECT id FROM x START 0 LIMIT 2; SELECT count() AS total FROM x GROUP ALL;",
                (row) => row.id,
                (row) => row.total,
            ).pipe(provideClient(client)),
        );
        expect(result.items).toEqual([1, 2]);
        expect(result.total).toBe(42);
    });

    test("missing count row degrades total to 0", async () => {
        const client = fakeClient([
            [{ id: 1 }],
            [], // empty count tuple - GROUP ALL on empty filter set
        ]);
        const result = await Effect.runPromise(
            queryPagedWithCount<{ id: number }, { total: number }, number>(
                "...",
                (row) => row.id,
                (row) => row.total,
            ).pipe(provideClient(client)),
        );
        expect(result.items).toEqual([1]);
        expect(result.total).toBe(0);
    });

    test("non-finite count coerces to 0", async () => {
        const client = fakeClient([[], [{ total: Number.NaN }]]);
        const result = await Effect.runPromise(
            queryPagedWithCount<{ id: number }, { total: number }, number>(
                "...",
                (row) => row.id,
                (row) => row.total,
            ).pipe(provideClient(client)),
        );
        expect(result.total).toBe(0);
    });

    test("DB errors propagate as DbError (not swallowed)", async () => {
        const client = fakeClient(new Error("rocksdb deadlock"));
        const program = queryPagedWithCount<{ id: number }, { total: number }, number>(
            "...",
            (row) => row.id,
            (row) => row.total,
        ).pipe(provideClient(client));
        await expect(Effect.runPromise(program)).rejects.toThrow(/rocksdb deadlock/);
    });
});

import { runQuery, runSingleQuery } from "./graph-query.ts";
import { defineQuery, defineSingleQuery } from "./query.ts";

const clientReturning = (rows: unknown[]): SurrealClientShape => ({
    query: <T extends unknown[]>() => Effect.succeed([rows] as unknown as T),
    upsert: () => Effect.void,
    relate: () => Effect.void,
    putFile: () => Effect.void,
    getFile: () => Effect.succeed(""),
    raw: {} as never,
});

const run = (eff: Effect.Effect<unknown, unknown, SurrealClient>, c: SurrealClientShape) =>
    Effect.runPromise(eff.pipe(Effect.provideService(SurrealClient, c)));

const demo = defineQuery({
    name: "demo",
    sql: () => "SELECT * FROM x;",
    mapRow: (row) => String(row.id ?? ""),
});

describe("runQuery", () => {
    test("maps every row", async () => {
        const out = await run(runQuery(demo, {}), clientReturning([{ id: 1 }, { id: 2 }]));
        expect(out).toEqual(["1", "2"]);
    });
    test("DB error degrades to []", async () => {
        const failing: SurrealClientShape = {
            ...clientReturning([]),
            query: <T extends unknown[]>(_sql: string, _bindings?: Record<string, unknown>): Effect.Effect<T, DbError> =>
                Effect.fail(new DbError({ operation: "query", message: "boom" })) as Effect.Effect<T, DbError>,
        };
        const out = await run(runQuery(demo, {}), failing);
        expect(out).toEqual([]);
    });
});

describe("runSingleQuery", () => {
    test("returns mapped first row or null", async () => {
        const one = defineSingleQuery({
            name: "demo1",
            sql: () => "SELECT * FROM x LIMIT 1;",
            mapRow: (row) => String(row.id ?? ""),
        });
        expect(await run(runSingleQuery(one, {}), clientReturning([{ id: 9 }]))).toBe("9");
        expect(await run(runSingleQuery(one, {}), clientReturning([]))).toBe(null);
    });
    test("DB error degrades to null", async () => {
        const one = defineSingleQuery({
            name: "demo1",
            sql: () => "SELECT * FROM x LIMIT 1;",
            mapRow: (row) => String(row.id ?? ""),
        });
        const failing: SurrealClientShape = {
            ...clientReturning([]),
            query: <T extends unknown[]>() =>
                Effect.fail(new DbError({ operation: "query", message: "boom" })) as Effect.Effect<T, DbError>,
        };
        expect(await run(runSingleQuery(one, {}), failing)).toBe(null);
    });
});

describe("interpolateRid", () => {
    test("replaces $sid with the wrapped record-id form", () => {
        // UUIDs need backtick wrapping (contain hyphens).
        const sql = interpolateRid(
            "SELECT * FROM spawned WHERE out = $sid LIMIT 1;",
            "019e2531-b552-7b53-a029-c780adbb6560",
        );
        expect(sql).toBe(
            "SELECT * FROM spawned WHERE out = session:`019e2531-b552-7b53-a029-c780adbb6560` LIMIT 1;",
        );
    });

    test("replaces every occurrence (not just the first)", () => {
        const sql = interpolateRid(
            "SELECT a FROM t WHERE x = $sid OR y = $sid;",
            "abc_123",
        );
        // abc_123 is unquoted-safe (alphanumeric + underscore).
        expect(sql).toBe(
            "SELECT a FROM t WHERE x = session:abc_123 OR y = session:abc_123;",
        );
    });

    test("custom placeholder respected", () => {
        const sql = interpolateRid(
            "SELECT * FROM x WHERE id = $parentId;",
            "abc_123",
            "$parentId",
        );
        expect(sql).toBe("SELECT * FROM x WHERE id = session:abc_123;");
    });

    test("synthetic subagent id (with hyphens) gets backtick-wrapped", () => {
        const sql = interpolateRid(
            "SELECT * FROM session WHERE id = $sid;",
            "claude-subagent-a1f6ef32d7aefc7b9",
        );
        expect(sql).toContain("session:`claude-subagent-a1f6ef32d7aefc7b9`");
    });
});
