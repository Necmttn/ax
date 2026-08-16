import { Effect, Schema } from "effect";
import { daysAgoExpr } from "@ax/lib/duckdb/clause";
import { TimestampColumn } from "@ax/lib/duckdb/columns";
import { CacheRead } from "@ax/lib/duckdb/seam";
import { cleanSessionId } from "../metrics/util.ts";
import { followedAdvice } from "../advice/model.ts";
import { fetchDispatches, type DispatchRow } from "./dispatch-analytics.ts";

/** An advise row from the ledger, ready to link to a dispatch. */
export interface AdviceInput {
  readonly ts: string;
  /** bare parent/advised session id (the dispatch's parent_id). */
  readonly parent_id: string;
  readonly description: string | null;
  readonly suggested_model: string | null;
}

/** One advice joined to its dispatch outcome. */
export interface AdviceLedgerRow {
  readonly ts: string;
  readonly parent_id: string;
  readonly description: string | null;
  readonly suggested_model: string | null;
  /** Model the matched dispatch's child actually ran on (null = unmatched). */
  readonly child_model: string | null;
  /** True/false when matched + judgeable; null when unmatched or unjudgeable. */
  readonly followed: boolean | null;
}

export interface AdviceLedgerSummary {
  /** Advise rows in the window. */
  readonly advised: number;
  /** Advise rows matched to a dispatch (a `spawned` edge with same parent+description). */
  readonly matched: number;
  /** Matched + the child honored the advice (ran the suggested tier or any non-frontier). */
  readonly followed: number;
  /** Matched + the child stayed on frontier despite the advice. */
  readonly notFollowed: number;
  /** Advise rows with no matching dispatch (advised then not dispatched, or pre-tap history). */
  readonly unmatched: number;
  /** followed / (followed + notFollowed), 0-100; 0 when none judgeable. */
  readonly followThroughPct: number;
}

export interface AdviceLedgerResult {
  readonly rows: ReadonlyArray<AdviceLedgerRow>;
  readonly summary: AdviceLedgerSummary;
}

const joinKey = (parentId: string, description: string | null): string =>
  `${parentId}::${(description ?? "").trim()}`;

/**
 * Pure join: link each advise row to its dispatch (same parent session +
 * description; nearest ts when several share a key) and judge follow-through.
 * Kept DB-free so it's unit-testable with fixtures.
 */
export function aggregateAdviceLedger(
  advice: ReadonlyArray<AdviceInput>,
  dispatches: ReadonlyArray<DispatchRow>,
): AdviceLedgerResult {
  // Group dispatches by parent+description for an O(1) candidate lookup.
  const byKey = new Map<string, DispatchRow[]>();
  for (const d of dispatches) {
    const k = joinKey(d.parent_id, d.description);
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(d);
  }

  const rows: AdviceLedgerRow[] = [];
  let followed = 0, notFollowed = 0, matched = 0;

  for (const a of advice) {
    const candidates = byKey.get(joinKey(a.parent_id, a.description));
    let dispatch: DispatchRow | null = null;
    if (candidates && candidates.length > 0) {
      const at = new Date(a.ts).getTime();
      dispatch = candidates.reduce((best, d) =>
        Math.abs(new Date(d.ts).getTime() - at) < Math.abs(new Date(best.ts).getTime() - at) ? d : best,
      );
    }
    const childModel = dispatch?.child_model ?? null;
    const f = dispatch ? followedAdvice(a.suggested_model, childModel) : null;
    if (dispatch) matched++;
    if (f === true) followed++;
    else if (f === false) notFollowed++;
    rows.push({
      ts: a.ts,
      parent_id: a.parent_id,
      description: a.description,
      suggested_model: a.suggested_model,
      child_model: childModel,
      followed: f,
    });
  }

  const judgeable = followed + notFollowed;
  return {
    rows,
    summary: {
      advised: advice.length,
      matched,
      followed,
      notFollowed,
      unmatched: advice.length - matched,
      followThroughPct: judgeable === 0 ? 0 : (followed / judgeable) * 100,
    },
  };
}

/**
 * The `advice` rows this view reads, as DuckDB column CONTRACTS.
 *
 * `ts` is a real TIMESTAMP column (the Surreal reader had to cast it with
 * `type::string(ts)`; DuckDB has no such cast and none is needed), and every
 * other column is a nullable VARCHAR per `schema.duckdb.sql`. Nothing here is a
 * BIGINT, so no `NumberFromBigIntColumn` is required - this query counts
 * nothing in SQL, it counts in `aggregateAdviceLedger`.
 */
const AdviceDbRow = Schema.Struct({
  ts: TimestampColumn,
  session: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  suggested_model: Schema.NullOr(Schema.String),
});

/**
 * Advise fires in the window, newest first.
 *
 * The day bound is {@link daysAgoExpr} rather than a hand-written
 * `CURRENT_TIMESTAMP - INTERVAL`: the latter needs the ICU extension, which the
 * static DuckDB build ax ships does not carry, and would fail to BIND rather
 * than return a wrong answer. Both the day count and the row cap are BOUND
 * parameters, in that positional order.
 */
const ADVICE_SQL = `
SELECT ts, session, description, suggested_model
FROM advice
WHERE verdict = 'advise' AND ts > ${daysAgoExpr}
ORDER BY ts DESC
LIMIT ?`;

/** Positive whole days/rows - a fractional or NaN bound binds as a DOUBLE and
 *  fails inside DuckDB, far from the caller that produced it. */
const positiveInt = (value: number, fallback: number): number => {
  const n = Math.trunc(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Fetch the advice ledger joined to dispatch outcomes over the window. Reuses
 * `fetchDispatches` for the parent->child->model resolution, so the advice view
 * inherits the same child_model logic the dispatch table uses.
 *
 * Both halves read the DuckDB cache through `CacheRead`. The advice half used to
 * read SurrealDB, which nothing has written since `advice` became a live DuckDB
 * table - and because an empty table is not an error, that read returned an
 * EMPTY ledger rather than failing.
 */
export const fetchAdviceLedger = Effect.fn("queries.fetchAdviceLedger")(
  function* (opts: { readonly sinceDays: number; readonly limit: number }) {
    const read = yield* CacheRead;

    const sinceDays = positiveInt(opts.sinceDays, 1);
    const rowCap = positiveInt(opts.limit, 1) * 20;
    const adviceRows = yield* read.rows(AdviceDbRow, ADVICE_SQL, [sinceDays, rowCap]);

    const advice: AdviceInput[] = adviceRows.map((r) => ({
      ts: r.ts.toISOString(),
      // `advice.session` is written BARE by the advice stage, so this is a
      // no-op on every row the current writer produces. It stays because the
      // join key on the other side (`DispatchRow.parent_id`) is normalized the
      // same way, and a decorated id reaching here from older data would
      // silently match nothing.
      parent_id: cleanSessionId(r.session ?? ""),
      description: r.description,
      suggested_model: r.suggested_model,
    }));

    const dispatched = yield* fetchDispatches(read, { sinceDays: opts.sinceDays, limit: 10_000 });
    return aggregateAdviceLedger(advice, dispatched.rows);
  },
);
