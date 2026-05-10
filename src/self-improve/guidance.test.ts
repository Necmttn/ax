import { describe, expect, test } from "bun:test";
import { buildGuidanceWriteStatements, guidanceFromSignal } from "./guidance.ts";

describe("guidance", () => {
    test("guidanceFromSignal creates inspectable recommendation", () => {
        const guidance = guidanceFromSignal({
            key: "signal__1",
            kind: "missing_verification",
            subjectType: "session",
            subjectId: "session:one",
            text: "Session changed files without verification.",
            metrics: { editCommandCount: 2 },
            evidenceIds: ["session:one:time"],
            ts: "2026-05-10T00:00:00.000Z",
        });
        expect(guidance.status).toBe("proposed");
        expect(guidance.scope).toBe("project");
    });

    test("buildGuidanceWriteStatements writes derived_from relation", () => {
        const statements = buildGuidanceWriteStatements(guidanceFromSignal({
            key: "signal__1",
            kind: "missing_verification",
            subjectType: "session",
            subjectId: "session:one",
            text: "Session changed files without verification.",
            metrics: { editCommandCount: 2 },
            evidenceIds: ["session:one:time"],
            ts: "2026-05-10T00:00:00.000Z",
        }));
        expect(statements.join("\n")).toContain("guidance_version");
        expect(statements.join("\n")).toContain("derived_from");
    });

    test("buildGuidanceWriteStatements upserts artifact stubs for evidence", () => {
        const statements = buildGuidanceWriteStatements(guidanceFromSignal({
            key: "signal__1",
            kind: "missing_verification",
            subjectType: "session",
            subjectId: "session:one",
            text: "Session changed files without verification.",
            metrics: { editCommandCount: 2 },
            evidenceIds: ["session:one:time"],
            ts: "2026-05-10T00:00:00.000Z",
        }));
        const joined = statements.join("\n");
        expect(joined).toContain("UPSERT artifact:");
        expect(joined).toContain('kind: "signal_evidence"');
        expect(joined.indexOf("UPSERT artifact:")).toBeLessThan(joined.indexOf("->derived_from:"));
    });
});
