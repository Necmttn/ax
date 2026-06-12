import { describe, expect, test } from "bun:test";
import { decodeGraphExplorerParams, insightRoutes } from "./insights.ts";
import { matchRoute } from "../router.ts";
import type { RouteInput } from "../router.ts";

const input = (urlStr: string, path: Record<string, string> = {}): RouteInput => ({
    req: new Request(urlStr),
    url: new URL(urlStr),
    path,
    body: { kind: "none" },
});

describe("insightRoutes", () => {
    test("only graph-explorer remains in the legacy table (rest is contract-served)", () => {
        expect(insightRoutes.length).toBe(1);
        expect(matchRoute(insightRoutes, "GET", "/api/graph-explorer").kind).toBe("matched");
        expect(matchRoute(insightRoutes, "GET", "/api/recall").kind).toBe("unmatched");
        expect(matchRoute(insightRoutes, "GET", "/api/wrapped").kind).toBe("unmatched");
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
