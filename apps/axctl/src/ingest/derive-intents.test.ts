import { describe, expect, test } from "bun:test";
import { computeIntentChanges, type TurnIntentRow } from "./derive-intents.ts";

function row(partial: Partial<TurnIntentRow> & Pick<TurnIntentRow, "id" | "intent_kind" | "text_excerpt">): TurnIntentRow {
    return {
        role: "user",
        message_kind: "task",
        source: undefined,
        ...partial,
    };
}

describe("computeIntentChanges", () => {
    test("identifies slash-command body misclassified as correction", () => {
        const rows = [
            row({
                id: "turn:slashcmd",
                intent_kind: "correction",
                text_excerpt: "## Your task\nMonitor the staging deploy. Do NOT make the user wait 10 minutes.",
            }),
        ];
        const summary = computeIntentChanges(rows);
        expect(summary.changed).toBe(1);
        expect(summary.changes[0]!).toMatchObject({
            id: "turn:slashcmd",
            from: "correction",
            to: "wrapper_instruction",
        });
    });

    test("keeps a real correction untouched", () => {
        const rows = [
            row({
                id: "turn:real",
                intent_kind: "correction",
                text_excerpt: "no don't mock the DB, last time it masked the migration bug",
            }),
        ];
        const summary = computeIntentChanges(rows);
        expect(summary.changed).toBe(0);
    });

    test("reports transitions grouped", () => {
        const rows = [
            row({ id: "turn:1", intent_kind: "correction", text_excerpt: "## Your task\nlong wrapper" }),
            row({ id: "turn:2", intent_kind: "correction", text_excerpt: "# /review\nlong wrapper" }),
            row({ id: "turn:3", intent_kind: "preference", text_excerpt: "add a new flag" }),
        ];
        const summary = computeIntentChanges(rows);
        expect(summary.changed).toBe(3);
        expect(summary.byTransition["correction -> wrapper_instruction"]).toBe(2);
        expect(summary.byTransition["preference -> organic_task"]).toBe(1);
    });

    test("counts considered rows even when unchanged", () => {
        const rows = [
            row({ id: "turn:1", intent_kind: "organic_task", text_excerpt: "add a new endpoint" }),
            row({ id: "turn:2", intent_kind: "preference", text_excerpt: "i wanna add X" }),
        ];
        const summary = computeIntentChanges(rows);
        expect(summary.considered).toBe(2);
        expect(summary.changed).toBe(0);
    });
});
