import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { tokens } from "../ingest/outcomes.ts";

export interface NgramOutcomeRow {
  readonly ngram: string;
  readonly n: number;
  readonly occurrences: number;   // turns containing ngram
  readonly outcomes: number;      // of those, followed by an outcome within the window
  readonly sessions: number;      // distinct sessions
}

export interface LiftRow extends NgramOutcomeRow {
  readonly lift: number;
}

// ---------------------------------------------------------------------------
// Input types for tallyNgramOutcomes
// ---------------------------------------------------------------------------

export interface UserTurnInput {
  readonly id: string;
  readonly sid: string;
  readonly seq: number;
  readonly ts: string;
  readonly text_excerpt: string;
}

/** A captured outcome that occurred in session `sid` at time `ts`. */
export interface OutcomeMarker {
  readonly sid: string;
  readonly ts: string;
}

export interface FetchLiftInput {
  readonly sinceDays: number;
  readonly windowTurns?: number; // default 20
  readonly limit?: number;
}

// ---------------------------------------------------------------------------
// Pure: tallyNgramOutcomes
// ---------------------------------------------------------------------------

/**
 * For each user turn, generate 1-4 grams (using the shared tokenizer from
 * outcomes.ts). A turn "has outcome" if an OutcomeMarker exists in the same
 * session with ts > turn.ts, and the number of user turns in that session
 * strictly between turn.ts and outcome.ts is < windowTurns.
 *
 * Returns per-ngram { occurrences, outcomes, sessions } suitable for computeLift.
 */
export const tallyNgramOutcomes = (
  turns: readonly UserTurnInput[],
  outcomes: readonly OutcomeMarker[],
  opts?: { readonly windowTurns?: number },
): NgramOutcomeRow[] => {
  const windowTurns = opts?.windowTurns ?? 20;

  // Group user turns by session, sorted by ts asc
  const turnsBySid = new Map<string, UserTurnInput[]>();
  for (const t of turns) {
    const bucket = turnsBySid.get(t.sid);
    if (bucket) {
      bucket.push(t);
    } else {
      turnsBySid.set(t.sid, [t]);
    }
  }
  for (const bucket of turnsBySid.values()) {
    bucket.sort((a, b) => a.ts.localeCompare(b.ts));
  }

  // Group outcome markers by session
  const outcomesBySid = new Map<string, OutcomeMarker[]>();
  for (const o of outcomes) {
    const bucket = outcomesBySid.get(o.sid);
    if (bucket) {
      bucket.push(o);
    } else {
      outcomesBySid.set(o.sid, [o]);
    }
  }

  // Determine which turns "have outcome" within the forward window
  const turnHasOutcome = new Map<string, boolean>();
  for (const [sid, sessionTurns] of turnsBySid) {
    const sessionOutcomes = outcomesBySid.get(sid) ?? [];
    for (const turn of sessionTurns) {
      let hasOutcome = false;
      for (const outcome of sessionOutcomes) {
        if (outcome.ts <= turn.ts) continue; // outcome not after this turn
        // Count user turns strictly between turn.ts and outcome.ts (ts-based window proxy)
        const turnsBetween = sessionTurns.filter(
          (t) => t.ts > turn.ts && t.ts < outcome.ts,
        ).length;
        if (turnsBetween < windowTurns) {
          hasOutcome = true;
          break;
        }
      }
      turnHasOutcome.set(turn.id, hasOutcome);
    }
  }

  // Aggregate 1-4 grams across all turns
  interface NgramAcc {
    n: number;
    occurrences: number;
    outcomes: number;
    sessions: Set<string>;
  }
  const ngramMap = new Map<string, NgramAcc>();

  for (const turn of turns) {
    const tks = tokens(turn.text_excerpt ?? "");
    if (tks.length === 0) continue;
    const hasOutcome = turnHasOutcome.get(turn.id) ?? false;

    for (let n = 1; n <= 4; n++) {
      for (let i = 0; i <= tks.length - n; i++) {
        const ngram = tks.slice(i, i + n).join(" ");
        const key = `${n}:${ngram}`;
        const existing = ngramMap.get(key);
        if (existing) {
          existing.occurrences += 1;
          if (hasOutcome) existing.outcomes += 1;
          existing.sessions.add(turn.sid);
        } else {
          ngramMap.set(key, {
            n,
            occurrences: 1,
            outcomes: hasOutcome ? 1 : 0,
            sessions: new Set([turn.sid]),
          });
        }
      }
    }
  }

  return [...ngramMap.entries()].map(([key, acc]) => ({
    ngram: key.slice(key.indexOf(":") + 1),
    n: acc.n,
    occurrences: acc.occurrences,
    outcomes: acc.outcomes,
    sessions: acc.sessions.size,
  }));
};

// ---------------------------------------------------------------------------
// Effect: fetchDirectiveLift
// ---------------------------------------------------------------------------

// SQL boundary guard
const sqlDays = (n: number): number => Math.max(1, Math.trunc(n));

/**
 * Statement 1: User turns in the last `sinceDays` days, excluding subagent
 * sessions. Mirrors the v1 directive turn-fetch shape from derive-proposals.ts.
 *
 * Note: `session.source` is a record-deref in the WHERE clause. This is NOT
 * inside an aggregate and the turn table is indexed on ts. SurrealDB resolves
 * this per-row at read time; performance is acceptable on 90d windows (tested
 * in derive-proposals with identical shape).
 */
