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
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";

/**
 * Record-ids of sessions tagged as spar variants (behavioral-analytics
 * exclusion). Returns a flat array of bare session id strings
 * (e.g. `["session:abc123"]`). Returns `[]` when no spar sessions exist.
 *
 * Deref-free: no graph traversal. Safe against the 87k-edge invoked hang
 * (memory `weighted-query-per-edge-deref-hang`).
 */
export const fetchSparSessionIds = (): Effect.Effect<
    readonly string[],
    DbError,
    SurrealClient
> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const result = yield* db.query<[Array<{ id: string }>]>(
            `SELECT type::string(id) AS id FROM session WHERE labels != NONE AND string::contains(labels, 'spar');`,
        );
        const rows = result?.[0] ?? [];
        return rows.map((r) => String(r.id ?? "")).filter(Boolean);
    });
