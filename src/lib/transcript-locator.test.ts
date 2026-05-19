import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { SurrealClient, type SurrealClientShape } from "./db.ts";
import {
    harnessFromPath,
    locateTranscript,
    locateTranscriptOnDisk,
    TranscriptNotFoundError,
} from "./transcript-locator.ts";

/** Minimal SurrealClient fake. `query` returns the raw_file the test wants
 *  resolveRawFileFromDb to see; everything else returns empty. */
function fakeLocatorClient(rawFile: string | null): SurrealClientShape {
    return {
        query: <T extends unknown[]>(sql: string) =>
            Effect.sync(() => {
                if (sql.includes("SELECT raw_file FROM")) {
                    return [[{ raw_file: rawFile }]] as T;
                }
                return [[]] as T;
            }),
        upsert: () => Effect.void,
        relate: () => Effect.void,
        putFile: () => Effect.void,
        getFile: () => Effect.succeed(""),
        raw: {} as never,
    };
}

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
        const found = await locateTranscriptOnDisk("claude-subagent-fake", file);
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
        const found = await locateTranscriptOnDisk("anything", file);
        expect(found.path).toBe(file);
        expect(found.harness).toBe("codex");
    });

    test("null rawFileHint with no matching jsonl falls back to throwing TranscriptNotFoundError", async () => {
        // Use a session id guaranteed not to exist under the real ~/.claude or ~/.codex trees.
        const bogus = `ax-test-bogus-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await expect(locateTranscriptOnDisk(bogus, null)).rejects.toThrow(/session transcript not found/);
    });

    test("stale rawFileHint (file missing) falls back to search and still errors when nothing found", async () => {
        const bogus = `ax-test-stale-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const stale = join(tmpdir(), `definitely-missing-${bogus}.jsonl`);
        await expect(locateTranscriptOnDisk(bogus, stale)).rejects.toThrow(/session transcript not found/);
    });
});

describe("locateTranscript (with DB hint)", () => {
    const tmpRoots: string[] = [];
    afterAll(async () => {
        for (const dir of tmpRoots) {
            await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
    });

    test("uses raw_file hint from DB when the path exists on disk", async () => {
        const dir = await mkdtemp(join(tmpdir(), "ax-locator-db-"));
        tmpRoots.push(dir);
        const file = join(dir, "agent-fromdb.jsonl");
        await writeFile(file, "");
        const found = await Effect.runPromise(
            locateTranscript("claude-subagent-fromdb").pipe(
                Effect.provide(Layer.succeed(SurrealClient, fakeLocatorClient(file))),
            ),
        );
        expect(found.path).toBe(file);
        expect(found.harness).toBe("claude");
    });

    test("null raw_file in DB plus no on-disk match throws TranscriptNotFoundError", async () => {
        const bogus = `ax-test-db-null-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const eff = locateTranscript(bogus).pipe(
            Effect.provide(Layer.succeed(SurrealClient, fakeLocatorClient(null))),
        );
        await expect(Effect.runPromise(eff)).rejects.toThrow(/session transcript not found/);
    });

    test("TranscriptNotFoundError preserves the session id", async () => {
        const bogus = `ax-test-err-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const eff = locateTranscript(bogus).pipe(
            Effect.provide(Layer.succeed(SurrealClient, fakeLocatorClient(null))),
        );
        try {
            await Effect.runPromise(eff);
            throw new Error("expected to throw");
        } catch (err) {
            // Effect wraps errors in a FiberFailure-ish shell; the inner cause
            // should expose TranscriptNotFoundError properties.
            const message = err instanceof Error ? err.message : String(err);
            expect(message).toContain(bogus);
            expect(message).toContain("session transcript not found");
        }
    });
});
