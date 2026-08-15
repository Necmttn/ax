/**
 * Content-type rollups over the has_content edge. Deref-free: the edge
 * denormalizes bytes + session, so every aggregate is a flat GROUP BY (the
 * house idiom - record derefs inside aggregates over large edge tables hang
 * production). Shared by context-budget, cost split, and the profile facet.
 */
import { Effect, Schema } from "effect";
import { NumberFromBigIntColumn } from "@ax/lib/duckdb/columns";
import { cacheRows } from "@ax/lib/duckdb/query";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const BYTES_PER_TOKEN = 4; // shared with skill-bloat + context-budget
const estTokens = (bytes: number): number => Math.round(bytes / BYTES_PER_TOKEN);

export interface ContentTypeRow {
  readonly category: string;
  readonly calls: number;
  readonly bytes: number;
  readonly estTokens: number;
  readonly tokenShare: number; // 0..1 of total est tokens
}

export interface ContentTypeBreakdown {
  readonly rows: ReadonlyArray<ContentTypeRow>;
  readonly totals: { readonly calls: number; readonly bytes: number; readonly estTokens: number };
}

interface RawCtRow { readonly ct: string; readonly calls: number; readonly bytes: number }

// ---------------------------------------------------------------------------
// Pure aggregation - unit tested independently of the DB
// ---------------------------------------------------------------------------

/** Pure aggregation - unit tested. */
export const rollupContentTypes = (raw: ReadonlyArray<RawCtRow>): ContentTypeBreakdown => {
  const totalBytes = raw.reduce((a, r) => a + Number(r.bytes ?? 0), 0);
  const rows = raw
    .map((r) => {
      const bytes = Number(r.bytes ?? 0);
      const tok = estTokens(bytes);
      return {
        category: r.ct.replace(/^content_type:/, ""),
        calls: Number(r.calls ?? 0),
        bytes,
        estTokens: tok,
        tokenShare: totalBytes > 0 ? bytes / totalBytes : 0,
      };
    })
    .sort((a, b) => b.estTokens - a.estTokens);
  return {
    rows,
    totals: {
      calls: rows.reduce((a, r) => a + r.calls, 0),
      bytes: totalBytes,
      estTokens: estTokens(totalBytes),
    },
  };
};

// ---------------------------------------------------------------------------
// SQL - deref-free flat GROUP BY (no record derefs inside aggregates)
// ---------------------------------------------------------------------------

const ContentTypeAggregateRow = Schema.Struct({
  ct: Schema.String,
  calls: NumberFromBigIntColumn,
  bytes: NumberFromBigIntColumn,
});

const SessionContentTypeAggregateRow = Schema.Struct({
  sid: Schema.String,
  ct: Schema.String,
  calls: NumberFromBigIntColumn,
  bytes: NumberFromBigIntColumn,
});

const DISTRIBUTION_SQL = `
SELECT out_id AS ct, count(*) AS calls, coalesce(sum(bytes), 0)::BIGINT AS bytes
FROM has_content GROUP BY ct;
`;

/** Global content-type distribution. */
export const fetchContentTypeBreakdown = Effect.fn("queries.fetchContentTypeBreakdown")(
  function* () {
    const raw = yield* cacheRows(ContentTypeAggregateRow, { sql: DISTRIBUTION_SQL, params: [] }, "content types");
    return rollupContentTypes(raw);
  },
);

const PER_SESSION_SQL = `
SELECT session AS sid, out_id AS ct,
       count(*) AS calls, coalesce(sum(bytes), 0)::BIGINT AS bytes
FROM has_content WHERE session IS NOT NULL GROUP BY sid, ct;
`;

export interface SessionContentMix {
  readonly sessionId: string;
  readonly mix: ContentTypeBreakdown;
}

/** Per-session content-type mix (token-weighted). */
export const fetchSessionContentMix = Effect.fn("queries.fetchSessionContentMix")(
  function* () {
    const raw = yield* cacheRows(SessionContentTypeAggregateRow, { sql: PER_SESSION_SQL, params: [] }, "session content types");
    const bySession = new Map<string, RawCtRow[]>();
    for (const r of raw) {
      const arr = bySession.get(r.sid) ?? [];
      arr.push({ ct: r.ct, calls: r.calls, bytes: r.bytes });
      bySession.set(r.sid, arr);
    }
    return Array.from(bySession.entries()).map(
      ([sessionId, rows]) => ({ sessionId, mix: rollupContentTypes(rows) }) satisfies SessionContentMix,
    );
  },
);
