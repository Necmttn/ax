/**
 * Content-type rollups over the has_content edge. Deref-free: the edge
 * denormalizes bytes + session, so every aggregate is a flat GROUP BY (the
 * house idiom - record derefs inside aggregates over large edge tables hang
 * production). Shared by context-budget, cost split, and the profile facet.
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";

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

const DISTRIBUTION_SQL = `
SELECT type::string(out) AS ct, count() AS calls, math::sum(bytes) AS bytes
FROM has_content GROUP BY ct;
`;

/** Global content-type distribution. */
export const fetchContentTypeBreakdown = Effect.fn("queries.fetchContentTypeBreakdown")(
  function* () {
    const db = yield* SurrealClient;
    const [raw] = yield* db.query<[Array<RawCtRow>]>(DISTRIBUTION_SQL);
    return rollupContentTypes(raw ?? []);
  },
);

const PER_SESSION_SQL = `
SELECT type::string(session) AS sid, type::string(out) AS ct,
       count() AS calls, math::sum(bytes) AS bytes
FROM has_content WHERE session != NONE GROUP BY sid, ct;
`;

export interface SessionContentMix {
  readonly sessionId: string;
  readonly mix: ContentTypeBreakdown;
}

/** Per-session content-type mix (token-weighted). */
export const fetchSessionContentMix = Effect.fn("queries.fetchSessionContentMix")(
  function* () {
    const db = yield* SurrealClient;
    const [raw] = yield* db.query<[Array<{ sid: string; ct: string; calls: number; bytes: number }>]>(
      PER_SESSION_SQL,
    );
    const bySession = new Map<string, RawCtRow[]>();
    for (const r of raw ?? []) {
      const arr = bySession.get(r.sid) ?? [];
      arr.push({ ct: r.ct, calls: r.calls, bytes: r.bytes });
      bySession.set(r.sid, arr);
    }
    return Array.from(bySession.entries()).map(
      ([sessionId, rows]) => ({ sessionId, mix: rollupContentTypes(rows) }) satisfies SessionContentMix,
    );
  },
);
