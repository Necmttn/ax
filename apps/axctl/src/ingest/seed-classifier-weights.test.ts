import { expect } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { join } from "node:path";
import { CacheRead, CacheReadLayer, withCacheWrite, type CacheWriteService } from "@ax/lib/duckdb/seam";
import { withIngestLock } from "@ax/lib/ingest-lock";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { seedClassifierWeights } from "./seed-classifier-weights.ts";
import { JUDGMENT_MODEL_SEED, type JudgmentModelSeed } from "../queries/judgment-weights.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("seed classifier weights");
const Platform = Layer.merge(BunFileSystem.layer, BunPath.layer);

const CACHE_DDL = `
CREATE TABLE classifier_weights (
    id VARCHAR PRIMARY KEY,
    model_id VARCHAR NOT NULL,
    feature VARCHAR NOT NULL,
    weight DOUBLE NOT NULL,
    threshold DOUBLE NOT NULL,
    version VARCHAR NOT NULL,
    trained_at TIMESTAMP
);
`;

const WeightRow = Schema.Struct({
    model_id: Schema.String,
    feature: Schema.String,
    weight: Schema.Number,
    threshold: Schema.Number,
    version: Schema.String,
});

interface RunResult {
    readonly snapshotPath: string;
}

/** Run one `withCacheWrite` body against a fresh temp store, publish, return
 *  the snapshot path for a follow-up read. */
function run(root: string, body: (write: CacheWriteService) => Effect.Effect<void, unknown>): Effect.Effect<RunResult, unknown> {
    const lockPath = join(root, "ingest.lock");
    const snapshotPath = join(root, "snapshot.duckdb");
    const publish = withIngestLock({
        lockPath,
        command: "seed-classifier-weights-test",
        staleMs: 60_000,
        onBusy: () => Effect.die("unexpected busy lock"),
    }, withCacheWrite({
        livePath: join(root, "live.duckdb"),
        lockPath,
        snapshotPath,
        schemaSql: CACHE_DDL,
        ...(dylibPath === null ? {} : { assetPath: dylibPath }),
    }, body));
    return publish.pipe(Effect.provide(Platform), Effect.map(() => ({ snapshotPath })));
}

function readRows(snapshotPath: string) {
    const layer = CacheReadLayer({ snapshotPath, ...(dylibPath === null ? {} : { assetPath: dylibPath }) });
    return Effect.gen(function* () {
        const read = yield* CacheRead;
        return yield* read.rows(WeightRow, "SELECT model_id, feature, weight, threshold, version FROM classifier_weights ORDER BY feature");
    }).pipe(Effect.provide(layer), Effect.scoped);
}

dtest("seeds all weight rows for the committed constants on a fresh table", async () => {
    const root = tempDir("ax-classifier-weights-");
    const { snapshotPath } = await Effect.runPromise(run(root, (write) => seedClassifierWeights(write)));
    const rows = await Effect.runPromise(readRows(snapshotPath));
    expect(rows).toHaveLength(Object.keys(JUDGMENT_MODEL_SEED.weights).length);
    expect(rows.every((r) => r.model_id === JUDGMENT_MODEL_SEED.modelId)).toBe(true);
    expect(rows.every((r) => r.threshold === JUDGMENT_MODEL_SEED.threshold)).toBe(true);
    expect(rows.every((r) => r.version === JUDGMENT_MODEL_SEED.version)).toBe(true);
    const bias = rows.find((r) => r.feature === "bias");
    expect(bias?.weight).toBe(JUDGMENT_MODEL_SEED.weights.bias);
});

dtest("re-running the SAME version is a no-op (idempotent)", async () => {
    const root = tempDir("ax-classifier-weights-idem-");
    const { snapshotPath } = await Effect.runPromise(run(root, (write) =>
        Effect.gen(function* () {
            yield* seedClassifierWeights(write);
            yield* seedClassifierWeights(write); // second run, same version
        })));
    const rows = await Effect.runPromise(readRows(snapshotPath));
    expect(rows).toHaveLength(Object.keys(JUDGMENT_MODEL_SEED.weights).length);
});

dtest("a NEW version replaces the old one, deleting stale rows", async () => {
    const root = tempDir("ax-classifier-weights-replace-");
    const v1: JudgmentModelSeed = {
        modelId: "judgment-v1",
        version: "v1-test",
        trainedAt: "2026-01-01T00:00:00Z",
        threshold: 0.4,
        weights: { bias: -1, editCount: 0.1 },
    };
    const v2: JudgmentModelSeed = {
        modelId: "judgment-v1",
        version: "v2-test",
        trainedAt: "2026-01-02T00:00:00Z",
        threshold: 0.6,
        weights: { bias: -2, editCount: 0.2, readCount: 0.3 },
    };
    const { snapshotPath } = await Effect.runPromise(run(root, (write) =>
        Effect.gen(function* () {
            yield* seedClassifierWeights(write, v1);
            yield* seedClassifierWeights(write, v2);
        })));
    const rows = await Effect.runPromise(readRows(snapshotPath));
    expect(rows.every((r) => r.version === "v2-test")).toBe(true);
    expect(rows).toHaveLength(3); // v2's weights, not v1's 2
    expect(rows.every((r) => r.threshold === 0.6)).toBe(true);
});
