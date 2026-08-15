import { describe, expect } from "bun:test";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { join } from "node:path";
import { DUCKDB_SCHEMA_SQL } from "@ax/schema/duckdb-ddl";
import { CacheReadLayer, withCacheWrite } from "@ax/lib/duckdb/seam";
import { withIngestLock } from "@ax/lib/ingest-lock";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { classifierExplainSql, classifierResultsSql, fetchClassifierExplain, turnRecordRefFromInput, type ClassifierExplainPayload } from "./classifier-explain.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("classifier explain");
const Platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const fixture = () => {
    const dir = tempDir("ax-classifier-explain-");
    const livePath = join(dir, "live.duckdb");
    const snapshotPath = join(dir, "snapshot.duckdb");
    const lockPath = join(dir, "ingest.lock");
    const options = { livePath, snapshotPath, lockPath, schemaSql: DUCKDB_SCHEMA_SQL,
        ...(dylibPath === null ? {} : { assetPath: dylibPath }) };
    const write = withIngestLock(
        { lockPath, command: "test", staleMs: 60_000, onBusy: () => Effect.die("busy") },
        withCacheWrite(options, (db) => Effect.gen(function* () {
            yield* db.put("session", { id: "s1", source: "claude" });
            yield* db.put("turn", { id: "u1", session: "s1", seq: 1, ts: new Date("2026-08-15T00:00:00Z"), role: "user", text: "did you run tests?", text_excerpt: "did you run tests?", has_tool_use: false, has_error: false });
            yield* db.put("classifier_definition", { id: "d1", classifier_key: "verification-event", version: "0.1.0", kind: "heuristic", description: "test", input: "turn", labels: "[]", targets: "[]" });
            yield* db.put("classifier_result", { id: "r1", classifier_definition: "d1", classifier_key: "verification-event", classifier_version: "0.1.0", subject_type: "turn", subject_id: "u1", session: "s1", turn: "u1", label: "verification_request", target: "test_required", polarity: "revise", durability: "session_preference", confidence: 0.86, method: "heuristic", evidence_json: "{}", signals: "[]", ts: new Date("2026-08-15T00:00:01Z") });
        })),
    );
    const read = fetchClassifierExplain("turn:u1").pipe(Effect.provide(CacheReadLayer({ snapshotPath,
        ...(dylibPath === null ? {} : { assetPath: dylibPath }) })));
    return Effect.runPromise(write.pipe(Effect.flatMap(() => read), Effect.provide(Platform)) as Effect.Effect<ClassifierExplainPayload, unknown>);
};

describe("classifier explain query", () => {
    dtest("uses bound DuckDB identifiers and returns ISO timestamps", async () => {
        expect(turnRecordRefFromInput("turn:u1")).toBe("u1");
        expect(classifierExplainSql()).toContain("id = ?");
        expect(classifierResultsSql()).toContain("turn = ?");
        const payload = await fixture();
        expect(payload.turn?.id).toBe("u1");
        expect(payload.turn?.ts).toBe("2026-08-15T00:00:00.000Z");
        expect(payload.results[0]?.classifier_key).toBe("verification-event");
        expect(payload.results[0]?.ts).toBe("2026-08-15T00:00:01.000Z");
    });
});
