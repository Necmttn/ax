import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { duckdbTestSetup } from "./testing/duckdb-dylib.ts";
import { publishCacheFixture, readFixture, runWithPlatform } from "./testing/cache-fixture.ts";
import type { CacheWriteService } from "./duckdb/seam.ts";
import {
    encodeClaudeProjectSlug,
    type FoundTranscript,
    harnessFromPath,
    locateTranscript,
    locateTranscriptOnDisk,
    TranscriptNotFoundError,
} from "./transcript-locator.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("transcript-locator", { requireFts: true });

// EXISTING tests of now-Effect fns: provide the REAL Bun-backed FileSystem +
// Path against the tmp-dir fixtures (never the in-memory mock).
const FsLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);

/** Run the disk-only locator against the real Bun FileSystem. */
const onDisk = (sessionId: string, hint: string | null): Promise<FoundTranscript> =>
    Effect.runPromise(locateTranscriptOnDisk(sessionId, hint).pipe(Effect.provide(FsLayer)));

/**
 * A REAL published snapshot holding one session row with the given `raw_file`.
 *
 * A stub that answered `SELECT raw_file FROM ...` with whatever the case
 * handed it would pass identically whether the reader actually worked or
 * read a stale table - so this publishes and re-reads a real snapshot instead.
 * The hint is the ONLY way a synthetic subagent id resolves (no on-disk
 * filename matches it), so a silent `null` here is a subagent transcript that
 * reports "not found".
 */
const cacheLayerWith = async (sessionId: string, rawFile: string | null) => {
    const fixture = await runWithPlatform(
        publishCacheFixture(tempDir("ax-locator-cache-"), dylibPath, (write: CacheWriteService) =>
            write.put("session", {
                id: sessionId,
                source: "claude",
                project: "-p",
                raw_file: rawFile,
            }),
        ),
    );
    return readFixture(fixture.snapshotPath, dylibPath);
};

describe("encodeClaudeProjectSlug", () => {
    test("standard absolute path", () => {
        expect(encodeClaudeProjectSlug("/Users/necmttn/Projects/ax")).toBe(
            "-Users-necmttn-Projects-ax",
        );
    });

    test("trailing slash is stripped before encoding", () => {
        expect(encodeClaudeProjectSlug("/Users/necmttn/Projects/ax/")).toBe(
            "-Users-necmttn-Projects-ax",
        );
        // Multiple trailing slashes
        expect(encodeClaudeProjectSlug("/Users/necmttn/Projects/ax//")).toBe(
            "-Users-necmttn-Projects-ax",
        );
    });

    test("root path / encodes to empty string (edge case)", () => {
        expect(encodeClaudeProjectSlug("/")).toBe("");
    });

    test("single-segment path", () => {
        expect(encodeClaudeProjectSlug("/tmp")).toBe("-tmp");
    });

    test("path with dots", () => {
        expect(encodeClaudeProjectSlug("/Users/foo/.claude/worktrees/fix-kg")).toBe(
            "-Users-foo-.claude-worktrees-fix-kg",
        );
    });
});

describe("harnessFromPath", () => {
    test("codex paths under ~/.codex/sessions/ are codex", () => {
        expect(harnessFromPath("/Users/x/.codex/sessions/2026/05/19/rollout-1234-abc.jsonl")).toBe("codex");
    });

    test("claude project transcripts are claude", () => {
        expect(harnessFromPath("/Users/x/.claude/projects/-Users-x-foo/abc.jsonl")).toBe("claude");
    });

    test("claude subagent transcripts are claude", () => {
        expect(harnessFromPath("/Users/x/.claude/projects/-Users-x-foo/parent-uuid/subagents/agent-abc.jsonl")).toBe("claude");
    });
});

