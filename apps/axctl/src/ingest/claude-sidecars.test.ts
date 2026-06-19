import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, FileSystem, Layer, Path } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import {
    buildClaudeSidecarStatements,
    buildClaudeSidecarPlanSnapshotStatements,
    buildClaudeSidecarUsageEdges,
    buildClaudeSidecarUsageStatements,
    claudeSidecarArtifactKey,
    claudeSidecarsStage,
    discoverClaudeSidecarArtifacts,
    discoverClaudeSidecarPlanSnapshots,
    extractClaudeSidecarPathRefs,
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
        expect(records.every((record) => record.safeRelativePath.startsWith(`${project}/`))).toBe(true);
        expect(records.every((record) => /^-Users-me-Projects-ax\/[^/]+\/[0-9a-f]{16}$/.test(record.safeRelativePath))).toBe(true);
        expect(records.every((record) => record.pathHash.length === 64)).toBe(true);
        const serialized = JSON.stringify(records);
        expect(serialized).not.toContain("tool-1.json");
        expect(serialized).not.toContain("history.json");
        expect(serialized).not.toContain("plan.md");
        expect(serialized).not.toContain("session.json");
        expect(serialized).not.toContain("shell.txt");
        expect(serialized).not.toContain("log.txt");
        expect(serialized).not.toContain("task.json");
        expect(serialized).not.toContain("stats-cache.json");
    });

    test("skips symlinked sidecar entries without reading files outside the project", async () => {
        const transcriptsDir = await makeTempDir();
        const outsideDir = await makeTempDir();
        const project = "-Users-me-Projects-ax";
        const outsidePath = await write(outsideDir, "outside-secret.txt", "outside-secret");
        await mkdir(join(transcriptsDir, project, "tool-results"), { recursive: true });
        await symlink(outsidePath, join(transcriptsDir, project, "tool-results", "linked.json"));

        const records = await runFs(discoverClaudeSidecarArtifacts({ transcriptsDir, project }));

        expect(records).toEqual([]);
        expect(JSON.stringify(records)).not.toContain("outside-secret");
    });

    test("missing transcript root returns no sidecar artifacts", async () => {
        const transcriptsDir = join(tmpdir(), "ax-missing-claude-sidecars-root");

        const records = await runFs(discoverClaudeSidecarArtifacts({ transcriptsDir }));

        expect(records).toEqual([]);
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

    test("discovers real Claude session-scoped sidecar directories", async () => {
        const transcriptsDir = await makeTempDir();
        const project = "-Users-me-Projects-ax";
        const sessionId = "11111111-2222-4333-8444-555555555555";
        await write(transcriptsDir, `${project}/${sessionId}/tool-results/big-output.txt`, "large output");
        await write(transcriptsDir, `${project}/${sessionId}/shell-snapshots/shell.txt`, "pwd");

        const records = await runFs(discoverClaudeSidecarArtifacts({ transcriptsDir, project }));

        expect(records.map((record) => record.kind).sort()).toEqual(["shell-snapshots", "tool-results"]);
        expect(records.every((record) => record.sessionId === sessionId)).toBe(true);
        expect(records.every((record) => record.safeRelativePath.startsWith(`${project}/`))).toBe(true);
        expect(JSON.stringify(records)).not.toContain("big-output.txt");
        expect(JSON.stringify(records)).not.toContain("shell.txt");
    });
});

describe("buildClaudeSidecarStatements", () => {
    test("writes metadata-only Surreal statements", () => {
        const observedAt = new Date("2026-06-17T12:00:00.000Z");
        const mtime = new Date("2026-06-17T11:00:00.000Z");
        const record = {
            kind: "stats-cache",
            project: "-Users-me-Projects-ax",
            safeRelativePath: "-Users-me-Projects-ax/stats-cache/aaaaaaaaaaaaaaaa",
            pathHash: "a".repeat(64),
            size: 42,
            mtime,
            contentHash: "b".repeat(64),
            sessionId: null,
            relationIds: {},
            relationAttrs: { sidecar_kind: "stats-cache", path_hash: "a".repeat(64), path_depth: 1 },
            observedAt,
            excerpt: null,
            attrs: { content_hash_skipped: false, excerpt_skipped: true },
        } as const;

        expect(claudeSidecarArtifactKey(record)).toBe("a".repeat(64));

        const [statement] = buildClaudeSidecarStatements([record]);

        expect(statement).toContain("UPSERT claude_sidecar_artifact:`aaaaaaaa");
        expect(statement).toContain("kind: \"stats-cache\"");
        expect(statement).toContain("project: \"-Users-me-Projects-ax\"");
        expect(statement).toContain("safe_relative_path: \"-Users-me-Projects-ax/stats-cache/aaaaaaaaaaaaaaaa\"");
        expect(statement).toContain("path_hash: \"aaaaaaaa");
        expect(statement).toContain("size: 42");
        expect(statement).toContain("mtime: d\"2026-06-17T11:00:00.000Z\"");
        expect(statement).toContain("content_hash: \"bbbbbbbb");
        expect(statement).toContain("session: NONE");
        expect(statement).toContain("relation_ids_json: \"{}\"");
        expect(statement).toContain("\\\"path_hash\\\":\\\"aaaaaaaa");
        expect(statement).toContain("observed_at: d\"2026-06-17T12:00:00.000Z\"");
        expect(statement).not.toContain("\\\"relative_path\\\"");
        expect(statement).not.toContain("stats-cache.json");
        expect(statement).not.toContain("secret");
        expect(statement).not.toContain(process.env.HOME ?? "__no_home__");
    });
});

