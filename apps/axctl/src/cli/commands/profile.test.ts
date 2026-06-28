import { describe, expect, test } from "bun:test";
import {
    formatProfile,
    profileProgressLine,
    shouldEmitProfileProgress,
} from "./profile.ts";

describe("profile show progress", () => {
    test("emits by default on TTY stderr and stays silent when AX_PROGRESS=off", () => {
        expect(shouldEmitProfileProgress({ stderrIsTTY: true, progressEnv: undefined })).toBe(true);
        expect(shouldEmitProfileProgress({ stderrIsTTY: true, progressEnv: "off" })).toBe(false);
    });

    test("AX_PROGRESS=on/plain force progress for redirected stderr", () => {
        expect(shouldEmitProfileProgress({ stderrIsTTY: false, progressEnv: "on" })).toBe(true);
        expect(shouldEmitProfileProgress({ stderrIsTTY: false, progressEnv: "plain" })).toBe(true);
        expect(shouldEmitProfileProgress({ stderrIsTTY: false, progressEnv: undefined })).toBe(false);
    });

    test("progress lines describe the slow graph-building phase", () => {
        expect(profileProgressLine("env", { windowDays: 14, includeCost: true })).toBe(
            "ax profile show: gathering local environment",
        );
        expect(profileProgressLine("build", { windowDays: 14, includeCost: true })).toBe(
            "ax profile show: building graph profile (window=14d, cost=on)",
        );
        expect(profileProgressLine("done", { windowDays: 14, includeCost: false }, 27040)).toBe(
            "ax profile show: done in 27.0s",
        );
    });
});

describe("formatProfile guardrail receipts", () => {
    test("renders hook receipt lines and honest verdict labels", () => {
        const out = formatProfile({
            v: 1,
            github: "octocat",
            generated_at: "2026-06-18T00:00:00Z",
            window_days: 30,
            stats: {
                sessions: 1,
                active_days: 1,
                streak_days: 1,
                tokens: { prompt: 1, completion: 1, total: 2 },
                models: [],
                harnesses: ["claude"],
            },
            rig: {
                skills: [],
                hooks: ["enforce-worktree"],
                routing_table: false,
            },
            guardrail_receipts: {
                hooks: [
                    { name: "enforce-worktree", fires: 412, blocked: 9, warned: 3 },
                ],
                verdicts: {
                    worked: 4,
                    did_not_work: 2,
                    partial: 1,
                    no_longer_needed: 1,
                },
            },
        });

        expect(out).toContain("guardrails:");
        expect(out).toContain("enforce-worktree");
        expect(out).toContain("fired 412x");
        expect(out).toContain("blocked 9");
        expect(out).toContain("still earning");
        expect(out).toContain("4 worked");
        expect(out).toContain("2 didn't");
        expect(out).toContain("1 partial");
        expect(out).toContain("1 no longer needed (resolved or never fired)");
    });
});
