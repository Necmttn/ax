import { describe, expect, test } from "bun:test";
import {
    decodeCompareParams,
    decodeInspectParams,
    decodeSessionsListParams,
} from "./sessions.ts";
import type { RouteInput } from "../router.ts";

const input = (urlStr: string, path: Record<string, string> = {}): RouteInput => ({
    req: new Request(urlStr),
    url: new URL(urlStr),
    path,
    body: { kind: "none" },
});

describe("decodeSessionsListParams", () => {
    test("defaults offset=0 limit=200, omits absent filters", () => {
        expect(decodeSessionsListParams(input("http://h/api/sessions"))).toEqual({
            ok: true,
            value: { offset: 0, limit: 200 },
        });
    });

    test("carries source/project/offset when present", () => {
        const d = decodeSessionsListParams(
            input("http://h/api/sessions?source=claude&project=ax&offset=10"),
        );
        expect(d).toEqual({
            ok: true,
            value: { offset: 10, limit: 200, source: "claude", project: "ax" },
        });
    });
});

describe("decodeCompareParams", () => {
    test("splits ids, trims, requires >= 2, turns=1 maps includeTurns true", () => {
        const d = decodeCompareParams(input("http://h/api/sessions/compare?ids=a,%20b&turns=1"));
        expect(d).toEqual({ ok: true, value: { ids: ["a", "b"], includeTurns: true } });
    });

    test("fewer than 2 ids -> legacy 400 message", () => {
        const d = decodeCompareParams(input("http://h/api/sessions/compare?ids=a"));
        expect(d).toMatchObject({
            ok: false,
            status: 400,
            body: { error: "need at least 2 session ids (ids=a,b)" },
        });
    });
});

describe("decodeInspectParams", () => {
    test("pagination defaults turn_offset=0 turn_limit=100", () => {
        const d = decodeInspectParams(input("http://h/api/sessions/s1/inspect", { id: "s1" }));
        expect(d).toEqual({
            ok: true,
            value: { id: "s1", turnOffset: 0, turnLimit: 100 },
        });
    });

    test("missing id -> 400", () => {
        const d = decodeInspectParams(input("http://h/api/sessions//inspect", { id: "" }));
        expect(d).toMatchObject({ ok: false, status: 400 });
    });
});
