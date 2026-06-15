// Pure, dependency-free digest types + selection/render shared by the axctl
// snapshot writer and the hooks-sdk SessionStart hook (which cannot import
// from apps/axctl). Keep this free of Effect + DB imports.

export interface DigestItemJson {
  id: string;
  kind: "improve" | "cost" | "churn" | "quota";
  salience: number;
  text: string;
  action: string;
  evidence?: string;
  computed_at: string;
}

export interface DigestSnapshotJson {
  generated_at: string;
  window_days: number;
  items: DigestItemJson[];
}

export interface ShownRecord {
  last_shown_at: string;
  shown_count: number;
}
export type ShownState = Record<string, ShownRecord>;

// Parallel constants to apps/axctl/src/digest/rank.ts - different type domains
// (JSON vs in-process Schema class) so duplication is acceptable.
const SUPPRESS_WINDOW_MS = 6 * 60 * 60 * 1000;
const MAX_SHOWN_COUNT = 3;

const suppressed = (id: string, shown: ShownState, nowMs: number): boolean => {
  const rec = shown[id];
  if (!rec) return false;
  if (rec.shown_count >= MAX_SHOWN_COUNT) return true;
  const lastMs = Date.parse(rec.last_shown_at);
  return Number.isFinite(lastMs) && nowMs - lastMs < SUPPRESS_WINDOW_MS;
};

export const pickUnshownJson = (
  items: ReadonlyArray<DigestItemJson>,
  shown: ShownState,
  now: Date,
  limit = 3,
): DigestItemJson[] =>
  [...items]
    .sort((a, b) => b.salience - a.salience)
    .filter((it) => !suppressed(it.id, shown, now.getTime()))
    .slice(0, limit);

export const renderDigestJson = (items: ReadonlyArray<DigestItemJson>): string => {
  if (items.length === 0) return "";
  const lines = items.map((it) => `  • ${it.text} → ${it.action}`);
  return ["[ax] since last session:", ...lines, "run `ax` for the full board."].join("\n");
};

export const isSnapshotFresh = (
  snap: DigestSnapshotJson,
  now: Date,
  maxAgeHours: number,
): boolean => {
  const genMs = Date.parse(snap.generated_at);
  if (!Number.isFinite(genMs)) return false;
  return now.getTime() - genMs < maxAgeHours * 3600_000;
};

/** Merge shown-state for the next write: carry over only ids still present in
 *  the live snapshot (drop resolved), and record/increment the just-shown ids.
 *  `liveIds` = the ids in the current snapshot; `shownIds` = ids surfaced this fire. */
export const mergeShownState = (
  prev: ShownState,
  shownIds: ReadonlyArray<string>,
  liveIds: ReadonlySet<string>,
  now: Date,
): ShownState => {
  const next: ShownState = {};
  for (const [id, rec] of Object.entries(prev)) if (liveIds.has(id)) next[id] = rec;
  for (const id of shownIds) {
    next[id] = { last_shown_at: now.toISOString(), shown_count: (prev[id]?.shown_count ?? 0) + 1 };
  }
  return next;
};
