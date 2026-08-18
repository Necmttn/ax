import { describe, expect, test } from "bun:test";
import { guidanceFromSignal } from "./guidance.ts";

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
});
