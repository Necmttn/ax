import { describe, expect, test } from "bun:test";
import { Effect, Layer, Path } from "effect";
import { AxConfigTest } from "@ax/lib/config";
import { layerTestFileSystem } from "@ax/lib/testing/test-filesystem";
import { makeTestSurrealClient } from "@ax/lib/testing/surreal";
import { ingestTranscripts } from "./transcripts.ts";

// Integration regression for the claude fold onto the shared JSONL work-unit:
// a real `ingestTranscripts` run end-to-end (flat-tree walk -> work-unit ->
// per-file parse/write -> watermark commit), then an identical second run that
// must SKIP every file via the watermark. The test FS `stat` returns a stable
// (mtime=epoch0, size=len), so an unchanged transcript matches its mark.
//
// Stateful fake of `ingest_file_state`: SELECT returns prior commits, UPSERT
// records them. claude_transcript triggers the one-time id-unify migration, so
// the responder also tracks its sentinel row.
function statefulClaudeDb() {
    const marks = new Map<string, { path: string; mtime_ms: number; size: number }>();
    let migrationDone = false;
    return makeTestSurrealClient({
        fallback: (sql) => {
            if (sql.includes("__watermark_migration__")) {
                if (sql.includes("UPSERT")) {
                    migrationDone = true;
                    return [[]];
                }
                return [migrationDone ? [{ id: "sentinel" }] : []];
            }
            if (sql.includes("DELETE") && sql.includes("ingest_file_state")) return [[]];
            if (sql.includes("UPSERT ingest_file_state")) {
                const path = /path: "([^"]*)"/.exec(sql)?.[1];
                const mtime = Number(/mtime_ms: (-?\d+)/.exec(sql)?.[1] ?? "0");
                const size = Number(/size: (-?\d+)/.exec(sql)?.[1] ?? "0");
                if (path) marks.set(path, { path, mtime_ms: mtime, size });
                return [[]];
            }
            if (sql.includes("FROM ingest_file_state")) {
                return [Array.from(marks.values())];
            }
            // skill catalog + all normalized-batch / token / hook writes -> no-op
            return [[]];
        },
    }).layer;
}

const fixture = [
    JSON.stringify({
        type: "user",
        uuid: "u1",
        timestamp: "2026-06-10T09:00:00.000Z",
        cwd: "/Users/x/proj",
        message: { role: "user", content: "fix the ingest bug" },
    }),
    JSON.stringify({
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-06-10T09:00:01.000Z",
        cwd: "/Users/x/proj",
        message: { model: "claude-sonnet-4-5", content: [{ type: "text", text: "done" }] },
    }),
].join("\n");

describe("claude ingest watermark (work-unit fold)", () => {
    test("first run parses the transcript; identical second run skips it", async () => {
        const testFs = layerTestFileSystem({
            "/transcripts/-Users-x-proj/sess.jsonl": fixture,
        });
        const TestLayer = Layer.mergeAll(
            AxConfigTest({ paths: { transcriptsDir: "/transcripts" } }),
            statefulClaudeDb(),
            Path.layer,
        ).pipe(Layer.provideMerge(testFs));

        const run = () => Effect.runPromise(ingestTranscripts().pipe(Effect.provide(TestLayer)));

        const first = await run();
        expect(first.files).toBe(1);
        expect(first.sessions).toBe(1);

        // Same bytes, same stat -> watermark matches -> the work-unit skips it.
        const second = await run();
        expect(second.files).toBe(0);
        expect(second.sessions).toBe(0);
    });
});
