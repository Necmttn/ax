import { describe, expect } from "bun:test";
import { Effect, Schema } from "effect";
import { SkillName } from "@ax/lib/brands";
import { skillRowId } from "@ax/lib/stable-id";
import {
    relateToolCallSkill,
    toolEvidenceFileRecordKey,
    writePlanSnapshot,
    writeToolCalls,
    writeToolFileEvidence,
} from "./evidence-writers.ts";
import { toolCallRecordKey } from "./record-keys.ts";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("evidence writers", { requireFts: true });
const at = new Date("2026-05-29T06:00:00.000Z");

describe("evidence writers on real DuckDB", () => {
    dtest("writes tool calls and hot command columns", async () => {
        let row: unknown;
        await runWithPlatform(publishCacheFixture(tempDir("ax-tool-call-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* writeToolCalls(write, [{
                    sessionId: "session-1", turnKey: "turn-1", provider: "codex",
                    toolName: "exec_command", toolKind: "builtin", seq: 7, callId: "call-abc", ts: at,
                    inputJson: { cmd: "git status --short" }, outputJson: { stdout: " M src/index.ts" },
                    commandText: "git status --short", commandNorm: "git status",
                    commandToolName: "git", exitCode: 128, hasError: true,
                }]);
                row = (yield* write.rows(Schema.Struct({
                    status: Schema.String, command_norm: Schema.String,
                    exit_code: Schema.BigInt, has_error: Schema.Boolean,
                }), "SELECT status, command_norm, exit_code, has_error FROM tool_call"))[0];
            }),
        ));
        expect(row).toEqual({ status: "error", command_norm: "git status", exit_code: 128n, has_error: true });
    });

    dtest("uses one file identity across edit, read, and search edges", async () => {
        let counts: unknown;
        await runWithPlatform(publishCacheFixture(tempDir("ax-file-evidence-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* writeToolFileEvidence(write, [
                    { kind: "edited", sessionId: "session-1", turnKey: "turn-1",
                        toolCallKey: "edit-call", toolName: "apply_patch", ts: at,
                        path: "/repo/src/a.ts", pathSeen: "src/a.ts", evidence: "tool_name:apply_patch" },
                    { kind: "read_file", sessionId: "session-1", turnKey: "turn-1",
                        toolCallKey: "read-call", toolName: "Read", ts: at,
                        path: "/repo/src/a.ts", pathSeen: "src/a.ts", evidence: "tool_name:Read" },
                    { kind: "searched_file", sessionId: "session-1", turnKey: "turn-1",
                        toolCallKey: "grep-call", toolName: "Grep", ts: at,
                        path: "/repo/src", pathSeen: "src", evidence: "tool_name:Grep" },
                ]);
                counts = (yield* write.rows(Schema.Struct({
                    files: Schema.BigInt, edited: Schema.BigInt,
                    read: Schema.BigInt, searched: Schema.BigInt,
                }), `SELECT (SELECT count(*) FROM file) AS files,
                    (SELECT count(*) FROM edited) AS edited,
                    (SELECT count(*) FROM read_file) AS read,
                    (SELECT count(*) FROM searched_file) AS searched`))[0];
            }),
        ));
        expect(toolEvidenceFileRecordKey("/repo/src/a.ts")).toMatch(/^repository__.*__repo_src_a_ts__/);
        expect(counts).toEqual({ files: 2n, edited: 1n, read: 1n, searched: 1n });
    });

    dtest("creates a missing skill relation and persists plan items", async () => {
        let counts: unknown;
        const skillName = SkillName.make("superpowers:test-driven-development");
        await runWithPlatform(publishCacheFixture(tempDir("ax-relations-"), dylibPath, (write) =>
            Effect.gen(function* () {
                const toolCallKey = toolCallRecordKey({ sessionId: "session-1", seq: 1, callId: "call-1" });
                yield* relateToolCallSkill(write, { toolCallKey, skillName, ts: at, reason: "TDD" });
                yield* writePlanSnapshot(write, {
                    planKey: "plan-1", sessionId: "session-1", source: "codex_update_plan",
                    status: "in_progress", createdAt: at, snapshotKey: "snapshot-1",
                    itemsJson: [{ id: "one" }], ts: at,
                    items: [{ key: "item-1", externalId: "one", seq: 1, content: "Inspect schema", status: "completed" }],
                });
                counts = (yield* write.rows(Schema.Struct({
                    skills: Schema.BigInt, concerns: Schema.BigInt, plans: Schema.BigInt,
                    snapshots: Schema.BigInt, items: Schema.BigInt,
                }), `SELECT (SELECT count(*) FROM skill) AS skills,
                    (SELECT count(*) FROM concerns) AS concerns,
                    (SELECT count(*) FROM plan) AS plans,
                    (SELECT count(*) FROM plan_snapshot) AS snapshots,
                    (SELECT count(*) FROM plan_item) AS items`))[0];
            }),
        ));
        expect(skillRowId(skillName)).toMatch(/^[0-9a-f]{32}$/);
        expect(counts).toEqual({ skills: 1n, concerns: 1n, plans: 1n, snapshots: 1n, items: 1n });
    });
});
