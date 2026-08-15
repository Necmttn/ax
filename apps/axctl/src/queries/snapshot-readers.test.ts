import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { publishCacheFixture, readFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { fetchLastSuccessfulIngestAt } from "./ingest-staleness.ts";
import { fetchSidecarUsageSummary } from "./sidecar-usage.ts";
import { fetchSkillLoaded } from "./skill-loaded.ts";
import { fetchSparSessionIds } from "./spar-sessions.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("snapshot readers", {
    requireFts: true,
});

describe("snapshot-only readers", () => {
    dtest("decode typed rows from the published DuckDB snapshot", async () => {
        const dir = tempDir("typed-rows");
        const fixture = await runWithPlatform(
            publishCacheFixture(dir, dylibPath, (write) =>
                Effect.gen(function* () {
                    yield* write.put("session", {
                        id: "session:spar",
                        source: "claude",
                        labels: '["spar"]',
                    });
                    yield* write.put("skill", {
                        id: "skill:tdd",
                        name: "tdd",
                        scope: "user",
                        dir_path: "/skills/tdd",
                        content_hash: "same",
                    });
                    yield* write.put("loaded", {
                        id: "loaded:1",
                        in_id: "session:spar",
                        out_id: "skill:tdd",
                        ts: new Date("2026-08-15T01:00:00.000Z"),
                    });
                    yield* write.put("claude_sidecar_artifact", {
                        id: "artifact:1",
                        kind: "plan",
                        project: "ax",
                        safe_relative_path: "plan.md",
                        path_hash: "hash",
                        size: 10,
                        mtime: new Date("2026-08-15T01:00:00.000Z"),
                        observed_at: new Date("2026-08-15T01:00:00.000Z"),
                    });
                    yield* write.put("used_sidecar_artifact", {
                        id: "usage:1",
                        in_id: "turn:1",
                        out_id: "artifact:1",
                        action: "read",
                        source: "read_input",
                        sidecar_kind: "plan",
                        path_hash: "hash",
                    });
                    yield* write.put("ingest_run", {
                        id: "run:1",
                        command: "ingest",
                        started_at: new Date("2026-08-15T01:00:00.000Z"),
                        ended_at: new Date("2026-08-15T01:02:00.000Z"),
                        status: "ok",
                    });
                }),
            ),
        );
        const layer = readFixture(fixture.snapshotPath, dylibPath);

        const result = await Effect.runPromise(
            Effect.all({
                loaded: fetchSkillLoaded({ limit: 10 }),
                sidecars: fetchSidecarUsageSummary(),
                spar: fetchSparSessionIds(),
                lastIngest: fetchLastSuccessfulIngestAt,
            }).pipe(Effect.provide(layer)),
        );

        expect(result.loaded).toEqual([{ name: "tdd", activations: 1 }]);
        expect(result.sidecars).toEqual({
            artifacts: [{ kind: "plan", artifacts: 1 }],
            usage: [{ action: "read", sidecar_kind: "plan", edges: 1 }],
        });
        expect(result.spar).toEqual(["session:spar"]);
        expect(result.lastIngest).toBe(Date.parse("2026-08-15T01:02:00.000Z"));
    });
});
