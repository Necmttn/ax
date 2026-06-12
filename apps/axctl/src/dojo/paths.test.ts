// apps/axctl/src/dojo/paths.test.ts
import { describe, expect, test } from "bun:test";
import { dojoOutboxDir, dojoReportPath, dojoReportsDir } from "./paths.ts";

describe("dojo paths", () => {
    test("derive from an injectable base dir", () => {
        expect(dojoOutboxDir("/tmp/axhome/.ax/dojo")).toBe("/tmp/axhome/.ax/dojo/outbox");
        expect(dojoReportsDir("/tmp/axhome/.ax/dojo")).toBe("/tmp/axhome/.ax/dojo/reports");
        expect(dojoReportPath("2026-06-13", "/tmp/axhome/.ax/dojo")).toBe(
            "/tmp/axhome/.ax/dojo/reports/2026-06-13.md",
        );
    });

    test("default base ends with /.ax/dojo", () => {
        expect(dojoOutboxDir()).toMatch(/\/\.ax\/dojo\/outbox$/);
    });
});
