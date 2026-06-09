import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { editDelta, fetchLocSummary } from "./loc-query.ts";
import { SurrealClient } from "@ax/lib/db";

const layerWith = (rows: ReadonlyArray<Record<string, unknown>>) =>
    Layer.succeed(SurrealClient, {
        query: <T>(_sql: string) => Effect.succeed([rows] as unknown as T),
    } as never);

const layerCapturing = (capture: { sql: string[] }) =>
    Layer.succeed(SurrealClient, {
        query: <T>(sql: string) => {
            capture.sql.push(sql);
            return Effect.succeed([[]] as unknown as T);
        },
    } as never);

describe("editDelta", () => {
    test("Edit counts new lines added and old lines removed", () => {
        const input = JSON.stringify({ old_string: "a\nb", new_string: "a\nb\nc\nd" });
        expect(editDelta("Edit", input)).toEqual({ added: 4, removed: 2 });
    });

    test("Write counts content as all-added", () => {
        const input = JSON.stringify({ content: "x\ny\nz" });
        expect(editDelta("Write", input)).toEqual({ added: 3, removed: 0 });
    });

    test("MultiEdit sums across edits", () => {
        const input = JSON.stringify({
            edits: [
                { old_string: "a", new_string: "a\nb" },
                { old_string: "c\nd", new_string: "c" },
            ],
        });
        expect(editDelta("MultiEdit", input)).toEqual({ added: 3, removed: 3 });
    });

    test("NotebookEdit delete mode removes", () => {
        const input = JSON.stringify({ edit_mode: "delete", new_source: "a\nb" });
        expect(editDelta("NotebookEdit", input)).toEqual({ added: 0, removed: 2 });
    });

    test("empty string contributes nothing", () => {
        expect(editDelta("Edit", JSON.stringify({ old_string: "", new_string: "" }))).toEqual({
            added: 0,
            removed: 0,
        });
    });

    test("malformed or null input is safe", () => {
        expect(editDelta("Edit", "not json")).toEqual({ added: 0, removed: 0 });
        expect(editDelta("Edit", null)).toEqual({ added: 0, removed: 0 });
        expect(editDelta("UnknownTool", JSON.stringify({ content: "a" }))).toEqual({ added: 0, removed: 0 });
    });
});

describe("fetchLocSummary", () => {
    test("aggregates per session, per tool, and totals", async () => {
        const rows = [
            { session: "session:`s1`", source: "claude", name: "Edit", input_json: JSON.stringify({ old_string: "a", new_string: "a\nb\nc" }) },
            { session: "session:`s1`", source: "claude", name: "Write", input_json: JSON.stringify({ content: "x\ny" }) },
            { session: "session:`s2`", source: "codex", name: "Edit", input_json: JSON.stringify({ old_string: "p\nq", new_string: "p" }) },
        ];

        const summary = await Effect.runPromise(
            fetchLocSummary({ kind: "query", terms: ["loc"], limit: 10 }).pipe(Effect.provide(layerWith(rows))),
        );

        expect(summary.totals).toEqual({
            sessions: 2,
            edits: 3,
            linesAdded: 3 + 2 + 1, // s1 Edit(3) + s1 Write(2) + s2 Edit(1)
            linesRemoved: 1 + 0 + 2, // s1 Edit(1) + s1 Write(0) + s2 Edit(2)
            linesChanged: 9,
        });
        const s1 = summary.sessions.find((s) => s.session === "session:`s1`");
        expect(s1).toMatchObject({ edits: 2, linesAdded: 5, linesRemoved: 1, source: "claude" });
        const editTool = summary.byTool.find((t) => t.tool === "Edit");
        expect(editTool).toMatchObject({ edits: 2, linesAdded: 4, linesRemoved: 3 });
    });

    test("session selector queries by record ref", async () => {
        const capture = { sql: [] as string[] };
        await Effect.runPromise(
            fetchLocSummary({ kind: "session", sessionId: "s1" }).pipe(Effect.provide(layerCapturing(capture))),
        );
        expect(capture.sql[0]).toContain("session = session:`s1`");
        expect(capture.sql[0]).toContain('name IN ["Edit", "Write", "MultiEdit", "NotebookEdit"]');
    });

    test("empty result yields zeroed totals", async () => {
        const summary = await Effect.runPromise(
            fetchLocSummary({ kind: "query", terms: [], limit: 5 }).pipe(Effect.provide(layerWith([]))),
        );
        expect(summary.totals.sessions).toBe(0);
        expect(summary.totals.linesChanged).toBe(0);
        expect(summary.sessions).toEqual([]);
    });
});
