import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { executeStatements, recordRef } from "@ax/lib/shared/surreal";

const RELATABLE = ["otel_metric_point", "otel_span", "otel_log_event"] as const;

/**
 * Only correlate telemetry observed within this window. The pass runs after
 * EVERY ingest (incl. the watcher's `--since=1`), so it must be cheap. OTLP
 * arrives just before / alongside its transcript, so freshly-ingested sessions
 * always have recent telemetry - a narrow window backed by the `observed_at`
 * index makes the scan O(recent rows) instead of enumerating the whole (~1.5M
 * row) otel_log_event table each ingest. Telemetry whose transcript is ingested
 * more than this many days late stays unlinked, which is fine: nothing reads the
 * edge for data (enrichment + `ax otel` coverage join `session_id` directly).
 */
const SCAN_WINDOW_DAYS = 2;

/**
 * Extract the bare record KEY from a SurrealDB row `id`, which the SDK returns
 * as EITHER a `"table:key"` string OR a `RecordId` object (`{ tb, id }`, the
 * inner `id` itself a string or further nested). Mirrors the dual-shape
 * handling in `apps/axctl/src/cli/skills-tag.ts`. We already know the table
 * (loop var), so only the key is needed.
 *
 * String form: strip the table prefix up to the FIRST colon only, so metric
 * keys that embed an ISO timestamp (which contains colons) survive intact.
 */
const recordKey = (id: unknown): string | null => {
    if (typeof id === "string") {
        const colon = id.indexOf(":");
        const key = colon >= 0 ? id.slice(colon + 1) : id;
        return key.length > 0 ? key : null;
    }
    if (id !== null && typeof id === "object" && "id" in id) {
        const inner = (id as { id: unknown }).id;
        const key = String(inner);
        return key.length > 0 ? key : null;
    }
    return null;
};

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Bare uuid from an otel `session_id` (already bare) or a `session:⟨uuid⟩` record. */
const bareUuid = (v: unknown): string | null => {
    if (v == null) return null;
    const s = typeof v === "string" ? v : String((v as { id?: unknown }).id ?? v);
    const m = UUID_RE.exec(s);
    return m ? m[0].toLowerCase() : null;
};

/**
 * Draw `session -> telemetry_of -> otel_*` edges, one per top-level session that
 * has matching telemetry. Runs at ingest finish; idempotent + INCREMENTAL.
 *
 * SESSION-GRAIN, not row-grain: otel can hold ~1.5M log rows for a few hundred
 * sessions, and the edge means "this session has telemetry" (no data query reads
 * the edge - enrichment joins `session_id` directly), so one representative row
 * per session suffices. Row-grain would write millions of edges no one consumes.
 *
 * INCREMENTAL: only telemetry observed in the last `SCAN_WINDOW_DAYS` is scanned,
 * via the `observed_at` index (a range scan over recent rows, not a full GROUP BY
 * over all 1.5M). The earlier full `GROUP BY session_id` cost ~8s on EVERY ingest;
 * a candidate-set variant re-probed every telemetry-less session forever. Both are
 * replaced by: window recent telemetry -> filter to existing, unlinked sessions
 * (in-memory sets) -> relate. Already-linked sessions are skipped, so re-scanning
 * the same window each run is cheap.
 *
 * Two earlier bugs this replaced:
 *   - `type::record("session:" + session_id)` evaluated the concat as arithmetic
 *     for hyphenated uuids -> `session:019fbf3f` (everything after the first
 *     hyphen dropped) -> ZERO matches. otel `session_id` is a bare uuid while
 *     `session.id` is the escaped `session:⟨uuid⟩` record, so we match on bare
 *     uuids in JS instead of trusting `type::record` round-trips.
 *   - the per-row `count(<-telemetry_of)=0` graph traversal idempotency check was
 *     a bottleneck; idempotency is now the in-memory `linked` set.
 */
export const correlateOrphanOtel = () =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;

        // Existing top-level sessions (uuid id) and sessions already linked.
        const sessRows = (yield* db.query<[Array<{ id: unknown }>]>(
            `SELECT id FROM session;`,
        ))?.[0] ?? [];
        const sessions = new Set<string>();
        for (const r of sessRows) { const u = bareUuid(r.id); if (u) sessions.add(u); }

        const edgeRows = (yield* db.query<[Array<{ in: unknown }>]>(
            `SELECT in FROM telemetry_of;`,
        ))?.[0] ?? [];
        const linked = new Set<string>();
        for (const r of edgeRows) { const u = bareUuid(r.in); if (u) linked.add(u); }

        // One representative recent otel row per session, first table wins.
        const seen = new Set<string>();
        const stmts: string[] = [];
        for (const table of RELATABLE) {
            // WHERE is observed_at-only so the range scan uses the `observed_at`
            // index; a leading `session_id != NONE` defeated the index (full scan).
            // NONE / non-uuid session_ids fall out via bareUuid below.
            const rows = (yield* db.query<[Array<{ id: unknown; session_id: unknown }>]>(
                `SELECT id, session_id FROM ${table}`
                + ` WHERE observed_at > time::now() - ${SCAN_WINDOW_DAYS}d`
                + ` GROUP BY session_id;`,
            ))?.[0] ?? [];
            for (const o of rows) {
                const u = bareUuid(o.session_id);
                if (u === null || seen.has(u) || linked.has(u) || !sessions.has(u)) continue;
                // GROUP BY collapses `id` into an array of the group's row ids; take
                // the first as the representative. recordKey handles the SDK's
                // string|RecordId shape; recordRef escapes it canonically.
                const repId = Array.isArray(o.id) ? o.id[0] : o.id;
                const recId = recordKey(repId);
                if (recId === null) continue;
                seen.add(u);
                stmts.push(
                    `RELATE ${recordRef("session", u)}->telemetry_of->${recordRef(table, recId)};`,
                );
            }
        }
        if (stmts.length > 0) yield* executeStatements(stmts);
    });
