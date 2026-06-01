import { describe, expect, test } from "bun:test";
import { buildEventWindows, type ClassifierTurnRow } from "./event-window.ts";

const row = (
    overrides: Partial<ClassifierTurnRow> & Pick<ClassifierTurnRow, "id" | "session" | "seq" | "role" | "text">,
): ClassifierTurnRow => {
    const base: ClassifierTurnRow = {
        id: overrides.id,
        session: overrides.session,
        seq: overrides.seq,
        role: overrides.role,
        message_kind: null,
        text: overrides.text ?? null,
        text_excerpt: overrides.text ?? null,
        ts: new Date(`2026-05-30T00:0${overrides.seq}:00Z`),
    };
    return { ...base, ...overrides };
};

describe("buildEventWindows", () => {
    test("attaches prior assistant and recent tool failure to user windows", () => {
        const windows = buildEventWindows([
            row({ id: "turn:a1", session: "session:s1", seq: 1, role: "assistant", text: "I used pip." }),
            row({
                id: "turn:t1",
                session: "session:s1",
                seq: 2,
                role: "tool_result",
                message_kind: "tool_result",
                text: "ERROR: dependency resolution failed",
            }),
            row({ id: "turn:u1", session: "session:s1", seq: 3, role: "user", text: "can you use UV ?" }),
        ]);

        expect(windows).toHaveLength(1);
        expect(windows[0]).toMatchObject({
            subjectType: "event_window",
            subjectId: "u1",
            sessionId: "s1",
        });
        expect(windows[0].userTurn.key).toBe("u1");
        expect(windows[0].previousAssistantTurn?.key).toBe("a1");
        expect(windows[0].recentToolFailures[0]?.text).toContain("dependency resolution failed");
    });
});
