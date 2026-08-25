/**
 * `fetchRunEvidence` (#578) against a REAL published DuckDB snapshot that
 * predates the run-evidence ledger tables (#675).
 *
 * The normal DuckDB upgrade path applies the current DDL to the live cache,
 * but a snapshot PUBLISHED before that DDL landed - or restored from an older
 * backup - still lacks `run_evidence_event` and `run_evidence_ref`. Before
 * this fix, `ax runs evidence` read that snapshot directly and every one of
 * its four queries failed with a raw `DuckDbQueryError` ("table does not
 * exist"). The fix adds an explicit catalog check that short-circuits to the
 * SAME zero-event `RunEvidenceResult` shape a session with no rows already
 * produces - so the renderer's existing empty-state branch handles it with no
 * changes.
 *
 * This suite proves that against a genuine snapshot file (no mocked seam):
 * publish the fixture with the CURRENT schema (which creates both tables),
 * then `DROP TABLE` them directly on the snapshot to reproduce a pre-ledger
 * publish, and read through the real `CacheRead` layer.
 */
import { describe, expect } from "bun:test";
import { Effect, FileSystem, type Path } from "effect";
import { openDuckDbService } from "@ax/lib/duckdb/client";
import { publishCacheFixture, readFixture, runWithPlatform, type CacheFixture } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { RUN_EVIDENCE_BACKINGS, RUN_EVIDENCE_KINDS } from "@ax/lib/shared/run-evidence";
import { fetchRunEvidence, RUN_EVIDENCE_COVERED_KINDS } from "./run-evidence.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("run evidence pre-ledger", { requireFts: true });

const SESSION = "019e2531-b552-7b53-a029-c780adbb6560";

/**
 * Publish a fixture with the CURRENT schema (both ledger tables exist), then
 * drop the ledger tables directly on the published snapshot file - a real
 * pre-ledger publish, not a synthetic empty-table stand-in.
 */
const publishPreLedgerFixture = (dir: string): Effect.Effect<CacheFixture, unknown, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fixture = yield* publishCacheFixture(dir, dylibPath, () => Effect.void);
        const fs = yield* FileSystem.FileSystem;
        const opened = yield* openDuckDbService(fs, dylibPath === null ? {} : { assetPath: dylibPath });
        const conn = yield* opened.db.open(fixture.snapshotPath, { readOnly: false });
        yield* conn.exec("DROP TABLE run_evidence_ref");
        yield* conn.exec("DROP TABLE run_evidence_event");
        yield* conn.close;
        opened.close();
        return fixture;
    });

describe("fetchRunEvidence over a pre-ledger published snapshot (#675)", () => {
    dtest("returns the empty RunEvidenceResult instead of failing", async () => {
        const dir = tempDir("run-evidence-pre-ledger");
        const fixture = await runWithPlatform(publishPreLedgerFixture(dir));

        const layer = readFixture(fixture.snapshotPath, dylibPath);
        const result = await Effect.runPromise(
            fetchRunEvidence({ sessionId: `session:\`${SESSION}\``, timelineLimit: 7 }).pipe(Effect.provide(layer)),
        );

        // Bare session id, even though the ledger never ran - the catalog
        // check short-circuits AFTER `toBareSessionId`, not before it.
        expect(result.session_id).toBe(SESSION);

        // Zero totals, empty timeline and refs.
        expect(result.total).toBe(0);
        expect(result.timeline).toEqual([]);
        expect(result.ref_total).toBe(0);
        expect(result.by_ref_kind).toEqual([]);
        expect(result.objective).toBeNull();
        expect(result.repo).toBeNull();

        // The full taxonomy is present at zero - the same honest-zeros
        // contract a populated-but-empty session gets, not a truncated list.
        expect(result.by_kind).toEqual(
            RUN_EVIDENCE_KINDS.map((key) => ({ key, count: 0 })),
        );
        expect(result.by_backing).toEqual(
            RUN_EVIDENCE_BACKINGS.map((key) => ({ key, count: 0 })),
        );
        expect(result.covered_kinds).toEqual([...RUN_EVIDENCE_COVERED_KINDS]);

        // The requested timeline limit is still reported honestly.
        expect(result.timeline_limit).toBe(7);
    });

    dtest("still fails on an unrelated query error once the ledger tables exist", async () => {
        const dir = tempDir("run-evidence-unrelated-error");
        const fixture = await runWithPlatform(
            Effect.gen(function* () {
                const built = yield* publishCacheFixture(dir, dylibPath, () => Effect.void);
                const fs = yield* FileSystem.FileSystem;
                const opened = yield* openDuckDbService(fs, dylibPath === null ? {} : { assetPath: dylibPath });
                const conn = yield* opened.db.open(built.snapshotPath, { readOnly: false });
                // Both ledger tables exist (the catalog check passes), but a
                // column the read queries select is gone - a real schema-drift
                // failure that must NOT be swallowed by the new short-circuit.
                // DuckDB refuses to ALTER a table while any index on it
                // exists ("entries that depend on it"), so the table's own
                // indexes have to go first.
                yield* conn.exec("DROP INDEX run_evidence_event_session");
                yield* conn.exec("DROP INDEX run_evidence_event_kind");
                yield* conn.exec("DROP INDEX run_evidence_event_source");
                yield* conn.exec("DROP INDEX run_evidence_event_observed");
                yield* conn.exec("ALTER TABLE run_evidence_event DROP COLUMN summary");
                yield* conn.close;
                opened.close();
                return built;
            }),
        );

        const layer = readFixture(fixture.snapshotPath, dylibPath);
        const failure = await Effect.runPromise(
            Effect.flip(fetchRunEvidence({ sessionId: SESSION }).pipe(Effect.provide(layer))),
        );

        expect(failure._tag).toBe("DuckDbQueryError");
    });
});