describe("Claude sidecar usage edges", () => {
    test("extracts sidecar path refs from absolute Claude project paths", async () => {
        const transcriptsDir = await makeTempDir();
        const project = "-Users-me-Projects-ax";
        const sessionId = "11111111-2222-4333-8444-555555555555";
        const artifactPath = await write(transcriptsDir, `${project}/${sessionId}/tool-results/big-output.txt`, "large output");

        const [ref] = extractClaudeSidecarPathRefs({
            transcriptsDir,
            text: `Full output saved to: ${artifactPath}`,
        });

        expect(ref).toMatchObject({
            project,
            relativePath: `${sessionId}/tool-results/big-output.txt`,
            kind: "tool-results",
        });
        expect(ref?.pathHash).toHaveLength(64);
    });

    test("links produced, read, and searched tool-result sidecars to tool calls", async () => {
        const transcriptsDir = await makeTempDir();
        const project = "-Users-me-Projects-ax";
        const sessionId = "11111111-2222-4333-8444-555555555555";
        const artifactPath = await write(transcriptsDir, `${project}/${sessionId}/tool-results/big-output.txt`, "large output");
        const artifacts = await runFs(discoverClaudeSidecarArtifacts({ transcriptsDir, project }));

        const edges = buildClaudeSidecarUsageEdges({
            transcriptsDir,
            artifacts,
            rows: [
                {
                    id: "tool_call:producer",
                    session: `session:${sessionId}`,
                    name: "Bash",
                    inputJson: null,
                    outputExcerpt: `<persisted-output>\nFull output saved to: ${artifactPath}\nPreview`,
                    commandText: null,
                    commandNorm: null,
                    ts: "2026-06-19T00:00:00.000Z",
                },
                {
                    id: "tool_call:reader",
                    session: `session:${sessionId}`,
                    name: "Read",
                    inputJson: JSON.stringify({ file_path: artifactPath, offset: 600, limit: 120 }),
                    outputExcerpt: null,
                    commandText: null,
                    commandNorm: null,
                    ts: "2026-06-19T00:01:00.000Z",
                },
                {
                    id: "tool_call:searcher",
                    session: `session:${sessionId}`,
                    name: "Bash",
                    inputJson: null,
                    outputExcerpt: null,
                    commandText: `rg -n "needle" ${artifactPath}`,
                    commandNorm: "rg -n",
                    ts: "2026-06-19T00:02:00.000Z",
                },
            ],
        });

        expect(edges.map((edge) => edge.action).sort()).toEqual(["produced", "read", "searched"]);
        expect(edges.find((edge) => edge.action === "read")).toMatchObject({
            toolCallKey: "reader",
            offset: 600,
            limit: 120,
            commandTool: "Read",
        });
        expect(edges.find((edge) => edge.action === "searched")).toMatchObject({
            toolCallKey: "searcher",
            commandTool: "rg",
            pattern: "needle",
        });

        const sql = buildClaudeSidecarUsageStatements(edges).join("\n");
        expect(sql).toContain("->used_sidecar_artifact:");
        expect(sql).toContain("action = \"produced\"");
        expect(sql).toContain("action = \"read\"");
        expect(sql).toContain("action = \"searched\"");
        expect(sql).toContain("pattern = \"needle\"");
        expect(sql).toContain("offset = 600");
        expect(sql).not.toContain(artifactPath);
    });
});

