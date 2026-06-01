import { describe, expect, test } from "bun:test";
import { classifierEvidenceRefsForWindows, deriveClassifierResultsFromRows } from "./classifier-results.ts";
import type { ClassifierTurnRow } from "../classifiers/event-window.ts";

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

describe("classifier results derive", () => {
    test("runs registered classifiers over event windows", async () => {
        const result = await deriveClassifierResultsFromRows([
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

        expect(result.windows).toHaveLength(1);
        expect(result.results).toHaveLength(2);
        expect(result.results).toEqual(expect.arrayContaining([
            expect.objectContaining({
            classifierKey: "reaction-event",
            label: "direction",
            target: "environment_setup",
            }),
            expect.objectContaining({
                classifierKey: "direction-event",
                label: "direction",
                target: "tooling_preference",
            }),
        ]));
        const refs = classifierEvidenceRefsForWindows(result.windows, result.results);
        expect(refs).toEqual(expect.arrayContaining([
            expect.objectContaining({
                table: "turn",
                key: "a1",
                kind: "previous_assistant",
            }),
            expect.objectContaining({
                table: "turn",
                key: "t1",
                kind: "recent_tool_failure",
            }),
        ]));
    });

    test("uses canonical tool_call rows as classifier evidence refs", async () => {
        const result = await deriveClassifierResultsFromRows([
            row({ id: "turn:a1", session: "session:s1", seq: 1, role: "assistant", text: "I used pip." }),
            row({ id: "turn:u1", session: "session:s1", seq: 3, role: "user", text: "can you use UV ?" }),
        ], [
            {
                id: "tool_call:tc1",
                session: "session:s1",
                seq: 2,
                name: "Bash",
                command_norm: "pip install sklearn",
                error_text: "dependency resolution failed",
                has_error: true,
                ts: new Date("2026-05-30T00:02:00Z"),
            },
        ]);

        expect(result.results).toEqual(expect.arrayContaining([
            expect.objectContaining({
                classifierKey: "direction-event",
                label: "direction",
                target: "tooling_preference",
            }),
        ]));
        const refs = classifierEvidenceRefsForWindows(result.windows, result.results);
        expect(refs).toEqual(expect.arrayContaining([
            expect.objectContaining({
                table: "tool_call",
                key: "tc1",
                kind: "recent_tool_failure",
            }),
        ]));
    });

    test("links edited files from causal turns as classifier evidence refs", async () => {
        const result = await deriveClassifierResultsFromRows([
            row({ id: "turn:a1", session: "session:s1", seq: 1, role: "assistant", text: "I changed the HTML." }),
            row({ id: "turn:u1", session: "session:s1", seq: 3, role: "user", text: "I don't want just html, I want to see the results." }),
        ]);

        const refs = classifierEvidenceRefsForWindows(result.windows, result.results, [
            {
                turn: "turn:a1",
                file: "file:prototype_html",
                ts: new Date("2026-05-30T00:01:30Z"),
            },
            {
                turn: "turn:t2",
                file: "file:results_view",
                session: "session:s1",
                seq: 2,
                ts: new Date("2026-05-30T00:02:00Z"),
            },
        ]);

        expect(refs).toEqual(expect.arrayContaining([
            expect.objectContaining({
                table: "file",
                key: "prototype_html",
                kind: "previous_assistant_file",
            }),
            expect.objectContaining({
                table: "file",
                key: "results_view",
                kind: "recent_edited_file",
            }),
        ]));
    });
});
