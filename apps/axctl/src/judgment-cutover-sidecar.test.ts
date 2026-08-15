import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SurrealClient } from "@ax/lib/db";
import { Judgment, JudgmentLayer, NumberColumn, TextColumn } from "@ax/lib/sqlite";
import { SIDECAR_SCHEMA_SQL } from "@ax/schema/sidecar-ddl";
import { upsertRetro } from "./ingest/retro.ts";
import { stampSparSession } from "./dojo/spar.ts";
import { writeDogfoodResult } from "./dogfood/wterm.ts";
import { LabelMiningService, LabelMiningServiceLive } from "./classifiers/label-mining-service.ts";

const makeSidecar = () => {
    const root = mkdtempSync(join(tmpdir(), "ax-judgment-cutover-"));
    return JudgmentLayer({ sidecarPath: join(root, "judgment.sqlite"), schemaSql: SIDECAR_SCHEMA_SQL });
};

describe("judgment cutover sidecar", () => {
    test("stores retro, dogfood, and spar judgments in real SQLite", async () => {
        const counts = await Effect.runPromise(Effect.gen(function* () {
            const judgment = yield* Judgment;
            yield* upsertRetro({
                sessionId: "session-a", source: "manual",
                payload: { tried: "test", worked: "yes", failed: null, next: null },
            });
            yield* stampSparSession("session:session-a");
            yield* writeDogfoodResult({
                runId: "run-a", scenario: "interactive", status: "completed", transcript: "ok",
                startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:00:01Z",
                cwd: "/tmp", markerFound: true, persisted: false, transport: "process",
                requestedTransport: "process", command: "true", commandSource: "override", timedOut: false,
            });
            return yield* judgment.rows(
                Schema.Struct({ table_name: TextColumn, count: NumberColumn }),
                `SELECT 'retro' AS table_name, count(*) AS count FROM retro
                 UNION ALL SELECT 'dogfood_run', count(*) FROM dogfood_run
                 UNION ALL SELECT 'session_label', count(*) FROM session_label
                 ORDER BY table_name`,
            );
        }).pipe(Effect.provide(makeSidecar()), Effect.scoped));
        expect(Object.fromEntries(counts.map((row) => [row.table_name, row.count]))).toEqual({
            dogfood_run: 1,
            retro: 1,
            session_label: 1,
        });
    });

    test("reads transcript reviews from SQLite while facts remain in the graph store", async () => {
        const sidecar = makeSidecar();
        const graph = Layer.succeed(SurrealClient, {
            query: () => Effect.succeed([[]]),
        } as never);
        const result = await Effect.runPromise(Effect.gen(function* () {
            const judgment = yield* Judgment;
            yield* judgment.put("transcript_label_review", {
                id: "review-a", candidate_id: "candidate-a", graph_fact_id: null,
                label_family: "correction", review_status: "pending", promotion_safe: false,
                reviewed_label: null, reviewed_target: null, reviewer: "human", rationale: "review",
                evidence_paths_json: "[]", updated_at: new Date(),
            });
            const service = yield* LabelMiningService;
            return yield* service.selfImproveQuery({});
        }).pipe(
            Effect.provide(LabelMiningServiceLive),
            Effect.provide(Layer.mergeAll(sidecar, graph, BunFileSystem.layer, BunPath.layer)),
            Effect.scoped,
        ));
        expect(result.weak_advisory_candidate_count).toBe(1);
        expect(result.reviewed_promotion_safe_fact_count).toBe(0);
    });
});
