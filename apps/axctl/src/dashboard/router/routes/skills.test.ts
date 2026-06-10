import { describe, expect, test } from "bun:test";
import {
    decodeBulkDecisionParams,
    decodeSkillDecisionParams,
    decodeSkillOpenParams,
    skillRoutes,
} from "./skills.ts";
import { matchRoute, type RouteInput } from "../router.ts";

const input = (body: RouteInput["body"], path: Record<string, string> = { name: "tdd" }): RouteInput => ({
    req: new Request("http://h/api/skills/tdd/decide", { method: "POST" }),
    url: new URL("http://h/api/skills/tdd/decide"),
    path,
    body,
});

describe("decodeSkillDecisionParams", () => {
    test("valid decision + trimmed reason", () => {
        const d = decodeSkillDecisionParams(input({ kind: "json", value: { decision: "archive", reason: "  unused  " } }));
        expect(d).toEqual({ ok: true, value: { name: "tdd", decision: "archive", reason: "unused" } });
    });

    test("non-string / empty reason normalizes to null (legacy leniency)", () => {
        const d = decodeSkillDecisionParams(input({ kind: "json", value: { decision: "keep", reason: 7 } }));
        expect(d).toEqual({ ok: true, value: { name: "tdd", decision: "keep", reason: null } });
    });

    test("bad decision -> legacy 400 message", () => {
        const d = decodeSkillDecisionParams(input({ kind: "json", value: { decision: "yolo" } }));
        expect(d).toMatchObject({ ok: false, status: 400, body: { error: "decision must be one of keep|archive|review" } });
    });

    test("invalid JSON -> 400 invalid_json", () => {
        expect(decodeSkillDecisionParams(input({ kind: "invalid" }))).toMatchObject({
            ok: false, status: 400, body: { error: "invalid_json" },
        });
    });
});

describe("decodeBulkDecisionParams", () => {
    test("filters non-string names, requires at least one", () => {
        const d = decodeBulkDecisionParams(input({ kind: "json", value: { names: ["a", 3, ""], decision: "review" } }, {}));
        expect(d).toEqual({ ok: true, value: { names: ["a"], decision: "review", reason: null } });
    });

    test("empty names array -> legacy 400 message", () => {
        const d = decodeBulkDecisionParams(input({ kind: "json", value: { names: [], decision: "keep" } }, {}));
        expect(d).toMatchObject({ ok: false, status: 400, body: { error: "names must be a non-empty array of skill names" } });
    });
});

describe("decodeSkillOpenParams", () => {
    test("finder/editor accepted via Schema.Literals", () => {
        const d = decodeSkillOpenParams(input({ kind: "json", value: { target: "editor" } }));
        expect(d).toEqual({ ok: true, value: { name: "tdd", target: "editor" } });
    });

    test("anything else -> legacy 400 message", () => {
        const d = decodeSkillOpenParams(input({ kind: "json", value: { target: "terminal" } }));
        expect(d).toMatchObject({ ok: false, status: 400, body: { error: "target must be 'finder' or 'editor'" } });
    });
});

describe("skillRoutes method behavior", () => {
    test("legacy list GET routes fall through on wrong method", () => {
        expect(matchRoute(skillRoutes, "POST", "/api/skills").kind).toBe("unmatched");
        expect(matchRoute(skillRoutes, "POST", "/api/decisions").kind).toBe("unmatched");
    });

    test("detail/source GET routes keep the planned wrong-method 405 delta", () => {
        expect(matchRoute(skillRoutes, "POST", "/api/skills/tdd/detail").kind).toBe("method_mismatch");
        expect(matchRoute(skillRoutes, "POST", "/api/skills/tdd/source").kind).toBe("method_mismatch");
    });
});
