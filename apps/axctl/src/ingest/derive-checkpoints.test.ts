import { describe, expect, test } from "bun:test";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer, Schema } from "effect";
import { join } from "node:path";
import { CacheReadLayer, withCacheWrite } from "@ax/lib/duckdb/seam";
import { withIngestLock } from "@ax/lib/ingest-lock";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { Judgment, JudgmentLayer, TextColumn } from "@ax/lib/sqlite";
import { SIDECAR_SCHEMA_SQL } from "@ax/schema/sidecar-ddl";
import {
    checkpointKey,
    computeSuggestedVerdict,
    deriveCheckpoints,
    dueCheckpointKinds,
} from "./derive-checkpoints.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("derive checkpoints");
const Platform = Layer.merge(BunFileSystem.layer, BunPath.layer);
const CACHE_DDL = `
CREATE TABLE opportunity (id VARCHAR PRIMARY KEY, in_id VARCHAR NOT NULL, was_addressed BOOLEAN NOT NULL);
CREATE TABLE session (id VARCHAR PRIMARY KEY, created_at TIMESTAMP);
`;

describe("computeSuggestedVerdict", () => {
    test("opportunities=0 + no frequency info -> no_longer_needed", () => {
        expect(computeSuggestedVerdict({ opportunities: 0, addressed: 0, ratio: 0, built: true })).toBe("no_longer_needed");
    });

    test("opportunities=0 + current==baseline -> no_longer_needed (pattern self-resolved)", () => {
        expect(computeSuggestedVerdict({
            opportunities: 0,
            addressed: 0,
            ratio: 0,
            built: true,
            currentFrequency: 5,
            baselineFrequency: 5,
        })).toBe("no_longer_needed");
    });

    test("opportunities=0 + current > baseline -> ignored (artifact exists but pattern still firing)", () => {
        expect(computeSuggestedVerdict({
            opportunities: 0,
            addressed: 0,
            ratio: 0,
            built: true,
            currentFrequency: 9,
            baselineFrequency: 5,
        })).toBe("ignored");
    });

    test("ratio > 0.6 -> adopted", () => {
        expect(computeSuggestedVerdict({ opportunities: 10, addressed: 7, ratio: 0.7, built: true })).toBe("adopted");
    });

    test("ratio < 0.1 -> ignored", () => {
        expect(computeSuggestedVerdict({ opportunities: 10, addressed: 0, ratio: 0, built: true })).toBe("ignored");
    });

    test("middling ratio -> partial", () => {
        expect(computeSuggestedVerdict({ opportunities: 10, addressed: 3, ratio: 0.3, built: true })).toBe("partial");
    });
});

describe("dueCheckpointKinds", () => {
    test("nothing due at 2 sessions", () => {
        expect(dueCheckpointKinds(2, new Set()).length).toBe(0);
    });

    test("+3s due at exactly 3 sessions", () => {
        expect(dueCheckpointKinds(3, new Set())).toEqual(["+3s"]);
    });

    test("+3s and +10s due at 11 sessions", () => {
        expect(dueCheckpointKinds(11, new Set())).toEqual(["+3s", "+10s"]);
    });

    test("all three due at 30+ sessions", () => {
        expect(dueCheckpointKinds(30, new Set())).toEqual(["+3s", "+10s", "+30s"]);
        expect(dueCheckpointKinds(42, new Set())).toEqual(["+3s", "+10s", "+30s"]);
    });

    test("skips kinds already present in existing", () => {
        expect(dueCheckpointKinds(40, new Set(["+3s", "+10s"]))).toEqual(["+30s"]);
    });

    test("legacy day-based kinds in existing are not treated as the new session-based ones", () => {
        // A migrated experiment may have legacy t+7/t+30/t+90 rows. Those
        // don't satisfy the new windows; they're separate kinds. The new
        // session-based checkpoints should still emit.
        expect(dueCheckpointKinds(40, new Set(["t+7", "t+30", "t+90"]))).toEqual(["+3s", "+10s", "+30s"]);
    });
});

describe("checkpointKey", () => {
    test("deterministic and disambiguates by kind", () => {
        expect(checkpointKey("exp_a", "+3s")).toBe(checkpointKey("exp_a", "+3s"));
        expect(checkpointKey("exp_a", "+3s")).not.toBe(checkpointKey("exp_a", "+10s"));
    });

    test("uses a typed content hash ID", () => {
        const key = checkpointKey("exp_a", "+3s");
        expect(key).not.toContain("+");
        expect(key).toMatch(/^[0-9a-f]{32}$/);
    });
});

dtest("deriveCheckpoints uses DuckDB facts and SQLite judgments", async () => {
    const root = tempDir("ax-checkpoint-sidecar-");
    const lockPath = join(root, "ingest.lock");
    const snapshotPath = join(root, "snapshot.duckdb");
    const publish = withIngestLock({
        lockPath,
        command: "derive-checkpoints-test",
        staleMs: 60_000,
        onBusy: () => Effect.die("unexpected busy lock"),
    }, withCacheWrite({
        livePath: join(root, "live.duckdb"),
        lockPath,
        snapshotPath,
        schemaSql: CACHE_DDL,
        ...(dylibPath === null ? {} : { assetPath: dylibPath }),
    }, (write) => Effect.gen(function* () {
        yield* write.putMany("session", [1, 2, 3].map((n) => ({
            id: `session-${n}`,
            created_at: new Date(`2026-01-0${n + 1}T00:00:00Z`),
        })));
        yield* write.putMany("opportunity", [
            { id: "o1", in_id: "experiment-one", was_addressed: true },
            { id: "o2", in_id: "experiment-one", was_addressed: true },
            { id: "o3", in_id: "experiment-one", was_addressed: false },
        ]);
    })));
    await Effect.runPromise(publish.pipe(Effect.provide(Platform)));

    const layer = Layer.mergeAll(
        CacheReadLayer({ snapshotPath, ...(dylibPath === null ? {} : { assetPath: dylibPath }) }),
        JudgmentLayer({ sidecarPath: join(root, "judgment.sqlite"), schemaSql: SIDECAR_SCHEMA_SQL }),
    );
    const result = await Effect.runPromise(Effect.gen(function* () {
        const judgment = yield* Judgment;
        const now = new Date("2026-01-01T00:00:00Z");
        yield* judgment.put("proposal", {
            id: "proposal-one", form: "guidance", title: "T", hypothesis: "H", dedupe_sig: "sig",
            frequency: 3, confidence: "high", status: "accepted", origin: "agent",
            hypothesis_template: null, evidence_query: null, reject_reason: null,
            baseline: JSON.stringify({ frequency: 3 }), created_at: now, updated_at: now,
        });
        yield* judgment.put("experiment", {
            id: "experiment-one", proposal: "proposal-one", artifact: null,
            artifact_path: "/tmp/plan.md", scaffolded_at: now, created_at: now,
            locked_verdict: null, status: "scaffolded", task_path: null,
        });
        const stats = yield* deriveCheckpoints({ now: new Date("2026-02-01T00:00:00Z") });
        const rows = yield* judgment.rows(
            Schema.Struct({ kind: TextColumn, suggested: TextColumn }),
            "SELECT kind, suggested FROM checkpoint ORDER BY kind",
        );
        return { stats, rows };
    }).pipe(Effect.provide(layer), Effect.scoped));
    expect(result.stats.checkpointsInserted).toBe(1);
    expect(result.rows).toEqual([{ kind: "+3s", suggested: "adopted" }]);
});