describe("locateTranscriptOnDisk", () => {
    const tmpRoots: string[] = [];
    afterAll(async () => {
        for (const dir of tmpRoots) {
            await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
    });

    test("rawFileHint pointing to an existing file is used directly (claude harness)", async () => {
        const dir = await mkdtemp(join(tmpdir(), "ax-locator-"));
        tmpRoots.push(dir);
        const file = join(dir, "agent-fake.jsonl");
        await writeFile(file, "");
        const found = await onDisk("claude-subagent-fake", file);
        expect(found.path).toBe(file);
        expect(found.harness).toBe("claude");
    });

    test("rawFileHint under a codex sessions dir resolves to codex harness", async () => {
        const dir = await mkdtemp(join(tmpdir(), "ax-locator-"));
        tmpRoots.push(dir);
        const sessionsDir = join(dir, ".codex", "sessions", "2026", "05", "19");
        await mkdir(sessionsDir, { recursive: true });
        const file = join(sessionsDir, "rollout-1-fake.jsonl");
        await writeFile(file, "");
        const found = await onDisk("anything", file);
        expect(found.path).toBe(file);
        expect(found.harness).toBe("codex");
    });

    test("null rawFileHint with no matching jsonl falls back to throwing TranscriptNotFoundError", async () => {
        // Use a session id guaranteed not to exist under the real ~/.claude or ~/.codex trees.
        const bogus = `ax-test-bogus-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await expect(onDisk(bogus, null)).rejects.toThrow(/session transcript not found/);
    });

    test("stale rawFileHint (file missing) falls back to search and still errors when nothing found", async () => {
        const bogus = `ax-test-stale-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const stale = join(tmpdir(), `definitely-missing-${bogus}.jsonl`);
        await expect(onDisk(bogus, stale)).rejects.toThrow(/session transcript not found/);
    });

    // #891: a POINTER hint resolves through the buckets dir - the cold-storage
    // snapshot becomes a real fallback instead of a silent fs.exists no-op.
    test("a transcripts:/ pointer hint resolves to the bucket snapshot (claude harness)", async () => {
        const dir = await mkdtemp(join(tmpdir(), "ax-locator-blob-"));
        tmpRoots.push(dir);
        const bogus = `ax-test-blob-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const bucketsDir = join(dir, "buckets");
        await mkdir(join(bucketsDir, "transcripts"), { recursive: true });
        const blob = join(bucketsDir, "transcripts", `${bogus}.jsonl`);
        await writeFile(blob, "");
        const found = await Effect.runPromise(
            locateTranscriptOnDisk(bogus, `transcripts:/${bogus}.jsonl`, bucketsDir).pipe(
                Effect.provide(FsLayer),
            ),
        );
        expect(found.path).toBe(blob);
        expect(found.harness).toBe("claude");
    });

    test("a codex_artifacts:/ pointer hint resolves with the codex harness", async () => {
        const dir = await mkdtemp(join(tmpdir(), "ax-locator-blob-cx-"));
        tmpRoots.push(dir);
        const bogus = `ax-test-blobcx-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const bucketsDir = join(dir, "buckets");
        await mkdir(join(bucketsDir, "codex_artifacts"), { recursive: true });
        const blob = join(bucketsDir, "codex_artifacts", `${bogus}.jsonl`);
        await writeFile(blob, "");
        const found = await Effect.runPromise(
            locateTranscriptOnDisk(bogus, `codex_artifacts:/${bogus}.jsonl`, bucketsDir).pipe(
                Effect.provide(FsLayer),
            ),
        );
        expect(found.path).toBe(blob);
        expect(found.harness).toBe("codex");
    });

    test("a pointer hint whose blob is gone still errors when nothing else matches", async () => {
        const dir = await mkdtemp(join(tmpdir(), "ax-locator-blob-miss-"));
        tmpRoots.push(dir);
        const bogus = `ax-test-blobmiss-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const eff = locateTranscriptOnDisk(bogus, `transcripts:/${bogus}.jsonl`, join(dir, "buckets")).pipe(
            Effect.provide(FsLayer),
        );
        await expect(Effect.runPromise(eff)).rejects.toThrow(/session transcript not found/);
    });
});

describe("locateTranscript (with the cache hint)", () => {
    const tmpRoots: string[] = [];
    afterAll(async () => {
        for (const dir of tmpRoots) {
            await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
    });

    dtest("uses the raw_file hint from the cache when the path exists on disk", async () => {
        const dir = await mkdtemp(join(tmpdir(), "ax-locator-db-"));
        tmpRoots.push(dir);
        const file = join(dir, "agent-fromdb.jsonl");
        await writeFile(file, "");
        const cache = await cacheLayerWith("claude-subagent-fromdb", file);
        const found = await Effect.runPromise(
            locateTranscript("claude-subagent-fromdb").pipe(
                Effect.provide(Layer.merge(cache, FsLayer)),
            ) as Effect.Effect<FoundTranscript, unknown>,
        );
        expect(found.path).toBe(file);
        expect(found.harness).toBe("claude");
    }, 60_000);

    dtest("a session id the cache does not hold gets no hint and falls through", async () => {
        // Negative control: same fixture shape, a DIFFERENT id. If the reader
        // silently returned null for every id, the case above could not tell.
        const dir = await mkdtemp(join(tmpdir(), "ax-locator-miss-"));
        tmpRoots.push(dir);
        const file = join(dir, "agent-other.jsonl");
        await writeFile(file, "");
        const cache = await cacheLayerWith("claude-subagent-other", file);
        const bogus = `ax-test-miss-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const eff = locateTranscript(bogus).pipe(
            Effect.provide(Layer.merge(cache, FsLayer)),
        ) as Effect.Effect<FoundTranscript, unknown>;
        await expect(Effect.runPromise(eff)).rejects.toThrow(/session transcript not found/);
    }, 60_000);

    dtest("a null raw_file plus no on-disk match throws TranscriptNotFoundError", async () => {
        const bogus = `ax-test-db-null-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const cache = await cacheLayerWith(bogus, null);
        const eff = locateTranscript(bogus).pipe(
            Effect.provide(Layer.merge(cache, FsLayer)),
        ) as Effect.Effect<FoundTranscript, unknown>;
        await expect(Effect.runPromise(eff)).rejects.toThrow(/session transcript not found/);
    }, 60_000);

    dtest("TranscriptNotFoundError preserves the session id", async () => {
        const bogus = `ax-test-err-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const cache = await cacheLayerWith(bogus, null);
        const eff = locateTranscript(bogus).pipe(
            Effect.provide(Layer.merge(cache, FsLayer)),
        ) as Effect.Effect<FoundTranscript, TranscriptNotFoundError>;
        const exit = await Effect.runPromise(Effect.exit(eff));
        expect(exit._tag).toBe("Failure");
        const failure = await Effect.runPromise(
            eff.pipe(Effect.flip, Effect.orElseSucceed(() => null)),
        );
        expect(failure).toBeInstanceOf(TranscriptNotFoundError);
        expect((failure as TranscriptNotFoundError).sessionId).toBe(bogus);
        expect((failure as TranscriptNotFoundError).message).toContain(
            "session transcript not found",
        );
    }, 60_000);
});
