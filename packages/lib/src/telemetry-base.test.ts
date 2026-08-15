/**
 * The cache-side row builder for telemetry rows.
 *
 * The WRITE cannot be ported yet (a hook cannot hold the ingest lock - see the
 * module header), but the ROW SHAPE can be, and it is the half that has to be
 * right before any spool-drain stage exists: it is where a Surreal record ref
 * has to become a bare row id, and where an array has to become JSON text.
 *
 * The last case writes a real `hook_fire` row into a real DuckDB, because
 * "does this row satisfy the DDL's NOT NULLs and read back" is a question about
 * the schema, not about the mapper.
 */
import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { JsonArrayColumn, TimestampColumn } from "./duckdb/columns.ts";
import { cacheFirst } from "./duckdb/query.ts";
import { publishCacheFixture, readFixture, runWithPlatform } from "./testing/cache-fixture.ts";
import { duckdbTestSetup } from "./testing/duckdb-dylib.ts";
import { telemetryCacheRow, type TelemetryBaseRow } from "./telemetry-base.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("telemetry cache row", {
    requireFts: true,
});

const TS = "2026-08-15T10:00:00.000Z";

const base: TelemetryBaseRow = {
    id: "fire-1",
    ts: new Date(TS),
    kind: "hook_fire",
    session: "session:⟨8a53d7e0-69b9-4b51-8828-7fdccfaf4899⟩",
    file: undefined,
    file_path: "/w/ax/src/a.ts",
    harness: "claude",
    ok: true,
    latency_ms: 42,
};

describe("telemetryCacheRow", () => {
    test("unwraps a Surreal record ref to the bare row id", () => {
        // `session.id` in the cache IS the provider session uuid (see
        // sessionRowId), so a `session:⟨uuid⟩` ref would join to nothing.
        const row = telemetryCacheRow(base);

        expect(row.session).toBe("8a53d7e0-69b9-4b51-8828-7fdccfaf4899");
        expect(row.id).toBe("fire-1");
        expect(row.kind).toBe("hook_fire");
    });

    test("keeps a value that is already a bare row id", () => {
        const row = telemetryCacheRow({ ...base, session: "8a53d7e0" });
        expect(row.session).toBe("8a53d7e0");
    });

    test("maps an absent ref to NULL and KEEPS the column", () => {
        // Dropping the key makes a batch ragged, which putMany refuses.
        const row = telemetryCacheRow(base);
        expect(row.file).toBeNull();
        expect(Object.keys(row)).toContain("file");
    });

    test("binds the timestamp as a Date", () => {
        const row = telemetryCacheRow(base);
        expect(row.ts).toBeInstanceOf(Date);
        expect((row.ts as Date).toISOString()).toBe(TS);
    });

    test("encodes arrays and nested objects as JSON text", () => {
        const row = telemetryCacheRow({
            ...base,
            top_prior_sessions: ["a", "b"],
            injected_titles: [],
            detail: { why: "high_signal" },
        } as TelemetryBaseRow & Record<string, unknown>);

        expect(row.top_prior_sessions).toBe('["a","b"]');
        expect(row.injected_titles).toBe("[]");
        expect(row.detail).toBe('{"why":"high_signal"}');
    });

    test("passes scalars through unchanged, including false and zero", () => {
        const row = telemetryCacheRow({
            ...base,
            ok: false,
            latency_ms: 0,
            inject: false,
            prior_sessions_considered: 0,
        } as TelemetryBaseRow & Record<string, unknown>);

        expect(row.ok).toBe(false);
        expect(row.latency_ms).toBe(0);
        expect(row.inject).toBe(false);
        expect(row.prior_sessions_considered).toBe(0);
    });
});

describe("against the real hook_fire table", () => {
    const HookFireRow = Schema.Struct({
        id: Schema.String,
        ts: TimestampColumn,
        session: Schema.NullOr(Schema.String),
        ok: Schema.Boolean,
        top_prior_sessions: JsonArrayColumn(Schema.String),
        injected_titles: JsonArrayColumn(Schema.String),
    });

    dtest("the built row satisfies the DDL and reads back", async () => {
        const row = telemetryCacheRow({
            ...base,
            event: "pre-edit",
            inject: true,
            reason: "high_signal",
            prior_sessions_considered: 3,
            task_excerpt: "port the watermark",
            top_prior_sessions: ["s1", "s2"],
            injected_titles: ["one"],
        } as TelemetryBaseRow & Record<string, unknown>);

        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-telemetry-row-"), dylibPath, (w) =>
                w.put("hook_fire", row),
            ),
        );

        const found = await Effect.runPromise(
            cacheFirst(
                HookFireRow,
                {
                    sql: "SELECT id, ts, session, ok, top_prior_sessions, injected_titles FROM hook_fire WHERE id = ?",
                    params: ["fire-1"],
                },
                "telemetry row test",
            ).pipe(Effect.provide(readFixture(fixture.snapshotPath, dylibPath))) as Effect.Effect<
                Schema.Schema.Type<typeof HookFireRow> | null,
                never,
                never
            >,
        );

        expect(found?.ts.toISOString()).toBe(TS);
        expect(found?.session).toBe("8a53d7e0-69b9-4b51-8828-7fdccfaf4899");
        expect(found?.ok).toBe(true);
        expect(found?.top_prior_sessions).toEqual(["s1", "s2"]);
        expect(found?.injected_titles).toEqual(["one"]);
    });
});
