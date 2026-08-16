import { Effect, Schema } from "effect";
import { cacheRow } from "@ax/lib/duckdb/row";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { stableId } from "@ax/lib/stable-id";

const RELATABLE = ["otel_metric_point", "otel_span", "otel_log_event"] as const;
const SCAN_WINDOW_DAYS = 2;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export const bareUuid = (value: unknown): string | null => {
    if (value == null) return null;
    const text = typeof value === "string" ? value : String((value as { id?: unknown }).id ?? value);
    return UUID_RE.exec(text)?.[0]?.toLowerCase() ?? null;
};

const IdRow = Schema.Struct({ id: Schema.String });
const TelemetryRow = Schema.Struct({ id: Schema.String, session_id: Schema.NullOr(Schema.String) });

/** Link each recent telemetry session to one representative telemetry row. */
export const correlateOrphanOtel = (write: CacheWriteService) =>
    Effect.gen(function* () {
        const sessions = new Set((yield* write.rows(IdRow, "SELECT id FROM session")).map((row) => row.id));
        const linked = new Set(
            (yield* write.rows(Schema.Struct({ in_id: Schema.String }), "SELECT in_id FROM telemetry_of"))
                .map((row) => row.in_id),
        );
        const seen = new Set<string>();

        for (const table of RELATABLE) {
            const rows = yield* write.rows(
                TelemetryRow,
                `SELECT id, session_id FROM ${table}
                 WHERE observed_at > CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - INTERVAL '${SCAN_WINDOW_DAYS} days'
                   AND session_id IS NOT NULL
                 QUALIFY row_number() OVER (PARTITION BY session_id ORDER BY observed_at DESC) = 1`,
            );
            for (const row of rows) {
                const uuid = bareUuid(row.session_id);
                if (uuid === null || seen.has(uuid) || linked.has(uuid) || !sessions.has(uuid)) continue;
                seen.add(uuid);
                yield* write.put("telemetry_of", cacheRow({
                    id: stableId("telemetry_of", [uuid, table, row.id]),
                    in_id: uuid,
                    out_id: row.id,
                    out_table: table,
                    linked_at: new Date(),
                }));
            }
        }
    });
