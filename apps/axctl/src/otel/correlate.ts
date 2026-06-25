import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { executeStatements, recordRef } from "@ax/lib/shared/surreal";

const RELATABLE = ["otel_metric_point", "otel_span", "otel_log_event"] as const;

/** session_id IN-list chunk size (mirrors telemetry-rollup.ts). */
const CHUNK = 500;

const chunk = <T>(xs: readonly T[], n: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
    return out;
};

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
 * INCREMENTAL: the candidate set is exactly the sessions that EXIST but are NOT
 * yet linked, and the otel tables are probed with `session_id IN [candidates]`
 * over the schema's `session_id` index (chunked at 500, like telemetry-rollup.ts).
 * Steady state the candidate set is just the run's new sessions, so the pass is
 * cheap; a full `GROUP BY session_id` over otel_log_event (the old approach) cost
 * ~8s on EVERY ingest by enumerating all 1.5M rows, which this avoids.
 *
 * Two earlier bugs this replaced:
 *   - `type::record("session:" + session_id)` evaluated the concat as arithmetic
 *     for hyphenated uuids -> `session:019fbf3f` (everything after the first
 *     hyphen dropped) -> ZERO matches. otel `session_id` is a bare uuid while
 *     `session.id` is the escaped `session:⟨uuid⟩` record, so we match on bare
 *     uuids in JS instead of trusting `type::record` round-trips.
 *   - the per-row `count(<-telemetry_of)=0` graph traversal idempotency check was
 *     a bottleneck; idempotency is now the in-memory `linked` set (drives the
 *     candidate list, so already-linked sessions are never re-probed).
 */
export const correlateOrphanOtel = () =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;

        // Already-linked sessions (telemetry_of stays small - one edge per session).
        const edgeRows = (yield* db.query<[Array<{ in: unknown }>]>(
            `SELECT in FROM telemetry_of;`,
        ))?.[0] ?? [];
        const linked = new Set<string>();
        for (const r of edgeRows) { const u = bareUuid(r.in); if (u) linked.add(u); }

        // Candidates = existing top-level sessions (uuid id) not yet linked.
        const sessRows = (yield* db.query<[Array<{ id: unknown }>]>(
            `SELECT id FROM session;`,
        ))?.[0] ?? [];
        const candidates = [...new Set(
            sessRows.map((r) => bareUuid(r.id)).filter((u): u is string => u !== null),
        )].filter((u) => !linked.has(u));
        if (candidates.length === 0) return;

        // For each candidate, find one representative otel row via the indexed
        // `session_id IN [...]` probe (chunked). First table that has it wins.
        const seen = new Set<string>();
        const stmts: string[] = [];
        for (const table of RELATABLE) {
            const remaining = candidates.filter((u) => !seen.has(u));
            if (remaining.length === 0) break;
            for (const part of chunk(remaining, CHUNK)) {
                const list = part.map((u) => `"${u}"`).join(", ");
                const rows = (yield* db.query<[Array<{ id: unknown; session_id: unknown }>]>(
                    `SELECT id, session_id FROM ${table} WHERE session_id IN [${list}] GROUP BY session_id;`,
                ))?.[0] ?? [];
                for (const o of rows) {
                    const u = bareUuid(o.session_id);
                    if (u === null || seen.has(u)) continue;
                    // GROUP BY collapses `id` into an array of the group's row ids;
                    // take the first as the representative. recordKey handles the
                    // SDK's string|RecordId shape; recordRef escapes it canonically.
                    const repId = Array.isArray(o.id) ? o.id[0] : o.id;
                    const recId = recordKey(repId);
                    if (recId === null) continue;
                    seen.add(u);
                    stmts.push(
                        `RELATE ${recordRef("session", u)}->telemetry_of->${recordRef(table, recId)};`,
                    );
                }
            }
        }
        if (stmts.length > 0) yield* executeStatements(stmts);
    });
