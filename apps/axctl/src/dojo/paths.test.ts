// apps/axctl/src/dojo/paths.test.ts
import { describe, expect, test } from "bun:test";
import { dojoOutboxDir, dojoReportPath, dojoReportsDir, dojoSparBriefPath, dojoSparDir, dojoSparReportPath } from "./paths.ts";

describe("dojo paths", () => {
    test("derive from an injectable base dir", () => {
        expect(dojoOutboxDir("/tmp/axhome/.ax/dojo")).toBe("/tmp/axhome/.ax/dojo/outbox");
        expect(dojoReportsDir("/tmp/axhome/.ax/dojo")).toBe("/tmp/axhome/.ax/dojo/reports");
        expect(dojoReportPath("2026-06-13", "/tmp/axhome/.ax/dojo")).toBe(
            "/tmp/axhome/.ax/dojo/reports/2026-06-13.md",
        );
    });

    test("spar paths derive from an injectable base dir", () => {
        expect(dojoSparDir("/tmp/axhome/.ax/dojo")).toBe("/tmp/axhome/.ax/dojo/spar");
        expect(dojoSparBriefPath("ab12cd34-2026-06-13", "/tmp/axhome/.ax/dojo")).toBe(
            "/tmp/axhome/.ax/dojo/spar/ab12cd34-2026-06-13.md",
        );
        expect(dojoSparReportPath("ab12cd34-2026-06-13", "/tmp/axhome/.ax/dojo")).toBe(
            "/tmp/axhome/.ax/dojo/spar/ab12cd34-2026-06-13-report.md",
        );
    });

    test("default base ends with /.ax/dojo", () => {
        expect(dojoOutboxDir()).toMatch(/\/\.ax\/dojo\/outbox$/);
    });
});
