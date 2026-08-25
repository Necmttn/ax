import { describe, expect } from "bun:test";
import { mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { AxConfigTest } from "@ax/lib/config";
import { DuckDbQueryError } from "@ax/lib/duckdb/errors";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { FixturePlatform, publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { ingestCodex } from "./codex.ts";
import { ingestPi } from "./pi.ts";
import { ingestTranscripts } from "./transcripts.ts";

// Regression for #953 follow-up: transcripts.ts/codex.ts/pi.ts each spool
// high-volume tables to a `fs.makeTempDirectory({ prefix: "ax-spool-<provider>-" })`
// scratch dir and used to remove it only after a clean final flush - a failed
// stage (including a failure of the flush itself) leaked the dir, with raw
// turn text sitting on disk outside any ax store. The fix wraps the whole span
// from `makeTempDirectory` through the final flush in `Effect.ensuring`, so
// cleanup runs on every exit path. These tests force the flush's own write to
// fail and assert no `ax-spool-<provider>-*` directory survives on the real
// OS temp root.
const { dylibPath, dtest, tempDir } = await duckdbTestSetup("ingest spool scratch dir cleanup", {
    requireFts: true,
});

const spoolDirsWithPrefix = async (prefix: string): Promise<Set<string>> => {
    const entries = await readdir(tmpdir()).catch(() => [] as string[]);
    return new Set(entries.filter((name) => name.startsWith(prefix)));
};

/**
 * Fail only the spool's aggregated `read_ndjson` load statement (the SQL the
 * spool's `flush` issues via `write.exec` - see spool.ts `loadStatement`), so
 * any buffered table's flush fails while ordinary per-row writes (session,
 * watermark, ...) still succeed. This reproduces the exact "the failure was
 * the flush itself" scenario called out in #953.
 */
const failFlush = (write: CacheWriteService): CacheWriteService =>
    ({
        ...write,
        exec: (sql, params) =>
            sql.includes("read_ndjson(")
                ? Effect.fail(new DuckDbQueryError({ sql, message: "flush rejected (test)" }))
                : write.exec(sql, params),
    });

describe("ingest spool scratch dir cleanup (#953 follow-up)", () => {
    dtest("Claude: a flush failure still removes the ax-spool-claude-* scratch dir", async () => {
        const transcriptsDir = tempDir("ax-953-claude-files-");
        const projectDir = join(transcriptsDir, "-repo");
        await mkdir(projectDir, { recursive: true });
        await Bun.write(
            join(projectDir, "sess.jsonl"),
            [
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
                    message: {
                        role: "assistant",
                        model: "claude-sonnet-4-5",
                        content: [{ type: "text", text: "done" }],
                    },
                },
            ]
                .map((row) => JSON.stringify(row))
                .join("\n"),
        );

        const before = await spoolDirsWithPrefix("ax-spool-claude-");
        let failed = false;
        await runWithPlatform(
            publishCacheFixture(tempDir("ax-953-claude-cache-"), dylibPath, (write) =>
                Effect.gen(function* () {
                    const exit = yield* Effect.exit(
                        ingestTranscripts(failFlush(write)).pipe(
                            Effect.provide(AxConfigTest({ paths: { transcriptsDir } })),
                            Effect.provide(FixturePlatform),
                        ),
                    );
                    failed = Exit.isFailure(exit);
                }),
            ),
        );

        expect(failed).toBe(true);
        const after = await spoolDirsWithPrefix("ax-spool-claude-");
        const leaked = [...after].filter((name) => !before.has(name));
        expect(leaked).toEqual([]);
    });

    dtest("Codex: a flush failure still removes the ax-spool-codex-* scratch dir", async () => {
        const codexDir = tempDir("ax-953-codex-files-");
        await Bun.write(
            join(codexDir, "rollout.jsonl"),
            [
                {
                    type: "session_meta",
                    timestamp: "2026-06-10T08:00:00.000Z",
                    payload: {
                        id: "codex-953",
                        cwd: "/repo",
                        cli_version: "0.4.0",
                        model_provider: "openai",
                        timestamp: "2026-06-10T08:00:00.000Z",
                    },
                },
                {
                    type: "response_item",
                    timestamp: "2026-06-10T08:00:01.000Z",
                    payload: {
                        type: "message",
                        message: { role: "user", content: [{ type: "input_text", text: "fix the ingest bug" }] },
                    },
                },
                {
                    type: "response_item",
                    timestamp: "2026-06-10T08:00:02.000Z",
                    payload: {
                        type: "message",
                        message: { role: "assistant", content: [{ type: "output_text", text: "done" }] },
                    },
                },
            ]
                .map((row) => JSON.stringify(row))
                .join("\n"),
        );

        const before = await spoolDirsWithPrefix("ax-spool-codex-");
        let failed = false;
        await runWithPlatform(
            publishCacheFixture(tempDir("ax-953-codex-cache-"), dylibPath, (write) =>
                Effect.gen(function* () {
                    const exit = yield* Effect.exit(
                        ingestCodex(failFlush(write)).pipe(
                            Effect.provide(AxConfigTest({ paths: { codexDir } })),
                            Effect.provide(FixturePlatform),
                        ),
                    );
                    failed = Exit.isFailure(exit);
                }),
            ),
        );

        expect(failed).toBe(true);
        const after = await spoolDirsWithPrefix("ax-spool-codex-");
        const leaked = [...after].filter((name) => !before.has(name));
        expect(leaked).toEqual([]);
    });

    // Pi and its fork omp (`makePiLikeIngest`) share this exact ingest loop -
    // exercising Pi covers both.
    dtest("Pi: a flush failure still removes the ax-spool-pi-* scratch dir", async () => {
        const piDir = tempDir("ax-953-pi-files-");
        await Bun.write(
            join(piDir, "sess.jsonl"),
            [
                { type: "session", version: 3, id: "sess", timestamp: "2026-06-01T10:00:00Z", cwd: "/repo" },
                {
                    type: "message",
                    id: "sess-m1",
                    parentId: null,
                    timestamp: "2026-06-01T10:00:01Z",
                    message: { role: "user", content: [{ type: "text", text: "hello" }] },
                },
            ]
                .map((row) => JSON.stringify(row))
                .join("\n"),
        );

        const before = await spoolDirsWithPrefix("ax-spool-pi-");
        let failed = false;
        await runWithPlatform(
            publishCacheFixture(tempDir("ax-953-pi-cache-"), dylibPath, (write) =>
                Effect.gen(function* () {
                    const exit = yield* Effect.exit(
                        ingestPi(failFlush(write), {}).pipe(
                            Effect.provide(AxConfigTest({ paths: { piDir } })),
                            Effect.provide(FixturePlatform),
                        ),
                    );
                    failed = Exit.isFailure(exit);
                }),
            ),
        );

        expect(failed).toBe(true);
        const after = await spoolDirsWithPrefix("ax-spool-pi-");
        const leaked = [...after].filter((name) => !before.has(name));
        expect(leaked).toEqual([]);
    });
});
