import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import {
    classifierEvidenceRefsForWindows,
    deriveAndPersistClassifierResults,
    deriveClassifierResultsFromRows,
} from "./classifier-results.ts";
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

// ---------------------------------------------------------------------------
// Real-DuckDB coverage for the SQL half of this stage.
//
// The pure builders above are fed hand-written `ClassifierEditedFileRow`s, so
// they cannot see whether `fetchEditedFiles` actually PRODUCES those rows. It
// did not: the projection read `e.session` off `edited`, a column the DDL does
// not define (`edited` is a turn->file edge; the session lives on the joined
// `turn`). That is a binder error on every run, and once the column name is
// right the second failure mode is the one this suite pins - a query that runs
// and hands back NULL sessions, which silently drops every `recent_edited_file`
// ref instead of erroring.
// ---------------------------------------------------------------------------
const { dylibPath, dtest, tempDir } = await duckdbTestSetup("classifier results edited files", { requireFts: true });

describe("fetchEditedFiles on real DuckDB", () => {
    dtest("reads the session off the joined turn and links recent edited files", async () => {
        let evidence: ReadonlyArray<{ readonly out_id: string; readonly kind: string | null }> = [];
        await runWithPlatform(publishCacheFixture(tempDir("ax-classifier-edited-"), dylibPath, (write) =>
            Effect.gen(function* () {
                const ts = new Date("2026-05-30T00:01:00Z");
                yield* write.put("session", { id: "s1", source: "claude", started_at: ts });
                yield* write.put("turn", {
                    id: "a1", session: "s1", seq: 1, ts, role: "assistant",
                    text: "I used pip.", text_excerpt: "I used pip.",
                });
                yield* write.put("turn", {
                    id: "t1", session: "s1", seq: 2, ts: new Date("2026-05-30T00:02:00Z"),
                    role: "tool_result", message_kind: "tool_result",
                    text: "ERROR: dependency resolution failed",
                    text_excerpt: "ERROR: dependency resolution failed",
                });
                yield* write.put("turn", {
                    id: "u1", session: "s1", seq: 3, ts: new Date("2026-05-30T00:03:00Z"),
                    role: "user", text: "can you use UV ?", text_excerpt: "can you use UV ?",
                });
                yield* write.put("file", { id: "f1", path: "pyproject.toml" });
                yield* write.put("edited", {
                    id: "e1", in_id: "a1", out_id: "f1", tool: "Edit", ts,
                });

                yield* deriveAndPersistClassifierResults(write, { sinceDays: undefined });

                evidence = yield* write.rows(
                    Schema.Struct({ out_id: Schema.String, kind: Schema.NullOr(Schema.String) }),
                    "SELECT out_id, kind FROM cites_evidence WHERE out_table = 'file' ORDER BY kind",
                );
            }),
        ));
        // `recent_edited_file` is reachable ONLY through the session+seq path,
        // so its presence is proof the `session` column decoded non-null.
        expect(evidence.map((e) => e.kind)).toContain("recent_edited_file");
        expect(evidence.every((e) => e.out_id === "f1")).toBe(true);
    });
});
