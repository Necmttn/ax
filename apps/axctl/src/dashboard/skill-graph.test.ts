import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { publishCacheFixture, readThroughFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { fetchSkillGraph } from "./skill-graph.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("skill-graph");

const now = new Date();

const FIXTURE = (w: CacheWriteService) =>
    Effect.gen(function* () {
        yield* w.putMany("skill", [
            { id: "sk-a", name: "tdd", scope: "user", dir_path: "/skills/tdd", content_hash: "h1" },
            { id: "sk-b", name: "brainstorming", scope: "user", dir_path: "/skills/bs", content_hash: "h2" },
            { id: "sk-c", name: "below-threshold", scope: "user", dir_path: "/skills/bt", content_hash: "h3" },
        ]);
        yield* w.putMany("skill_paired", [
            { id: "sp1", in_id: "sk-a", out_id: "sk-b", count: 60, last_seen: now },
            { id: "sp2", in_id: "sk-a", out_id: "sk-c", count: 5, last_seen: now },
        ]);
    });

describe("fetchSkillGraph (real DuckDB fixture)", () => {
    dtest("builds a node/edge graph from skill_paired, filtered by minCount", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-skill-graph-"), dylibPath, FIXTURE));
        const payload = await readThroughFixture(fixture, dylibPath, fetchSkillGraph({ minCount: 50 }));

        expect(payload.edge_count).toBe(1);
        expect(payload.edges[0]).toMatchObject({ source: "tdd", target: "brainstorming", count: 60 });
        // below-threshold pair (count=5) dropped by minCount=50.
        expect(payload.edges.some((e) => e.target === "below-threshold")).toBe(false);
        expect(payload.node_count).toBe(2);
        expect(payload.max_edge_count).toBe(60);
        const tddNode = payload.nodes.find((n) => n.name === "tdd");
        expect(tddNode?.weight).toBe(60);
    });

    dtest("a lower minCount surfaces both pairs", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-skill-graph-low-"), dylibPath, FIXTURE));
        const payload = await readThroughFixture(fixture, dylibPath, fetchSkillGraph({ minCount: 1 }));

        expect(payload.edge_count).toBe(2);
        expect(payload.node_count).toBe(3);
    });
});
