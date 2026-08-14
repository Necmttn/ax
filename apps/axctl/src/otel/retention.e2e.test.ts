import { beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { AppLayer } from "@ax/lib/layers";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { retainRecentOtel } from "./retention.ts";

const E2E_ENABLED = process.env.AX_E2E_DB === "1";
const TEST_TIMEOUT_MS = 30_000;
const TMP_DB = `retention_${Date.now().toString(36)}`;

// F5: retainRecentOtel loops the same DELETE over OTEL_TABLES with no
// per-table branching (see retention.ts), so one seeded table exercises the
// retention logic representatively. otel_metric_point also doubles as both
// endpoints of the telemetry_of edge case below, which is what actually
// differs per table (the dangling-edge prune).
const SCHEMA = `
    DEFINE TABLE otel_metric_point SCHEMAFULL;
    DEFINE FIELD harness ON otel_metric_point TYPE string;
    DEFINE FIELD metric ON otel_metric_point TYPE string;
    DEFINE FIELD value ON otel_metric_point TYPE number;
    DEFINE FIELD observed_at ON otel_metric_point TYPE datetime;
    DEFINE INDEX metric_observed ON otel_metric_point FIELDS observed_at CONCURRENTLY;

    DEFINE TABLE telemetry_of TYPE RELATION SCHEMAFULL;
    DEFINE FIELD linked_at ON telemetry_of TYPE datetime DEFAULT time::now();
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
    RELATE otel_metric_point:recent->telemetry_of->otel_metric_point:old;
    RELATE otel_metric_point:recent->telemetry_of->otel_metric_point:recent;
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

    test("removes old rows, keeps recent rows, and prunes the dangling telemetry_of edge", async () => {
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
                const retention = yield* retainRecentOtel();
                const [edgeRows] = yield* db.query<[Array<{ out: unknown }>]>(
                    "SELECT out FROM telemetry_of;",
                );
                return {
                    metricOld: yield* exists(db, "otel_metric_point:old"),
                    metricRecent: yield* exists(db, "otel_metric_point:recent"),
                    // The edge into the pruned `otel_metric_point:old` row must
                    // be gone too; the edge into the surviving `recent` row
                    // must remain. SurrealDB 3.0.x auto-drops a RELATION edge
                    // as soon as its target record is deleted, so by the time
                    // the explicit dangling-edge DELETE below runs, it usually
                    // finds nothing left to do - `deletedEdges` legitimately
                    // reads 0 while the edge is still gone (asserted via the
                    // surviving-edge count instead).
                    telemetryOfEdgeCount: (edgeRows ?? []).length,
                    retentionDeletedEdges: retention.deletedEdges,
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
            telemetryOfEdgeCount: 1,
            // SurrealDB already auto-dropped the dangling edge as a side
            // effect of the `otel_metric_point` delete above, so the
            // explicit cleanup query legitimately finds 0 left to prune.
            retentionDeletedEdges: 0,
        });
    }, TEST_TIMEOUT_MS);
});
