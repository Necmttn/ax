import { describe, expect, test } from "bun:test";
import { decodeImproveActionParams, improveHttpStatus, improveRoutes } from "./improve.ts";
import { matchRoute, type RouteInput } from "../router.ts";

const input = (path: Record<string, string>, body: RouteInput["body"]): RouteInput => ({
    req: new Request("http://h/api/improve/sig1/accept", { method: "POST" }),
    url: new URL("http://h/api/improve/sig1/accept"),
    path,
    body,
});

describe("decodeImproveActionParams", () => {
    test("accept carries force flag", () => {
        const d = decodeImproveActionParams(input({ sig: "s1", action: "accept" }, { kind: "json", value: { force: true } }));
        expect(d).toEqual({ ok: true, value: { sig: "s1", action: "accept", force: true, reason: undefined, verdict: "" } });
    });

    test("invalid JSON body is treated as empty (legacy: empty body ok)", () => {
        const d = decodeImproveActionParams(input({ sig: "s1", action: "verdict" }, { kind: "invalid" }));
        expect(d).toEqual({ ok: true, value: { sig: "s1", action: "verdict", force: false, reason: undefined, verdict: "" } });
    });

    test("unknown action -> 404 (behavioral delta 4)", () => {
        const d = decodeImproveActionParams(input({ sig: "s1", action: "explode" }, { kind: "json", value: {} }));
        expect(d).toMatchObject({ ok: false, status: 404, body: { error: "unknown_improve_action" } });
    });

    test("missing sig -> legacy 400 message", () => {
        const d = decodeImproveActionParams(input({ sig: "", action: "accept" }, { kind: "json", value: {} }));
        expect(d).toMatchObject({ ok: false, status: 400, body: { error: "missing proposal sig" } });
    });
});

describe("improveHttpStatus (verbatim status map from server.ts 224-228)", () => {
    test("maps every known status", () => {
        expect(improveHttpStatus("ok")).toBe(200);
        expect(improveHttpStatus("not_found")).toBe(404);
        expect(improveHttpStatus("wrong_status")).toBe(409);
        expect(improveHttpStatus("scaffold_exists")).toBe(409);
        expect(improveHttpStatus("verdict_locked")).toBe(409);
        expect(improveHttpStatus("unsupported_form")).toBe(400);
        expect(improveHttpStatus("missing_payload")).toBe(400);
        expect(improveHttpStatus("invalid_verdict")).toBe(400);
        expect(improveHttpStatus("anything_else")).toBe(500);
    });
});

describe("/api/next-actions", () => {
    test("GET matches and decodes", () => {
        const match = matchRoute(improveRoutes, "GET", "/api/next-actions");
        expect(match).not.toBeNull();
        expect(match.kind).toBe("matched");
    });
});
