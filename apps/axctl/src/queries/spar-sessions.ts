/**
 * Fetch the set of session ids tagged as spar variant sessions.
 *
 * Spar-score stamps the variant session's `labels` field with the JSON-encoded
 * string `["spar"]`. This helper returns a flat id list used by behavioral
 * analytics surfaces (`ax skills weighted`, `ax thinking`) to exclude spar
 * sessions from their rollups.
 *
 * Spec: docs/superpowers/specs/2026-06-15-spar-exclusion-tag-design.md
 */
import { Effect, Schema } from "effect";
import { cacheRows } from "@ax/lib/duckdb/query";
import { CacheRead } from "@ax/lib/duckdb/seam";

/**
 * RecordIds of sessions tagged as spar variants (behavioral-analytics
 * exclusion). Returns a flat array of `RecordId` values (NOT strings).
 * Returns `[]` when no spar sessions exist.
 *
 * IMPORTANT: the ids are RAW `record<session>` values, not `type::string(id)`
 * strings. `invoked.session` / `session.id` are record links, and SurrealDB
 * compares `record<session> NOT IN [<string>...]` as ALWAYS-TRUE (the string
 * IN-list silently matches nothing - documented rule, see
 * @ax/lib/shared/record-select). The exclusion at the
 * weighted aggregate binds these RecordIds so the comparison is
 * record-vs-record and actually fires. Verified empirically on the live DB:
 * a string[] param excludes 0 rows; a RecordId[] param excludes correctly.
 *
 * Deref-free: no graph traversal. Safe against the 87k-edge invoked hang
 * (memory `weighted-query-per-edge-deref-hang`).
 */
const SparSessionRow = Schema.Struct({ id: Schema.String });

export const fetchSparSessionIds = (): Effect.Effect<readonly string[], never, CacheRead> =>
    Effect.gen(function* () {
        const rows = yield* cacheRows(
            SparSessionRow,
            {
                sql: `SELECT id FROM session
                      WHERE labels IS NOT NULL
                        AND json_contains(labels, '"spar"')`,
                params: [],
            },
            "spar sessions",
        );
        return rows.map((row) => row.id);
    });
