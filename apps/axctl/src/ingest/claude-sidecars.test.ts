import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, FileSystem, Layer, Path } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import {
    buildClaudeSidecarStatements,
    claudeSidecarArtifactKey,
    claudeSidecarsStage,
    discoverClaudeSidecarArtifacts,
} from "./claude-sidecars.ts";

const FsLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const runFs = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(FsLayer)));

const tempDirs: string[] = [];

const makeTempDir = async () => {
    const dir = await mkdtemp(join(tmpdir(), "ax-claude-sidecars-"));
    tempDirs.push(dir);
    return dir;
};

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const write = async (root: string, relPath: string, content: string | Uint8Array) => {
    const abs = join(root, relPath);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content);
    return abs;
};

describe("discoverClaudeSidecarArtifacts", () => {
    test("discovers supported Claude project sidecars and respects project scoping", async () => {
        const transcriptsDir = await makeTempDir();
        const project = "-Users-me-Projects-ax";
        const otherProject = "-Users-me-Projects-other";

        await write(transcriptsDir, `${project}/tool-results/tool-1.json`, "{}");
        await write(transcriptsDir, `${project}/file-history/history.json`, "{}");
        await write(transcriptsDir, `${project}/plans/plan.md`, "# plan");
        await write(transcriptsDir, `${project}/tasks/task.json`, "{}");
        await write(transcriptsDir, `${project}/session-env/session.json`, "{}");
        await write(transcriptsDir, `${project}/shell-snapshots/shell.txt`, "pwd");
        await write(transcriptsDir, `${project}/debug/log.txt`, "debug");
        await write(transcriptsDir, `${project}/stats-cache.json`, "{}");
        await write(transcriptsDir, `${project}/paste-cache/raw.txt`, "secret");
        await write(transcriptsDir, `${project}/image-cache/raw.png`, new Uint8Array([1, 2, 3]));
        await write(transcriptsDir, `${otherProject}/stats-cache.json`, "{}");

        const records = await runFs(discoverClaudeSidecarArtifacts({ transcriptsDir, project }));

        expect(records.map((record) => record.safeRelativePath).sort()).toEqual([
            `${project}/debug/log.txt`,
            `${project}/file-history/history.json`,
            `${project}/plans/plan.md`,
            `${project}/session-env/session.json`,
            `${project}/shell-snapshots/shell.txt`,
            `${project}/stats-cache.json`,
            `${project}/tasks/task.json`,
            `${project}/tool-results/tool-1.json`,
        ]);
        expect(records.map((record) => record.kind).sort()).toEqual([
            "debug",
            "file-history",
            "plans",
            "session-env",
            "shell-snapshots",
            "stats-cache",
            "tasks",
            "tool-results",
        ]);
        expect(records.every((record) => record.project === project)).toBe(true);
        expect(records.every((record) => record.safeRelativePath.startsWith(transcriptsDir))).toBe(false);
        expect(records.every((record) => record.pathHash.length === 64)).toBe(true);
    });

    test("does not hash or excerpt large sidecar files", async () => {
        const transcriptsDir = await makeTempDir();
        const project = "-Users-me-Projects-ax";
        await write(transcriptsDir, `${project}/tool-results/huge.json`, "x".repeat(80_000));

        const [record] = await runFs(discoverClaudeSidecarArtifacts({ transcriptsDir, project }));

        expect(record).toBeDefined();
        expect(record!.contentHash).toBeNull();
        expect(record!.excerpt).toBeNull();
        expect(record!.attrs).toMatchObject({
            content_hash_skipped: true,
            excerpt_skipped: true,
            skip_reason: "file_too_large",
        });
    });

    test("links UUID-like sidecars to the matching session id", async () => {
        const transcriptsDir = await makeTempDir();
        const project = "-Users-me-Projects-ax";
        const sessionId = "11111111-2222-4333-8444-555555555555";
        await write(transcriptsDir, `${project}/session-env/${sessionId}.json`, "{}");

        const [record] = await runFs(discoverClaudeSidecarArtifacts({ transcriptsDir, project }));

        expect(record?.sessionId).toBe(sessionId);
        expect(record?.relationIds).toEqual({ session_id: sessionId });
    });
});

describe("buildClaudeSidecarStatements", () => {
    test("writes metadata-only Surreal statements", () => {
        const observedAt = new Date("2026-06-17T12:00:00.000Z");
        const mtime = new Date("2026-06-17T11:00:00.000Z");
        const record = {
            kind: "stats-cache",
            project: "-Users-me-Projects-ax",
            safeRelativePath: "-Users-me-Projects-ax/stats-cache.json",
            pathHash: "a".repeat(64),
            size: 42,
            mtime,
            contentHash: "b".repeat(64),
            sessionId: null,
            relationIds: {},
            relationAttrs: { source: "root" },
            observedAt,
            excerpt: null,
            attrs: { content_hash_skipped: false, excerpt_skipped: true },
        } as const;

        expect(claudeSidecarArtifactKey(record)).toBe("a".repeat(64));

        const [statement] = buildClaudeSidecarStatements([record]);

        expect(statement).toContain("UPSERT claude_sidecar_artifact:`aaaaaaaa");
        expect(statement).toContain("kind: \"stats-cache\"");
        expect(statement).toContain("project: \"-Users-me-Projects-ax\"");
        expect(statement).toContain("safe_relative_path: \"-Users-me-Projects-ax/stats-cache.json\"");
        expect(statement).toContain("path_hash: \"aaaaaaaa");
        expect(statement).toContain("size: 42");
        expect(statement).toContain("mtime: d\"2026-06-17T11:00:00.000Z\"");
        expect(statement).toContain("content_hash: \"bbbbbbbb");
        expect(statement).toContain("session: NONE");
        expect(statement).toContain("relation_ids_json: \"{}\"");
        expect(statement).toContain("observed_at: d\"2026-06-17T12:00:00.000Z\"");
        expect(statement).not.toContain("secret");
        expect(statement).not.toContain(process.env.HOME ?? "__no_home__");
    });
});

describe("claudeSidecarsStage", () => {
    test("is an ingest stage ordered after Claude and subagents by dependency", () => {
        expect(claudeSidecarsStage.meta.key).toBe("claude-sidecars");
        expect(claudeSidecarsStage.meta.deps).toEqual(["claude", "subagents"]);
        expect(claudeSidecarsStage.meta.tags).toContain("ingest");
    });
});
