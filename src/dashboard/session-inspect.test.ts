import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findTranscript, harnessFromPath } from "./session-inspect.ts";

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

describe("findTranscript", () => {
    const tmpRoots: string[] = [];
    afterAll(async () => {
        for (const dir of tmpRoots) {
            await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
    });

    test("rawFileHint pointing to an existing file is used directly (claude harness)", async () => {
        const dir = await mkdtemp(join(tmpdir(), "ax-inspect-"));
        tmpRoots.push(dir);
        const file = join(dir, "agent-fake.jsonl");
        await writeFile(file, "");
        const found = await findTranscript("claude-subagent-fake", file);
        expect(found.path).toBe(file);
        expect(found.harness).toBe("claude");
    });

    test("rawFileHint under a codex sessions dir resolves to codex harness", async () => {
        const dir = await mkdtemp(join(tmpdir(), "ax-inspect-"));
        tmpRoots.push(dir);
        const sessionsDir = join(dir, ".codex", "sessions", "2026", "05", "19");
        await (await import("node:fs/promises")).mkdir(sessionsDir, { recursive: true });
        const file = join(sessionsDir, "rollout-1-fake.jsonl");
        await writeFile(file, "");
        const found = await findTranscript("anything", file);
        expect(found.path).toBe(file);
        expect(found.harness).toBe("codex");
    });

    test("null rawFileHint with no matching jsonl falls back to throwing search error", async () => {
        // Use a session id guaranteed not to exist under the real ~/.claude or ~/.codex trees.
        const bogus = `ax-test-bogus-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await expect(findTranscript(bogus, null)).rejects.toThrow(/session transcript not found/);
    });

    test("stale rawFileHint (file missing) falls back to search and still errors when nothing found", async () => {
        const bogus = `ax-test-stale-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const stale = join(tmpdir(), `definitely-missing-${bogus}.jsonl`);
        await expect(findTranscript(bogus, stale)).rejects.toThrow(/session transcript not found/);
    });
});
