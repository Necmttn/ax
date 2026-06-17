import { describe, expect, test } from "bun:test";
import {
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
