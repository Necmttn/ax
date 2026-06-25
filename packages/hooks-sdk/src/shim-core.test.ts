import { describe, expect, test } from "bun:test";
import {
    withForwardedEnv,
    isDaemonOutcome,
    hookEvalUrl,
    FORWARDED_ENV_KEYS,
} from "./shim-core.ts";

const EVENT = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Edit" });

describe("withForwardedEnv", () => {
    test("injects only set allowlist keys as _ax_env", () => {
        const out = JSON.parse(withForwardedEnv(EVENT, { ALLOW_MAIN_WRITE: "1", IRRELEVANT: "x" }));
        expect(out._ax_env).toEqual({ ALLOW_MAIN_WRITE: "1" });
        expect(out.tool_name).toBe("Edit");
    });

    test("forwards every allowlist key when present", () => {
        const env = Object.fromEntries(FORWARDED_ENV_KEYS.map((k) => [k, "1"]));
        const out = JSON.parse(withForwardedEnv(EVENT, env));
        expect(Object.keys(out._ax_env).sort()).toEqual([...FORWARDED_ENV_KEYS].sort());
    });

    test("returns stdin unchanged when nothing in the allowlist is set", () => {
        expect(withForwardedEnv(EVENT, { PATH: "/bin" })).toBe(EVENT);
    });

    test("passes non-JSON / non-object stdin through untouched (daemon decodes)", () => {
        expect(withForwardedEnv("not json", { ALLOW_MAIN_WRITE: "1" })).toBe("not json");
        expect(withForwardedEnv("[1,2]", { ALLOW_MAIN_WRITE: "1" })).toBe("[1,2]");
    });
});

describe("isDaemonOutcome", () => {
    test("accepts a numeric exitCode body", () => {
        expect(isDaemonOutcome({ exitCode: 2, stderr: "no" })).toBe(true);
        expect(isDaemonOutcome({ exitCode: 0 })).toBe(true);
    });
    test("rejects malformed bodies", () => {
        expect(isDaemonOutcome({ exit: 0 })).toBe(false);
        expect(isDaemonOutcome("nope")).toBe(false);
        expect(isDaemonOutcome(null)).toBe(false);
    });
});

describe("hookEvalUrl", () => {
    test("defaults to 1738, honors explicit port then AX_SERVE_PORT", () => {
        expect(hookEvalUrl({})).toBe("http://127.0.0.1:1738/hooks/eval");
        expect(hookEvalUrl({ AX_SERVE_PORT: "9000" })).toBe("http://127.0.0.1:9000/hooks/eval");
        expect(hookEvalUrl({ AX_SERVE_PORT: "9000" }, "1234")).toBe("http://127.0.0.1:1234/hooks/eval");
    });
});
