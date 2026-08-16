import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { publishCacheFixture, readThroughFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { editDelta, fetchLocSummary } from "./loc-query.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("loc-query", { requireFts: true });

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

const SESSIONS = (w: CacheWriteService) =>
    w.putMany("session", [
        { id: "s1", source: "claude", project: "/w/ax", cwd: "/w/ax", started_at: new Date("2026-05-28T00:00:00.000Z") },
        { id: "s2", source: "codex", project: "/w/ax", cwd: "/w/ax", started_at: new Date("2026-05-27T00:00:00.000Z") },
    ]);

const TOOL_CALLS = (w: CacheWriteService) =>
    w.putMany("tool_call", [
        {
            id: "tc1",
            session: "s1",
            name: "Edit",
            ts: new Date("2026-05-28T00:01:00.000Z"),
            input_json: JSON.stringify({ old_string: "a", new_string: "a\nb\nc" }),
        },
        {
            id: "tc2",
            session: "s1",
            name: "Write",
            ts: new Date("2026-05-28T00:02:00.000Z"),
            input_json: JSON.stringify({ content: "x\ny" }),
        },
        {
            id: "tc3",
            session: "s2",
            name: "Edit",
            ts: new Date("2026-05-27T00:01:00.000Z"),
            input_json: JSON.stringify({ old_string: "p\nq", new_string: "p" }),
        },
    ]);

const TURNS = (w: CacheWriteService) =>
    w.putMany("turn", [
        {
            id: "t1",
            session: "s1",
            seq: 1,
            ts: new Date("2026-05-28T00:00:00.000Z"),
            role: "user",
            text_excerpt: "loc rollup investigation",
        },
        {
            id: "t2",
            session: "s2",
            seq: 1,
            ts: new Date("2026-05-27T00:00:00.000Z"),
            role: "user",
            text_excerpt: "unrelated change",
        },
    ]);

const baseFixture = (w: CacheWriteService) =>
    Effect.gen(function* () {
        yield* SESSIONS(w);
        yield* TOOL_CALLS(w);
        yield* TURNS(w);
    });

describe("fetchLocSummary", () => {
    dtest("aggregates per session, per tool, and totals, matched via turn text", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-loc-query-"), dylibPath, baseFixture));

        const summary = await readThroughFixture(
            fixture,
            dylibPath,
            fetchLocSummary({ kind: "query", terms: ["loc"], limit: 10 }),
        );

        expect(summary.totals).toEqual({
            sessions: 1,
            edits: 2,
            linesAdded: 3 + 2,
            linesRemoved: 1 + 0,
            linesChanged: 6,
        });
        const s1 = summary.sessions.find((s) => s.session === "s1");
        expect(s1).toMatchObject({ edits: 2, linesAdded: 5, linesRemoved: 1, source: "claude" });
    });

    dtest("session selector fetches edit rows for one session directly", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-loc-query-session-"), dylibPath, baseFixture));

        const summary = await readThroughFixture(fixture, dylibPath, fetchLocSummary({ kind: "session", sessionId: "s1" }));

        expect(summary.totals).toEqual({ sessions: 1, edits: 2, linesAdded: 5, linesRemoved: 1, linesChanged: 6 });
        const editTool = summary.byTool.find((t) => t.tool === "Edit");
        expect(editTool).toMatchObject({ edits: 1, linesAdded: 3, linesRemoved: 1 });
    });

    dtest("query selector with no terms returns edits across all sessions", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-loc-query-noterm-"), dylibPath, baseFixture));

        const summary = await readThroughFixture(fixture, dylibPath, fetchLocSummary({ kind: "query", terms: [], limit: 5 }));

        expect(summary.totals.sessions).toBe(2);
        expect(summary.totals.edits).toBe(3);
        expect(summary.evidence).toBe("edits across selected sessions");
    });

    dtest("empty database yields zeroed totals", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-loc-query-empty-"), dylibPath, () => Effect.void));

        const summary = await readThroughFixture(fixture, dylibPath, fetchLocSummary({ kind: "query", terms: [], limit: 5 }));

        expect(summary.totals.sessions).toBe(0);
        expect(summary.totals.linesChanged).toBe(0);
        expect(summary.sessions).toEqual([]);
    });
});
