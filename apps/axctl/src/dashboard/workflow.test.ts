import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { CacheRead, type CacheWriteService } from "@ax/lib/duckdb/seam";
import { publishCacheFixture, readThroughFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { computeWorkflow, fetchWorkflow, refreshWorkflowSnapshot } from "./workflow.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("workflow");

const now = new Date();

const seedRows = (w: CacheWriteService) =>
    Effect.gen(function* () {
        yield* w.putMany("session", [
            { id: "s1", project: "ax", started_at: now, ended_at: now, source: "claude" },
            { id: "s2", project: "ax", started_at: now, ended_at: now, source: "claude-subagent" },
        ]);
        yield* w.putMany("skill", [
            { id: "sk-tdd", name: "tdd", scope: "user", dir_path: "/skills/tdd", content_hash: "h1" },
        ]);
        yield* w.putMany("invoked", [
            {
                id: "iv1",
                in_id: "t1",
                out_id: "sk-tdd",
                ts: now,
                session: "s1",
                turn_index: 1,
                is_first: true,
                was_corrected: false,
            },
            {
                id: "iv2",
                in_id: "t2",
                out_id: "sk-tdd",
                ts: now,
                session: "s2",
                turn_index: 1,
                is_first: true,
                was_corrected: false,
            },
        ]);
        yield* w.putMany("tool_call", [
            { id: "tc1", session: "s1", name: "Edit", command_norm: null, ts: now },
        ]);
        yield* w.putMany("spawned", [
            { id: "sp1", in_id: "s1", out_id: "s2", ts: now, nickname: "Turing" },
        ]);
    });

describe("computeWorkflow (real DuckDB fixture)", () => {
    dtest("aggregates weekly skills/tools/session-shape and episode structure", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-workflow-"), dylibPath, seedRows));
        const payload = await readThroughFixture(
            fixture,
            dylibPath,
            Effect.gen(function* () {
                const read = yield* CacheRead;
                return yield* computeWorkflow(read);
            }),
        );

        expect(payload.weeksLookback).toBe(12);
        const tddWeek = payload.skills.flatMap((b) => b.counts).find((i) => i.label === "tdd");
        // only s1 (non-subagent) counts toward the weekly-skills bucket; s2 is
        // claude-subagent and WORKFLOW_WEEKLY_SKILLS_SQL has no source filter,
        // so both invocations land - assert the total, not a per-source split.
        expect(tddWeek?.count).toBe(2);

        const episode = payload.episodes.find((e) => e.parent_session_id === "s1");
        expect(episode?.child_count).toBe(1);
        expect(episode?.project).toBe("ax");
        expect(episode?.distinct_nicknames).toBe(1);
        expect(episode?.started_at).not.toBeNull();
    });

    dtest("fetchWorkflow recomputes cold, then a persisted snapshot short-circuits recompute", async () => {
        const cold = await runWithPlatform(publishCacheFixture(tempDir("ax-workflow-cold-"), dylibPath, seedRows));
        const coldPayload = await readThroughFixture(cold, dylibPath, fetchWorkflow());
        expect(coldPayload.episodes.some((e) => e.parent_session_id === "s1")).toBe(true);

        // Persist a snapshot from a MINIMAL seed (no episodes at all), then add
        // an episode-producing session AFTER the refresh. If fetchWorkflow read
        // the live tables instead of the stored snapshot, the new episode would
        // show up - proving the read path answers from workflow_snapshot.
        const snapshotted = await runWithPlatform(
            publishCacheFixture(tempDir("ax-workflow-snap-"), dylibPath, (w) =>
                Effect.gen(function* () {
                    yield* refreshWorkflowSnapshot(w); // persists an empty-episodes snapshot
                    yield* w.putMany("session", [
                        { id: "later-parent", project: "ax", started_at: now, ended_at: now, source: "claude" },
                        { id: "later-child", project: "ax", started_at: now, ended_at: now, source: "claude-subagent" },
                    ]);
                    yield* w.putMany("spawned", [
                        { id: "sp-later", in_id: "later-parent", out_id: "later-child", ts: now, nickname: "Babbage" },
                    ]);
                })),
        );
        const fromSnapshot = await readThroughFixture(snapshotted, dylibPath, fetchWorkflow());
        expect(fromSnapshot.episodes.some((e) => e.parent_session_id === "later-parent")).toBe(false);
    });
});
