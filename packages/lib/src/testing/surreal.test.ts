import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { RecordId } from "surrealdb";
import { DbError } from "../errors.ts";
import { makeTestSurrealClient } from "./surreal.ts";

const runQuery = (
    tc: ReturnType<typeof makeTestSurrealClient>,
    sql: string,
    bindings?: Record<string, unknown>,
) => Effect.runPromise(tc.client.query(sql, bindings));

describe("makeTestSurrealClient - query routing", () => {
    test("default response is [[]] and SQL is captured", async () => {
        const tc = makeTestSurrealClient();
        const rows = await runQuery(tc, "SELECT * FROM session");
        expect(rows).toEqual([[]]);
        expect(tc.captured).toEqual(["SELECT * FROM session"]);
    });

    test("record routes match by substring in insertion order", async () => {
        const tc = makeTestSurrealClient({
            routes: {
                "FROM repository": [[{ id: "repository:`r1`" }]],
                "FROM commit": [["commit:`c1`"]],
            },
        });
        expect(await runQuery(tc, "SELECT * FROM repository WHERE x")).toEqual([
            [{ id: "repository:`r1`" }],
        ]);
        expect(await runQuery(tc, "SELECT * FROM commit")).toEqual([["commit:`c1`"]]);
        expect(await runQuery(tc, "SELECT * FROM turn")).toEqual([[]]);
    });

    test("first matching route wins when several match", async () => {
        const tc = makeTestSurrealClient({
            routes: {
                __sentinel__: [["sentinel"]],
                SELECT: [["generic"]],
            },
        });
        expect(await runQuery(tc, "SELECT __sentinel__")).toEqual([["sentinel"]]);
        expect(await runQuery(tc, "SELECT other")).toEqual([["generic"]]);
    });

    test("regex routes and dynamic (sql, bindings) handlers work", async () => {
        const tc = makeTestSurrealClient({
            routes: [
                {
                    match: /^SELECT/,
                    rows: (sql, bindings) => [[{ sql, name: bindings?.["name"] }]],
                },
            ],
        });
        const rows = await runQuery(tc, "SELECT thing", { name: "tdd" });
        expect(rows).toEqual([[{ sql: "SELECT thing", name: "tdd" }]]);
        expect(tc.calls).toEqual([
            { sql: "SELECT thing", bindings: { name: "tdd" } },
        ]);
    });

    test("a route may return an Effect to inject a DbError failure", async () => {
        const tc = makeTestSurrealClient({
            routes: {
                "FROM broken": Effect.fail(
                    new DbError({ operation: "query", message: "boom" }),
                ),
            },
        });
        await expect(runQuery(tc, "SELECT * FROM broken")).rejects.toThrow("boom");
    });

    test("a throwing fallback guards never-called clients", async () => {
        const tc = makeTestSurrealClient({
            fallback: () => {
                throw new Error("query should not have been called");
            },
        });
        await expect(runQuery(tc, "SELECT 1")).rejects.toThrow(
            "query should not have been called",
        );
    });
});

describe("makeTestSurrealClient - sequenced responses", () => {
    test("responses answer by call index; exhaustion falls back to [[]]", async () => {
        const tc = makeTestSurrealClient({
            responses: [[["first"]], [["second"]]],
        });
        expect(await runQuery(tc, "q1")).toEqual([["first"]]);
        expect(await runQuery(tc, "q2")).toEqual([["second"]]);
        expect(await runQuery(tc, "q3")).toEqual([[]]);
    });

    test("routes take precedence but still consume the call index", async () => {
        const tc = makeTestSurrealClient({
            routes: { routed: [["routed"]] },
            responses: [[["pos0"]], [["pos1"]]],
        });
        expect(await runQuery(tc, "routed call")).toEqual([["routed"]]);
        // Second call is index 1 → responses[1], keeping positional fixtures
        // aligned with production call order.
        expect(await runQuery(tc, "plain call")).toEqual([["pos1"]]);
    });
});

describe("makeTestSurrealClient - writes", () => {
    test("upsert records its arguments and succeeds", async () => {
        const tc = makeTestSurrealClient();
        const id = new RecordId("skill", "tdd");
        await Effect.runPromise(tc.client.upsert(id, { name: "tdd" }));
        expect(tc.upserts).toEqual([{ id, content: { name: "tdd" } }]);
    });

    test("relate/putFile are no-ops and getFile resolves ''", async () => {
        const tc = makeTestSurrealClient();
        await Effect.runPromise(
            tc.client.relate(new RecordId("a", "1"), new RecordId("edge", "e"), new RecordId("b", "2"), { w: 1 }),
        );
        await Effect.runPromise(tc.client.putFile("b", "x.jsonl", "line1"));
        expect(await Effect.runPromise(tc.client.getFile("b", "x.jsonl"))).toBe("");
    });
});
