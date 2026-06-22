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
