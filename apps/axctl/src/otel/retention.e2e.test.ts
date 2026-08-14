import { beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { AppLayer } from "@ax/lib/layers";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { retainRecentOtel } from "./retention.ts";

const E2E_ENABLED = process.env.AX_E2E_DB === "1";
const TEST_TIMEOUT_MS = 30_000;
const TMP_DB = `retention_${Date.now().toString(36)}`;

const SCHEMA = `
    DEFINE TABLE otel_metric_point SCHEMAFULL;
    DEFINE FIELD harness ON otel_metric_point TYPE string;
    DEFINE FIELD metric ON otel_metric_point TYPE string;
    DEFINE FIELD value ON otel_metric_point TYPE number;
    DEFINE FIELD observed_at ON otel_metric_point TYPE datetime;
    DEFINE INDEX metric_observed ON otel_metric_point FIELDS observed_at CONCURRENTLY;

    DEFINE TABLE otel_span SCHEMAFULL;
    DEFINE FIELD harness ON otel_span TYPE string;
    DEFINE FIELD name ON otel_span TYPE string;
    DEFINE FIELD trace_id ON otel_span TYPE string;
    DEFINE FIELD span_id ON otel_span TYPE string;
    DEFINE FIELD started_at ON otel_span TYPE datetime;
    DEFINE FIELD ended_at ON otel_span TYPE datetime;
    DEFINE FIELD duration_ms ON otel_span TYPE number;
    DEFINE FIELD observed_at ON otel_span TYPE datetime;
    DEFINE INDEX span_observed ON otel_span FIELDS observed_at CONCURRENTLY;

    DEFINE TABLE otel_log_event SCHEMAFULL;
    DEFINE FIELD harness ON otel_log_event TYPE string;
    DEFINE FIELD event_name ON otel_log_event TYPE string;
    DEFINE FIELD observed_at ON otel_log_event TYPE datetime;
    DEFINE INDEX log_observed ON otel_log_event FIELDS observed_at CONCURRENTLY;
`;

const seed = (db: SurrealClientShape) => db.query(`
    UPSERT otel_metric_point:old CONTENT {
        harness: "test", metric: "test", value: 1,
        observed_at: time::now() - 31d
    };
    UPSERT otel_metric_point:recent CONTENT {
        harness: "test", metric: "test", value: 1,
        observed_at: time::now()
    };
    UPSERT otel_span:old CONTENT {
        harness: "test", name: "test", trace_id: "old", span_id: "old",
        started_at: time::now() - 31d, ended_at: time::now() - 31d,
        duration_ms: 1, observed_at: time::now() - 31d
    };
    UPSERT otel_span:recent CONTENT {
        harness: "test", name: "test", trace_id: "recent", span_id: "recent",
        started_at: time::now(), ended_at: time::now(),
        duration_ms: 1, observed_at: time::now()
    };
    UPSERT otel_log_event:old CONTENT {
        harness: "test", event_name: "test",
        observed_at: time::now() - 31d
    };
    UPSERT otel_log_event:recent CONTENT {
        harness: "test", event_name: "test",
        observed_at: time::now()
    };
`);

const exists = (db: SurrealClientShape, record: string) =>
    db.query<[{ id: unknown }[]]>(`SELECT id FROM ${record};`).pipe(
        Effect.map((rows) => (rows?.[0]?.length ?? 0) > 0),
    );

const run = <A, E>(effect: Effect.Effect<A, E, SurrealClient>): Promise<A> =>
    Effect.runPromise(
        effect.pipe(Effect.provide(AppLayer)) as Effect.Effect<A, E, never>,
    );

describe("OTLP retention (live DB)", () => {
    let dbReachable = false;

    beforeAll(async () => {
        if (!E2E_ENABLED) return;
        try {
            await run(Effect.gen(function* () {
                const db = yield* SurrealClient;
                yield* db.query("RETURN 1;");
            }));
            dbReachable = true;
        } catch {
            // The guarded test reports a skip below.
        }
    });

    test("removes old rows and keeps recent rows in every OTLP table", async () => {
        if (!E2E_ENABLED || !dbReachable) {
            console.log("(skipped - set AX_E2E_DB=1 with a live SurrealDB to run)");
            expect(true).toBe(true);
            return;
        }

        const result = await run(Effect.gen(function* () {
            const db = yield* SurrealClient;
            const scenario = Effect.gen(function* () {
                yield* Effect.promise(() => db.raw.use({ namespace: "ax", database: TMP_DB }));
                yield* db.query(SCHEMA);
                yield* seed(db);
                yield* retainRecentOtel();
                return {
                    metricOld: yield* exists(db, "otel_metric_point:old"),
                    metricRecent: yield* exists(db, "otel_metric_point:recent"),
                    spanOld: yield* exists(db, "otel_span:old"),
                    spanRecent: yield* exists(db, "otel_span:recent"),
                    logOld: yield* exists(db, "otel_log_event:old"),
                    logRecent: yield* exists(db, "otel_log_event:recent"),
                };
            });
            const cleanup = Effect.gen(function* () {
                yield* Effect.promise(() => db.raw.use({ namespace: "ax", database: "main" }));
                yield* db.query(`REMOVE DATABASE ${TMP_DB};`).pipe(Effect.ignore);
            });
            return yield* scenario.pipe(Effect.ensuring(cleanup));
        }));

        expect(result).toEqual({
            metricOld: false,
            metricRecent: true,
            spanOld: false,
            spanRecent: true,
            logOld: false,
            logRecent: true,
        });
    }, TEST_TIMEOUT_MS);
});
