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
import { RecordId } from "surrealdb";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";

/**
 * RecordIds of sessions tagged as spar variants (behavioral-analytics
 * exclusion). Returns a flat array of `RecordId` values (NOT strings).
 * Returns `[]` when no spar sessions exist.
 *
 * IMPORTANT: the ids are RAW `record<session>` values, not `type::string(id)`
 * strings. `invoked.session` / `session.id` are record links, and SurrealDB
 * compares `record<session> NOT IN [<string>...]` as ALWAYS-TRUE (the string
 * IN-list silently matches nothing - documented rule, see
 * apps/axctl/src/context/file-context.ts:647-651). The exclusion at the
 * weighted aggregate binds these RecordIds so the comparison is
 * record-vs-record and actually fires. Verified empirically on the live DB:
 * a string[] param excludes 0 rows; a RecordId[] param excludes correctly.
 *
 * Deref-free: no graph traversal. Safe against the 87k-edge invoked hang
 * (memory `weighted-query-per-edge-deref-hang`).
 */
export const fetchSparSessionIds = (): Effect.Effect<
    readonly RecordId[],
    DbError,
    SurrealClient
> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        // SELECT VALUE id returns the raw RecordId values (the surreal SDK's
        // record-id form), NOT a string projection - so NOT IN against this
        // array is a record-vs-record comparison.
        const result = yield* db.query<[Array<unknown>]>(
            `SELECT VALUE id FROM session WHERE labels != NONE AND string::contains(labels, 'spar');`,
        );
        const rows = result?.[0] ?? [];
        return rows.filter((r): r is RecordId => r instanceof RecordId);
    });
