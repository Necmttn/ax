import { describe, expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { AxConfigTest } from "@ax/lib/config";
import { FixturePlatform, publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { ingestTranscripts } from "./transcripts.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("Claude transcript watermark", { requireFts: true });

const transcript = [
    {
        type: "user",
        uuid: "u1",
        sessionId: "sess",
        timestamp: "2026-06-10T09:00:00.000Z",
        cwd: "/repo",
        message: { role: "user", content: "fix the ingest bug" },
    },
    {
        type: "assistant",
        uuid: "a1",
        sessionId: "sess",
        timestamp: "2026-06-10T09:00:01.000Z",
        cwd: "/repo",
        message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "done" }] },
    },
].map((row) => JSON.stringify(row)).join("\n");

describe("Claude ingest watermark on real DuckDB", () => {
    dtest("the second run skips an unchanged transcript", async () => {
        const transcriptsDir = tempDir("ax-claude-watermark-files-");
        const projectDir = join(transcriptsDir, "-repo");
        await mkdir(projectDir, { recursive: true });
        await Bun.write(join(projectDir, "sess.jsonl"), transcript);
        let first: unknown;
        let second: unknown;
        await runWithPlatform(publishCacheFixture(tempDir("ax-claude-watermark-cache-"), dylibPath, (write) =>
            Effect.gen(function* () {
                const run = ingestTranscripts(write).pipe(
                    Effect.provide(AxConfigTest({ paths: { transcriptsDir } })),
                    Effect.provide(FixturePlatform),
                );
                first = yield* run;
                second = yield* run;
            }),
        ));
        expect(first).toMatchObject({ files: 1, sessions: 1, records: 2 });
        expect(second).toMatchObject({ files: 0, sessions: 0, records: 0 });
    });
});