describe("discoverClaudeSidecarPlanSnapshots", () => {
    test("surfaces tasks and plans sidecars as visible plan snapshots", async () => {
        const transcriptsDir = await makeTempDir();
        const project = "-Users-me-Projects-ax";
        const sessionId = "11111111-2222-4333-8444-555555555555";
        await write(
            transcriptsDir,
            `${project}/tasks/${sessionId}/tasks.json`,
            JSON.stringify({
                tasks: [
                    {
                        id: "task-a",
                        subject: "Inspect sidecar task list",
                        active_form: "Inspecting sidecar task list",
                        status: "active",
                    },
                    {
                        id: "task-b",
                        description: "Document visible plans",
                        status: "completed",
                    },
                ],
            }),
        );
        await write(
            transcriptsDir,
            `${project}/plans/${sessionId}/plan.md`,
            [
                "- [ ] Add sidecar task snapshots",
                "- [x] Keep raw sidecar blobs private",
            ].join("\n"),
        );

        const snapshots = await runFs(discoverClaudeSidecarPlanSnapshots({ transcriptsDir, project }));

        expect(snapshots).toHaveLength(2);
        const taskSnapshot = snapshots.find((snapshot) => snapshot.source === "claude_sidecar_task");
        const planSnapshot = snapshots.find((snapshot) => snapshot.source === "claude_sidecar_plan");
        expect(taskSnapshot).toMatchObject({
            sessionId,
            explanation: "Claude tasks sidecar",
            status: "in_progress",
            toolCallKey: null,
        });
        expect(taskSnapshot?.items).toEqual([
            {
                key: expect.stringContaining("__item_external__task_a__"),
                externalId: "task-a",
                seq: 1,
                content: "Inspect sidecar task list",
                activeForm: "Inspecting sidecar task list",
                status: "in_progress",
            },
            {
                key: expect.stringContaining("__item_external__task_b__"),
                externalId: "task-b",
                seq: 2,
                content: "Document visible plans",
                activeForm: null,
                status: "completed",
            },
        ]);
        expect(planSnapshot).toMatchObject({
            sessionId,
            explanation: "Claude plans sidecar",
            status: "pending",
            toolCallKey: null,
        });
        expect(planSnapshot?.items.map((item) => ({ text: item.content, status: item.status }))).toEqual([
            { text: "Add sidecar task snapshots", status: "pending" },
            { text: "Keep raw sidecar blobs private", status: "completed" },
        ]);
    });

    test("skips sidecar task and plan content without a detectable session id", async () => {
        const transcriptsDir = await makeTempDir();
        const project = "-Users-me-Projects-ax";
        await write(transcriptsDir, `${project}/tasks/task.json`, JSON.stringify({ subject: "No session" }));
        await write(transcriptsDir, `${project}/plans/plan.md`, "- [ ] No session");

        const snapshots = await runFs(discoverClaudeSidecarPlanSnapshots({ transcriptsDir, project }));

        expect(snapshots).toEqual([]);
    });

    test("surfaces session-scoped sidecar plans", async () => {
        const transcriptsDir = await makeTempDir();
        const project = "-Users-me-Projects-ax";
        const sessionId = "11111111-2222-4333-8444-555555555555";
        await write(transcriptsDir, `${project}/${sessionId}/plans/plan.md`, "- [ ] Inspect persisted output");

        const snapshots = await runFs(discoverClaudeSidecarPlanSnapshots({ transcriptsDir, project }));

        expect(snapshots).toHaveLength(1);
        expect(snapshots[0]).toMatchObject({
            sessionId,
            source: "claude_sidecar_plan",
            toolCallKey: null,
        });
        expect(snapshots[0]?.items[0]?.content).toBe("Inspect persisted output");
    });
});

describe("buildClaudeSidecarPlanSnapshotStatements", () => {
    test("writes plan snapshot rows for parsed sidecar plans", () => {
        const statements = buildClaudeSidecarPlanSnapshotStatements([
            {
                planKey: "claude__s1__claude_sidecar_plan__abc",
                sessionId: "s1",
                source: "claude_sidecar_plan",
                status: "pending",
                createdAt: "2026-06-18T00:00:00.000Z",
                updatedAt: "2026-06-18T00:00:00.000Z",
                snapshotKey: "claude__s1__claude_sidecar_plan__abc__snapshot_000001",
                toolCallKey: null,
                itemsJson: [
                    { externalId: null, seq: 1, content: "Visible sidecar plan", activeForm: null, status: "pending" },
                ],
                explanation: "Claude plans sidecar",
                ts: "2026-06-18T00:00:00.000Z",
                items: [
                    {
                        key: "claude__s1__claude_sidecar_plan__abc__item_001",
                        externalId: null,
                        seq: 1,
                        content: "Visible sidecar plan",
                        activeForm: null,
                        status: "pending",
                    },
                ],
            },
        ]);
        const sql = statements.join("\n");

        expect(sql).toContain("UPSERT plan_snapshot:");
        expect(sql).toContain("UPSERT plan_item:");
        expect(sql).toContain("Visible sidecar plan");
        expect(sql).toContain("tool_call: NONE");
    });
});

describe("claudeSidecarsStage", () => {
    test("is an ingest stage ordered after Claude and subagents by dependency", () => {
        expect(claudeSidecarsStage.meta.key).toBe("claude-sidecars");
        expect(claudeSidecarsStage.meta.deps).toEqual(["claude", "subagents"]);
        expect(claudeSidecarsStage.meta.tags).toContain("ingest");
    });
});
