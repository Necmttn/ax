import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";

const OTEL_TABLES = ["otel_metric_point", "otel_span", "otel_log_event"] as const;

/** Keep only the latest 30 days of stored OTLP rows. */
export const retainRecentOtel = Effect.fn("otel.retention")(function* () {
    const db = yield* SurrealClient;
    yield* Effect.forEach(
        OTEL_TABLES,
        (table) =>
            db.query(
                `DELETE ${table} WHERE id IN (`
                    + `SELECT VALUE id FROM ${table} WHERE observed_at < time::now() - 30d`
                    + `);`,
            ),
        { discard: true },
    );
});
