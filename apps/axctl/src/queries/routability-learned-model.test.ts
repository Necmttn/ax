/**
 * #911 Phase 5 landed slice - `loadLearnedJudgmentModel` env-gated wiring.
 * Separate file from routability.test.ts because these tests touch a real
 * DuckDB store (routability.test.ts is pure-function unit tests only).
 *
 * The "never reads classifier_weights when the flag is off" claim is proven
 * with a COUNTING fake `CacheRead` service rather than by inference from a
 * missing/broken layer: `cacheRows` fails OPEN on any read error (logs +
 * degrades to `[]`), so a broken layer can't distinguish "never queried"
 * from "queried and failed" by exceptions alone - only a call counter can.
 */
import { expect } from "bun:test";
import { Effect, Layer, Option } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { join } from "node:path";
import { CacheRead, CacheReadLayer, withCacheWrite, type CacheReadService } from "@ax/lib/duckdb/seam";
import { withIngestLock } from "@ax/lib/ingest-lock";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { loadLearnedJudgmentModel } from "./routability.ts";
import { JUDGMENT_MODEL_SEED } from "./judgment-weights.ts";
import { seedClassifierWeights } from "../ingest/seed-classifier-weights.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("routability learned model loader");
const Platform = Layer.merge(BunFileSystem.layer, BunPath.layer);

function withEnv<A>(value: string | undefined, thunk: () => Promise<A>): Promise<A> {
    const prev = process.env.AX_JUDGMENT_MODEL;
    if (value === undefined) delete process.env.AX_JUDGMENT_MODEL;
    else process.env.AX_JUDGMENT_MODEL = value;
    return thunk().finally(() => {
        if (prev === undefined) delete process.env.AX_JUDGMENT_MODEL;
        else process.env.AX_JUDGMENT_MODEL = prev;
    });
}

/** A CacheRead test double that counts `.rows` calls and returns whatever
 *  `rowsResult` yields - no real DuckDB file involved. */
function countingCacheRead(rowsResult: ReadonlyArray<Record<string, unknown>>) {
    let calls = 0;
    const service: CacheReadService = {
        rows: (() => {
            calls++;
            return Effect.succeed(rowsResult) as ReturnType<CacheReadService["rows"]>;
        }) as CacheReadService["rows"],
        first: () => Effect.succeed(Option.none()) as ReturnType<CacheReadService["first"]>,
        raw: () => Effect.die("not used in these tests") as ReturnType<CacheReadService["raw"]>,
        snapshotPath: "test:counting",
    };
    return { layer: Layer.succeed(CacheRead, service), callCount: () => calls };
}

for (const [label, value] of [["unset", undefined], ["empty string", ""], ["other value", "sonnet"]] as const) {
    dtest(`AX_JUDGMENT_MODEL ${label} -> never calls CacheRead.rows`, async () => {
        const { layer, callCount } = countingCacheRead([]);
        const result = await withEnv(value, () =>
            Effect.runPromise(loadLearnedJudgmentModel().pipe(Effect.provide(layer), Effect.scoped)));
        expect(result).toBeUndefined();
        expect(callCount()).toBe(0);
    });
}

dtest("AX_JUDGMENT_MODEL=learned, no rows -> calls once, falls back to undefined (regex floor), no crash", async () => {
    const { layer, callCount } = countingCacheRead([]);
    const result = await withEnv("learned", () =>
        Effect.runPromise(loadLearnedJudgmentModel().pipe(Effect.provide(layer), Effect.scoped)));
    expect(result).toBeUndefined();
    expect(callCount()).toBe(1);
});

dtest("AX_JUDGMENT_MODEL=learned, malformed rows (missing a feature) -> falls back to undefined", async () => {
    const { layer } = countingCacheRead([{ feature: "bias", weight: -1, threshold: 0.5 }]); // only 1 of 12 features
    const result = await withEnv("learned", () =>
        Effect.runPromise(loadLearnedJudgmentModel().pipe(Effect.provide(layer), Effect.scoped)));
    expect(result).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Integration: real DuckDB round trip through seedClassifierWeights.
// ---------------------------------------------------------------------------

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

dtest("AX_JUDGMENT_MODEL=learned + real seeded weights -> returns the model, matching the seed", async () => {
    const root = tempDir("ax-learned-model-seeded-");
    const lockPath = join(root, "ingest.lock");
    const snapshotPath = join(root, "snapshot.duckdb");
    await Effect.runPromise(withIngestLock({
        lockPath,
        command: "routability-learned-model-test",
        staleMs: 60_000,
        onBusy: () => Effect.die("unexpected busy lock"),
    }, withCacheWrite({
        livePath: join(root, "live.duckdb"),
        lockPath,
        snapshotPath,
        schemaSql: CACHE_DDL,
        ...(dylibPath === null ? {} : { assetPath: dylibPath }),
    }, (write) => seedClassifierWeights(write))).pipe(Effect.provide(Platform)));

    const layer = CacheReadLayer({ snapshotPath, ...(dylibPath === null ? {} : { assetPath: dylibPath }) });
    const result = await withEnv("learned", () =>
        Effect.runPromise(loadLearnedJudgmentModel().pipe(Effect.provide(layer), Effect.scoped)));
    expect(result).toBeDefined();
    expect(result?.threshold).toBe(JUDGMENT_MODEL_SEED.threshold);
    expect(result?.weights.bias).toBe(JUDGMENT_MODEL_SEED.weights.bias);
    expect(Object.keys(result?.weights ?? {})).toHaveLength(Object.keys(JUDGMENT_MODEL_SEED.weights).length);
});
