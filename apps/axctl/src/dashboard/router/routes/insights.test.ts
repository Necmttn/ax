import { describe, expect, test } from "bun:test";
import {
    decodeGraphExplorerParams,
    decodeRecallParams,
    decodeSkillGraphParams,
    insightRoutes,
} from "./insights.ts";
import { matchRoute } from "../router.ts";
import type { RouteInput } from "../router.ts";

const input = (urlStr: string, path: Record<string, string> = {}): RouteInput => ({
    req: new Request(urlStr),
    url: new URL(urlStr),
    path,
    body: { kind: "none" },
});

describe("decodeRecallParams", () => {
    test("defaults: offset 0, limit 50, null filters", () => {
        const d = decodeRecallParams(input("http://h/api/recall?q=hello"));
        expect(d).toEqual({
            ok: true,
            value: {
                q: "hello",
                project: null,
                skill: null,
                since: null,
                offset: 0,
                limit: 50,
            },
        });
    });

    test("missing q decodes to empty string (handler short-circuits)", () => {
        const d = decodeRecallParams(input("http://h/api/recall"));
        if (d.ok) expect(d.value.q).toBe("");
        expect(d.ok).toBe(true);
    });
});

describe("decodeSkillGraphParams", () => {
    test("finite minCount/limit pass through; garbage dropped", () => {
        const d = decodeSkillGraphParams(input("http://h/api/skill-graph?minCount=2&limit=abc"));
        expect(d).toEqual({ ok: true, value: { minCount: 2 } });
    });
});

describe("decodeGraphExplorerParams", () => {
    test("disabled env -> 404 with the legacy error body", () => {
        const d = decodeGraphExplorerParams(input("http://h/api/graph-explorer"), {});
        expect(d).toMatchObject({
            ok: false,
            status: 404,
            body: { error: "graph_explorer_disabled" },
        });
    });

    test("enabled env decodes mode/q/limit", () => {
        const d = decodeGraphExplorerParams(
            input("http://h/api/graph-explorer?mode=skills&q=x&limit=5"),
            { AX_ENABLE_GRAPH_EXPLORER: "1" },
        );
        expect(d).toEqual({ ok: true, value: { mode: "skills", q: "x", limit: 5 } });
    });
});

describe("GET /api/recall", () => {
    const run = (urlStr: string, runner: (effect: unknown) => Promise<unknown>) => {
        const matched = matchRoute(insightRoutes, "GET", "/api/recall");
        if (matched.kind !== "matched") throw new Error("expected /api/recall to match");
        return matched.match.route.run(input(urlStr), runner as never);
    };

    test("empty q answers without building AppLayer (runner never invoked)", async () => {
        // Same DB-less proof as the /api/version route test: a poisoned
        // runner stands in for appLayerRunner, whose eager SurrealClient
        // build stalls ~5s without a DB (issue #245).
        const res = await run(
            "http://h/api/recall",
            () => Promise.reject(new Error("AppLayer must not be built for empty q")),
        );
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toMatchObject({
            q: "",
            hits: [],
            total_count: 0,
            window: { offset: 0, limit: 50 },
        });
    });

    test("non-empty q still runs through the runner", async () => {
        const sentinel = { q: "hello", hits: [], total_count: 7 };
        const res = await run("http://h/api/recall?q=hello", () => Promise.resolve(sentinel));
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual(sentinel);
    });

    test("non-empty q keeps the legacy 500 error mapping", async () => {
        const res = await run(
            "http://h/api/recall?q=hello",
            () => Promise.reject(new Error("db down")),
        );
        expect(res.status).toBe(500);
        await expect(res.json()).resolves.toEqual({ error: "db down" });
    });
});

describe("insightRoutes method behavior", () => {
    test("migrated legacy GET-only routes fall through on wrong method", () => {
        expect(matchRoute(insightRoutes, "POST", "/api/recall").kind).toBe("unmatched");
    });

    test("tool failure detail keeps the planned wrong-method 405 delta", () => {
        expect(matchRoute(insightRoutes, "PUT", "/api/tool-failures/bash/detail").kind).toBe("method_mismatch");
    });
});
