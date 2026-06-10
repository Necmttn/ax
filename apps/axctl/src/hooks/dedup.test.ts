import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeTestSurrealClient, type TestSurrealClient } from "@ax/lib/testing/surreal";
import { buildRecentInjectsQuery, findRecentInjects } from "./dedup.ts";

describe("buildRecentInjectsQuery", () => {
    test("includes the session, inject=true, file_path IN list, and window", () => {
        const sql = buildRecentInjectsQuery({
            sessionRid: "session:abc",
            filePaths: ["src/a.ts", "src/b.ts"],
            windowMinutes: 30,
        });
        expect(sql).toContain("session = session:abc");
        expect(sql).toContain("inject = true");
        expect(sql).toContain("file_path IN ['src/a.ts', 'src/b.ts']");
        expect(sql).toContain("ts >= time::now() - 30m");
    });

    test("rejects file paths that contain single quotes", () => {
        expect(() =>
            buildRecentInjectsQuery({
                sessionRid: "session:abc",
                filePaths: ["x'rm -rf /'"],
                windowMinutes: 30,
            }),
        ).toThrow();
    });
});

describe("findRecentInjects", () => {
    test("returns an empty set when sessionId is missing", async () => {
        const result = await Effect.runPromise(
            findRecentInjects({
                sessionId: undefined,
                filePaths: ["src/a.ts"],
                windowMinutes: 30,
            }).pipe(Effect.provide(neverCalledClient().layer)),
        );
        expect(result.size).toBe(0);
    });

    test("returns an empty set when filePaths is empty", async () => {
        const result = await Effect.runPromise(
            findRecentInjects({
                sessionId: "session:abc",
                filePaths: [],
                windowMinutes: 30,
            }).pipe(Effect.provide(neverCalledClient().layer)),
        );
        expect(result.size).toBe(0);
    });

    test("returns a set of paths from rows whose file_path appears in hook_fire", async () => {
        const tc = makeTestSurrealClient({
            fallback: [[
                { file_path: "src/a.ts" },
                { file_path: "src/a.ts" }, // duplicates collapse
            ]],
        });

        const result = await Effect.runPromise(
            findRecentInjects({
                sessionId: "session:abc",
                filePaths: ["src/a.ts", "src/b.ts"],
                windowMinutes: 30,
            }).pipe(Effect.provide(tc.layer)),
        );

        expect(result.has("src/a.ts")).toBe(true);
        expect(result.has("src/b.ts")).toBe(false);
        expect(result.size).toBe(1);
        expect(tc.captured.at(-1)).toContain("hook_fire");
    });
});

function neverCalledClient(): TestSurrealClient {
    return makeTestSurrealClient({
        fallback: () => {
            throw new Error("query should not have been called");
        },
    });
}
