import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { publishCacheFixture, readThroughFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { fetchProject } from "./project.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("project");

const now = new Date();
const earlier = new Date(now.getTime() - 3_600_000);

const FIXTURE = (w: CacheWriteService) =>
    Effect.gen(function* () {
        yield* w.putMany("session", [
            { id: "s1", project: "ax", source: "claude", started_at: earlier, ended_at: earlier, model: "claude-opus-5", cwd: "/repo" },
            { id: "s2", project: "ax", source: "claude", started_at: now, ended_at: now, model: "claude-opus-5", cwd: "/repo" },
            { id: "s3", project: "ax", source: "codex", started_at: now, ended_at: now, model: "gpt-5.6", cwd: "/repo" },
            { id: "other", project: "other-project", source: "claude", started_at: now, ended_at: now, model: null, cwd: null },
        ]);
        yield* w.putMany("skill", [
            { id: "sk-tdd", name: "tdd", scope: "user", dir_path: "/skills/tdd", content_hash: "h1" },
            { id: "sk-synthetic", name: "codex:bash", scope: "user", dir_path: "(synthetic)", content_hash: "h2" },
        ]);
        yield* w.putMany("invoked", [
            { id: "iv1", in_id: "t1", out_id: "sk-tdd", ts: now, session: "s1", was_corrected: false },
            { id: "iv2", in_id: "t2", out_id: "sk-synthetic", ts: now, session: "s1", was_corrected: false },
        ]);
        yield* w.putMany("tool_call", [
            { id: "tc1", session: "s1", name: "Bash", command_norm: "bun test", ts: now, has_error: true },
            { id: "tc2", session: "s2", name: "Bash", command_norm: "bun test", ts: now, has_error: true },
        ]);
        yield* w.putMany("spawned", [
            { id: "sp1", in_id: "s1", out_id: "s2", ts: now, nickname: "Turing" },
        ]);
    });

describe("fetchProject (real DuckDB fixture)", () => {
    dtest("assembles overview/top_skills/failures/recent_sessions/episodes scoped to one project", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-project-"), dylibPath, FIXTURE));
        const payload = await readThroughFixture(fixture, dylibPath, fetchProject("ax"));

        expect(payload).not.toBeNull();
        expect(payload?.session_count).toBe(3);
        expect(payload?.sources).toContainEqual({ source: "claude", count: 2 });
        expect(payload?.sources).toContainEqual({ source: "codex", count: 1 });

        // synthetic skill excluded, tdd kept.
        expect(payload?.top_skills.map((s) => s.skill)).toEqual(["tdd"]);

        expect(payload?.failures[0]).toMatchObject({ label: "bun test", failure_count: 2, distinct_sessions: 2 });

        expect(payload?.recent_sessions.length).toBe(3);
        expect(payload?.recent_sessions[0]?.session_id).toBe("s3"); // most recent started_at first

        expect(payload?.top_episodes).toEqual([
            { parent_session_id: "s1", started_at: earlier.toISOString(), child_count: 1, distinct_nicknames: 1 },
        ]);
    });

    dtest("an unknown project returns null", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-project-none-"), dylibPath, FIXTURE));
        const payload = await readThroughFixture(fixture, dylibPath, fetchProject("nonexistent"));
        expect(payload).toBeNull();
    });
});
