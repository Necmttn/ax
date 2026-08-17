/**
 * Fetch the set of session ids tagged as spar variant sessions.
 *
 * `ax dojo spar-score` stamps the variant session with a `"spar"` row in the
 * sidecar's `session_label` table. This helper returns those session ids, which
 * behavioral-analytics surfaces (`ax skills weighted`, `ax thinking`) subtract
 * from their rollups.
 *
 * Spec: docs/superpowers/specs/2026-06-15-spar-exclusion-tag-design.md
 */
import { Effect, Schema } from "effect";
import { Judgment, TextColumn, type JudgmentError } from "@ax/lib/sqlite";

/**
 * Bare session ids (no `session:` prefix, no record wrapper) labelled `spar`.
 * Returns `[]` when no spar sessions exist.
 *
 * The ids are stored bare: `stampSparSession` writes `cleanSessionId(...)` into
 * `session_label.session_id`, and in DuckDB `session.id` / `invoked.session` are
 * plain VARCHARs. So a caller compares these strings directly - no unwrapping,
 * no id normalization.
 *
 * HISTORY, because the old shape is easy to reintroduce. Under SurrealDB the
 * ids had to be `RecordId` OBJECTS: `invoked.session` was a record link, and
 * `record<session> NOT IN [<string>...]` silently matched nothing, so a
 * string[] parameter excluded zero rows while looking correct. That trap is
 * gone with the engine - both call sites had been unwrapping the RecordId back
 * to its bare key anyway, and the wrapper was the last thing in the repo that
 * needed the `surrealdb` package at runtime.
 *
 * Deref-free: no graph traversal. Safe against the 87k-edge invoked hang
 * (memory `weighted-query-per-edge-deref-hang`).
 */
export const fetchSparSessionIds = (): Effect.Effect<
    readonly string[],
    JudgmentError,
    Judgment
> =>
    Effect.gen(function* () {
        const judgment = yield* Judgment;
        const rows = yield* judgment.rows(
            Schema.Struct({ session_id: TextColumn }),
            "SELECT session_id FROM session_label WHERE label = ? ORDER BY session_id",
            ["spar"],
        );
        return rows.map((row) => row.session_id);
    });
