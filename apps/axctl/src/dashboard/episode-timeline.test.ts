import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { publishCacheFixture, readThroughFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { fetchEpisodeTimeline } from "./episode-timeline.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("episode-timeline", { requireFts: true });

const PARENT_ID = "parent-session-1";

const FIXTURE = (w: CacheWriteService) =>
    Effect.gen(function* () {
        yield* w.putMany("session", [
            {
                id: PARENT_ID,
                project: "ax",
                source: "claude",
                cwd: "/repo",
                started_at: new Date("2026-01-01T00:00:00Z"),
                ended_at: new Date("2026-01-01T00:10:00Z"),
            },
            {
                id: "child-session-1",
                project: "ax",
                source: "claude",
                cwd: "/repo",
                started_at: new Date("2026-01-01T00:01:00Z"),
                ended_at: new Date("2026-01-01T00:05:00Z"),
            },
            {
                id: "child-session-2",
                project: "ax",
                source: "claude",
                cwd: "/repo",
                started_at: new Date("2026-01-01T00:06:00Z"),
                ended_at: new Date("2026-01-01T00:09:00Z"),
            },
        ]);
        yield* w.putMany("spawned", [
            { id: "sp1", in_id: PARENT_ID, out_id: "child-session-1", ts: new Date("2026-01-01T00:01:00Z") },
            { id: "sp2", in_id: PARENT_ID, out_id: "child-session-2", ts: new Date("2026-01-01T00:06:00Z") },
        ]);
        yield* w.putMany("skill", [
            { id: "sk-tdd", name: "tdd", scope: "user", dir_path: "/skills/tdd", content_hash: "h1" },
            { id: "sk-commit", name: "commit", scope: "user", dir_path: "/skills/commit", content_hash: "h2" },
        ]);
        yield* w.putMany("invoked", [
            {
                id: "iv-parent-1",
                in_id: "t1",
                out_id: "sk-tdd",
                ts: new Date("2026-01-01T00:00:30Z"),
                session: PARENT_ID,
            },
            {
                id: "iv-child1-1",
                in_id: "t2",
                out_id: "sk-tdd",
                ts: new Date("2026-01-01T00:02:00Z"),
                session: "child-session-1",
            },
            {
                id: "iv-child2-1",
                in_id: "t3",
                out_id: "sk-commit",
                ts: new Date("2026-01-01T00:07:00Z"),
                session: "child-session-2",
            },
        ]);
    });

describe("fetchEpisodeTimeline", () => {
    dtest("assembles parent + children with per-session invocation summaries", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-episode-timeline-"), dylibPath, FIXTURE));
        const payload = await readThroughFixture(fixture, dylibPath, fetchEpisodeTimeline(PARENT_ID));

        expect(payload.parent_session_id).toBe(PARENT_ID);
        expect(payload.project).toBe("ax");
        expect(payload.node_count).toBe(3); // parent + 2 children
        expect(payload.duration_ms).toBe(10 * 60_000);

        const parentNode = payload.nodes.find((n) => n.role === "parent");
        expect(parentNode?.invocation_count).toBe(1);
        expect(parentNode?.top_skills.map((s) => s.skill)).toEqual(["tdd"]);

        const child1 = payload.nodes.find((n) => n.session_id === "child-session-1");
        expect(child1?.role).toBe("child");
        expect(child1?.invocation_count).toBe(1);
        expect(child1?.duration_ms).toBe(4 * 60_000);

        const child2 = payload.nodes.find((n) => n.session_id === "child-session-2");
        expect(child2?.invocation_count).toBe(1);

        // Children ordered chronologically after the parent.
        expect(payload.nodes.map((n) => n.session_id)).toEqual([
            PARENT_ID,
            "child-session-1",
            "child-session-2",
        ]);
    });

    dtest("returns an empty-shape payload for an id that fails the session-id format check", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-episode-timeline-badid-"), dylibPath, () => Effect.void));
        const payload = await readThroughFixture(fixture, dylibPath, fetchEpisodeTimeline("x"));

        expect(payload.node_count).toBe(0);
        expect(payload.nodes).toEqual([]);
        expect(payload.shape).toBe("");
    });

    dtest("a parent with no children returns just the parent node", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-episode-timeline-solo-"), dylibPath, (w) =>
                w.putMany("session", [{ id: "solo-session-1", project: "ax" }]),
            ),
        );
        const payload = await readThroughFixture(fixture, dylibPath, fetchEpisodeTimeline("solo-session-1"));

        expect(payload.node_count).toBe(1);
        expect(payload.nodes[0]?.role).toBe("parent");
    });
});
