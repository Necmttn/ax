import { describe, expect, test } from "bun:test";
import { collectDoctorReport, formatDoctorReport } from "./install.ts";

describe("doctor includes onboarding harness-tracking checks", () => {
    test("report contains a check whose name starts with 'onboarding:'", () => {
        const report = collectDoctorReport();
        const names = report.checks.map((c) => c.name);
        expect(names.some((n) => n.startsWith("onboarding:"))).toBe(true);
    });

    test("text format lists harness-tracking lines", () => {
        const text = formatDoctorReport(collectDoctorReport(), false);
        expect(text).toContain("onboarding:");
    });
});
