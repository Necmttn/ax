import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { executeStatements, recordRef } from "@ax/lib/shared/surreal";

interface Orphan { readonly id: string; readonly session_id: string }

const RELATABLE = ["otel_metric_point", "otel_span"] as const;

/**
 * Link every otel row whose session_id matches a session and that has no
 * telemetry_of edge yet. Runs at ingest finish; idempotent.
 *
 * NOTE: The SELECT uses SurrealDB v3 dialect. Two expressions need live-DB
 * validation:
 *   1. `type::thing("session", session_id)` - casts session_id string to a
 *      record reference for the IN check. If rejected, replace with:
 *      `AND string::concat("session:", session_id) IN (SELECT VALUE <string>id FROM session)`
 *   2. `count(<-telemetry_of) = 0` - counts incoming telemetry_of edges.
 *      If rejected by v3, use the fallback:
 *      `AND id NOTINSIDE (SELECT VALUE out FROM telemetry_of)`
 */
export const correlateOrphanOtel = () =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const stmts: string[] = [];
        for (const table of RELATABLE) {
            const q =
                `SELECT id, session_id FROM ${table} ` +
                `WHERE session_id != NONE ` +
                `AND type::thing("session", session_id) IN (SELECT VALUE id FROM session) ` +
                `AND count(<-telemetry_of) = 0;`;
            const res = yield* db.query<Orphan[][]>(q);
            const orphans = res[0] ?? [];
            for (const o of orphans) {
                // Strip "table:" prefix from the id to get the bare key, then
                // use recordRef for canonical escaped record references.
                const recId = o.id.includes(":") ? o.id.split(":").slice(1).join(":") : o.id;
                stmts.push(
                    `RELATE ${recordRef("session", o.session_id)}->telemetry_of->${recordRef(table, recId)};`,
                );
            }
        }
        if (stmts.length > 0) yield* executeStatements(stmts);
    });