const userTurnsSql = (sinceDays: number) => `
SELECT type::string(id) AS id, type::string(session) AS sid, seq, text_excerpt, type::string(ts) AS ts
FROM turn
WHERE role = "user" AND text_excerpt != NONE AND text_excerpt != ""
  AND ts > time::now() - ${sqlDays(sinceDays)}d AND session.source != "claude-subagent";
`;

/**
 * Statement 2: Outcome markers from edited edges where the path targets a
 * memory or hooks directory. Projects `in.session` - a SELECT-projection
 * deref (NOT inside an aggregate). The matching rows are small in practice
 * (only writes to /memory/ and /.ax/hooks/ paths), so this does not trigger
 * the per-edge deref hang seen in the 87k-row aggregate case.
 *
 * Proposals with status='accepted' are omitted in v1: the proposal table
 * carries no session field and cites_evidence → skill_candidate also lacks
 * one, making a deref-free session mapping impossible without a third query.
 * Documented as a known limitation (NEEDS_CONTEXT for v2).
 */
const outcomeMarkersSql = (sinceDays: number) => `
SELECT type::string(in.session) AS sid, type::string(ts) AS ts
FROM edited
WHERE (absolute_path_seen CONTAINS '/memory/' OR path_seen CONTAINS '/memory/'
    OR absolute_path_seen CONTAINS '/.ax/hooks/' OR path_seen CONTAINS '/.ax/hooks/')
    AND ts > time::now() - ${sqlDays(sinceDays)}d AND in != NONE;
`;

interface RawUserTurn {
  readonly id: unknown;
  readonly sid: unknown;
  readonly seq: unknown;
  readonly text_excerpt: unknown;
  readonly ts: unknown;
}

interface RawOutcomeMarker {
  readonly sid: unknown;
  readonly ts: unknown;
}

export const fetchDirectiveLift = Effect.fn("queries.fetchDirectiveLift")(
  function* (input: FetchLiftInput) {
    const db = yield* SurrealClient;
    const sinceDays = input.sinceDays;
    const windowTurns = input.windowTurns ?? 20;
    const limit = input.limit ?? 200;

    // Query 1: user turns
    const [rawTurns] = yield* db.query<[Array<RawUserTurn>]>(userTurnsSql(sinceDays));

    // Query 2: outcome markers (memory/hooks edited edges)
    const [rawOutcomes] = yield* db.query<[Array<RawOutcomeMarker>]>(outcomeMarkersSql(sinceDays));

    // Parse user turns
    const turns: UserTurnInput[] = (rawTurns ?? [])
      .filter((r) => r.id != null && r.sid != null && r.ts != null && typeof r.text_excerpt === "string" && r.text_excerpt.length > 0)
      .map((r) => ({
        id: String(r.id),
        sid: String(r.sid),
        seq: typeof r.seq === "number" ? r.seq : 0,
        ts: String(r.ts),
        text_excerpt: String(r.text_excerpt),
      }));

    // Parse outcome markers
    const outcomes: OutcomeMarker[] = (rawOutcomes ?? [])
      .filter((r) => r.sid != null && r.ts != null)
      .map((r) => ({
        sid: String(r.sid),
        ts: String(r.ts),
      }));

    // Pure: tally ngram × outcome co-occurrences
    const tallyRows = tallyNgramOutcomes(turns, outcomes, { windowTurns });

    // Compute base rate: fraction of user turns that have an outcome in window
    // Re-compute here using the same logic as tallyNgramOutcomes
    const turnsWithOutcome = turns.filter((t) => {
      const sessionOutcomes = outcomes.filter((o) => o.sid === t.sid && o.ts > t.ts);
      if (sessionOutcomes.length === 0) return false;
      const sessionTurns = turns.filter((u) => u.sid === t.sid);
      sessionTurns.sort((a, b) => a.ts.localeCompare(b.ts));
      for (const outcome of sessionOutcomes) {
        const between = sessionTurns.filter((u) => u.ts > t.ts && u.ts < outcome.ts).length;
        if (between < windowTurns) return true;
      }
      return false;
    });

    const baseRate = turns.length > 0 ? turnsWithOutcome.length / turns.length : 0;

    const liftRows = computeLift(tallyRows, baseRate, { minOccurrences: 5, minSessions: 3 });

    return liftRows.slice(0, limit);
  },
);

// ---------------------------------------------------------------------------
// computeLift
// ---------------------------------------------------------------------------

// baseRate = (total turns with an outcome) / (total turns considered)
export const computeLift = (
  rows: readonly NgramOutcomeRow[],
  baseRate: number,
  opts?: { readonly minOccurrences?: number; readonly minSessions?: number },
): LiftRow[] => {
  const minOcc = opts?.minOccurrences ?? 5;
  const minSess = opts?.minSessions ?? 3;
  const safeBase = baseRate > 0 ? baseRate : 0;
  return rows
    .filter((r) => r.occurrences >= minOcc && r.sessions >= minSess)
    .map((r) => {
      const pOutcome = r.occurrences > 0 ? r.outcomes / r.occurrences : 0;
      const lift = safeBase > 0 ? pOutcome / safeBase : 0;
      return { ...r, lift };
    })
    .sort((a, b) => b.lift - a.lift || b.occurrences - a.occurrences || a.ngram.localeCompare(b.ngram));
};
