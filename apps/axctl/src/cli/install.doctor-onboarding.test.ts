import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { collectDoctorReport, formatDoctorReport } from "./install.ts";

// Forced-dependency edit: `collectDoctorReport` is now an Effect requiring
// FileSystem + Path (the @effect/platform migration). Run it against the REAL
// Bun-backed layers, exactly as the production CLI does via `withoutDb`.
const BunFsLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);
const runDoctorReport = () =>
    Effect.runPromise(collectDoctorReport().pipe(Effect.provide(BunFsLayer)));

describe("doctor includes onboarding harness-tracking checks", () => {
    test("report contains a check whose name starts with 'onboarding:'", async () => {
        const report = await runDoctorReport();
        const names = report.checks.map((c) => c.name);
        expect(names.some((n) => n.startsWith("onboarding:"))).toBe(true);
    });

    test("text format lists harness-tracking lines", async () => {
        const text = formatDoctorReport(await runDoctorReport(), false);
        expect(text).toContain("onboarding:");
    });
});
