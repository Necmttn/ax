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
 * Session ids tagged as spar variants for behavioral analytics exclusion.
 * Returns a flat array of bare provider session ids.
 * Returns `[]` when no spar sessions exist.
 *
 * DuckDB stores the bare id in `session.id` and related edge columns.
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
