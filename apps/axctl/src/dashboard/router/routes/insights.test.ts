import { describe, expect, test } from "bun:test";
import {
    decodeGraphExplorerParams,
    decodeRecallParams,
    decodeSkillGraphParams,
} from "./insights.ts";
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
