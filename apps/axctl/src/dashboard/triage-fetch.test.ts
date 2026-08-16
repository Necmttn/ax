/**
 * fetchSkillTriage tests, against a REAL published DuckDB cache fixture.
 *
 * `Judgment` (triage decisions) is a separate sqlite store untouched by the
 * SurrealDB->DuckDB migration, so it keeps the existing `judgmentTestLayer`
 * stub; the interesting behavior under test - the skill-summary aggregate,
 * the proposed-only union, commit/last-project enrichment, taste_score /
 * recommendation - all runs against a real DuckDB.
 */
import { describe, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { publishCacheFixture, readFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { judgmentTestLayer } from "../testing/judgment-test-layer.ts";
import { fetchSkillTriage } from "./triage.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("triage-fetch", { requireFts: true });

const FIXTURE = (w: CacheWriteService) =>
    Effect.gen(function* () {
        yield* w.putMany("session", [
            { id: "s1", project: "ax" },
        ]);
        yield* w.putMany("skill", [
            { id: "sk-tdd", name: "tdd", scope: "user", dir_path: "/skills/tdd", content_hash: "h1" },
            { id: "sk-dead", name: "dead-skill", scope: "user", dir_path: "/skills/dead", content_hash: "h2" },
            { id: "sk-proposed-only", name: "proposed-only", scope: "user", dir_path: "/skills/po", content_hash: "h3" },
        ]);
        yield* w.putMany("turn", [
            { id: "t1", session: "s1", seq: 1, ts: new Date(), role: "assistant" },
        ]);
        const now = new Date();
        yield* w.putMany("invoked", [
            { id: "iv1", in_id: "t1", out_id: "sk-tdd", ts: now, session: "s1", was_corrected: false },
            { id: "iv2", in_id: "t1", out_id: "sk-tdd", ts: now, session: "s1", was_corrected: false },
        ]);
        yield* w.putMany("produced", [
            { id: "p1", in_id: "s1", out_id: "c1", ts: now },
        ]);
        yield* w.putMany("proposed", [
            { id: "pr1", in_id: "t1", out_id: "sk-proposed-only", ts: now },
        ]);
    });

describe("fetchSkillTriage", () => {
    dtest("summarizes invoked skills, unions proposed-only skills, applies triage decisions", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-triage-fetch-"), dylibPath, FIXTURE));

        const response = await Effect.runPromise(
            fetchSkillTriage().pipe(
                Effect.provide(
                    Layer.mergeAll(
                        readFixture(fixture.snapshotPath, dylibPath),
                        judgmentTestLayer((sql) =>
                            sql.includes("FROM skill_triage_decision")
                                ? [{ skill_name: "tdd", decision: "keep", reason: "load-bearing", decided_at: new Date() }]
                                : [],
                        ),
                    ),
                ),
            ),
        );

        const tdd = response.skills.find((s) => s.name === "tdd");
        expect(tdd).toBeDefined();
        expect(tdd?.total_inv).toBe(2);
        expect(tdd?.commits_after).toBe(1); // s1 produced 1 commit
        expect(tdd?.last_project).toBe("ax");
        expect(tdd?.decision).toEqual({ skill_name: "tdd", decision: "keep", reason: "load-bearing", decided_at: expect.any(String) });

        // proposed-only union: never invoked, has a proposed edge.
        const proposedOnly = response.skills.find((s) => s.name === "proposed-only");
        expect(proposedOnly).toBeDefined();
        expect(proposedOnly?.total_inv).toBe(0);
        expect(proposedOnly?.proposals).toBe(1);
        expect(proposedOnly?.recommendation).toBe("archive");

        // never invoked, never proposed -> not in the response at all (main
        // scan requires invoked rows; proposed-only scan requires proposed rows).
        expect(response.skills.find((s) => s.name === "dead-skill")).toBeUndefined();
    });
});
