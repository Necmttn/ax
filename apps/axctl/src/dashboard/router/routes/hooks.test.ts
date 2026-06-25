import { describe, expect, test } from "bun:test";
import { handleDashboardRequest } from "../../server.ts";

const post = (body: string): Request =>
    new Request("http://127.0.0.1:1738/hooks/eval", { method: "POST", body });

describe("POST /hooks/eval", () => {
    test("a no-guard-match event returns an allow outcome (exit 0)", async () => {
        // Read is not matched by any guard -> merged allow -> { exitCode: 0 }.
        const res = await handleDashboardRequest(
            post(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Read", cwd: "/tmp" })),
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ exitCode: 0 });
    });

    test("fail-open: a garbage body still returns allow (never wedges the agent)", async () => {
        const res = await handleDashboardRequest(post("} not json {"));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ exitCode: 0 });
    });

    test("an empty body is allow", async () => {
        const res = await handleDashboardRequest(post(""));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ exitCode: 0 });
    });

    test("GET /api/version advertises hooks_eval", async () => {
        const res = await handleDashboardRequest(new Request("http://127.0.0.1:1738/api/version"));
        const body = (await res.json()) as { hooks_eval?: boolean };
        expect(body.hooks_eval).toBe(true);
    });
});
