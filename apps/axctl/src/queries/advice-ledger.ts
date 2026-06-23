import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
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
 * Fetch the advice ledger joined to dispatch outcomes over the window. Reuses
 * `fetchDispatches` for the parent->child->model resolution, so the advice view
 * inherits the same child_model logic the dispatch table uses.
 */
export const fetchAdviceLedger = Effect.fn("queries.fetchAdviceLedger")(
  function* (opts: { readonly sinceDays: number; readonly limit: number }) {
    const db = yield* SurrealClient;
    const adviceResult = yield* db.query<[Array<Record<string, unknown>>]>(
      `SELECT type::string(session) AS session_str, type::string(ts) AS ts, description, suggested_model ` +
        `FROM advice WHERE verdict = "advise" AND ts > time::now() - ${opts.sinceDays}d ` +
        `ORDER BY ts DESC LIMIT ${Math.max(1, opts.limit) * 20};`,
    );
    const advice: AdviceInput[] = (adviceResult?.[0] ?? []).map((r) => ({
      ts: String(r.ts ?? ""),
      parent_id: cleanSessionId(String(r.session_str ?? "")),
      description: r.description == null ? null : String(r.description),
      suggested_model: r.suggested_model == null ? null : String(r.suggested_model),
    }));

    const dispatched = yield* fetchDispatches({ sinceDays: opts.sinceDays, limit: 10_000 });
    return aggregateAdviceLedger(advice, dispatched.rows);
  },
);
