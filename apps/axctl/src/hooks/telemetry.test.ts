import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { HOOK_FIRE_SPOOL_FILE, type HookFireSpoolEnvelope } from "./spool.ts";
import { recordHookFire } from "./telemetry.ts";

const roots: string[] = [];
const Platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const spoolDir = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "ax-hook-telemetry-"));
    roots.push(root);
    return root;
};

const minimalPriorSession = {
    session: "session:s1",
    title: "fix bug",
    project: null,
    source: "claude",
    weight: 9,
    files_touched: 1,
    top_files: [] as readonly string[],
    produced_commits: 1,
    delivery_status: null,
    review_pain: null,
    pr_size: null,
    pr_title: null,
    merged_to_main: true,
    user_turns: 3,
    assistant_turns: 8,
    corrections: 1,
    interruptions: 0,
    duration_ms: null,
    hands_free_ms: null,
    last_seen: null,
};

const run = (effect: Effect.Effect<void, never, import("effect").FileSystem.FileSystem | import("effect").Path.Path>) =>
    Effect.runPromise(effect.pipe(Effect.provide(Platform)));

const rowsIn = async (dir: string): Promise<ReadonlyArray<HookFireSpoolEnvelope["row"]>> => {
    const text = await readFile(join(dir, HOOK_FIRE_SPOOL_FILE), "utf8");
    return text.trim().split("\n").map((line) => (JSON.parse(line) as HookFireSpoolEnvelope).row);
};

describe("recordHookFire", () => {
    test("spools one synced hook_fire row per input file", async () => {
        const dir = await spoolDir();
        await run(recordHookFire({
            input: {
                event: "pre-edit",
                task: "fix knowledge route tab bug",
                files: ["src/a.ts", "src/b.ts"],
                sessionId: "session:s1",
                format: "claude",
            },
            decision: { inject: true, reason: "high_signal" },
            priorSessions: [minimalPriorSession],
            harness: "claude",
            latencyMs: 42,
            now: new Date("2026-05-17T10:00:00Z"),
            spoolDir: dir,
        }));

        const rows = await rowsIn(dir);
        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.file_path)).toEqual(["src/a.ts", "src/b.ts"]);
        expect(rows[0]!.id).not.toBe(rows[1]!.id);
        expect(rows[0]).toMatchObject({
            harness: "claude",
            event: "pre-edit",
            inject: true,
            reason: "high_signal",
            latency_ms: 42,
            prior_sessions_considered: 1,
            top_prior_sessions: ["session:s1"],
        });
    });

    test("clips the task excerpt to 240 characters", async () => {
        const dir = await spoolDir();
        await run(recordHookFire({
            input: { event: "read", task: "x".repeat(500), files: ["src/a.ts"], format: "plain" },
            decision: { inject: false, reason: "no_prior_sessions" },
            priorSessions: [],
            harness: "unknown",
            latencyMs: 1,
            spoolDir: dir,
        }));

        const rows = await rowsIn(dir);
        expect(rows[0]!.task_excerpt).toBe(`${"x".repeat(239)}…`);
    });

    test("writes no spool file when input.files is empty", async () => {
        const dir = await spoolDir();
        await run(recordHookFire({
            input: { event: "unknown", task: "x", files: [], format: "plain" },
            decision: { inject: false, reason: "no_files" },
            priorSessions: [],
            harness: "unknown",
            latencyMs: 1,
            spoolDir: dir,
        }));

        expect(await Bun.file(join(dir, HOOK_FIRE_SPOOL_FILE)).exists()).toBe(false);
    });

    test("fails open when the spool path cannot be written", async () => {
        const root = await spoolDir();
        const notDirectory = join(root, "not-a-directory");
        await Bun.write(notDirectory, "occupied");

        await run(recordHookFire({
            input: { event: "read", task: "x", files: ["src/a.ts"], format: "plain" },
            decision: { inject: false, reason: "no_prior_sessions" },
            priorSessions: [],
            harness: "unknown",
            latencyMs: 1,
            spoolDir: notDirectory,
        }));
    });
});
