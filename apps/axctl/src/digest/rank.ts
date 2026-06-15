import type { DigestItem, DigestKind } from "./model.ts";
import type { ShownState } from "./shown.ts";

/** Per-kind base weight. Tunable seed (spec §Ranking). */
export const BASE_WEIGHT: Record<DigestKind, number> = {
  churn: 1.0,
  improve: 0.9,
  cost: 0.8,
  quota: 0.5,
};

const SUPPRESS_WINDOW_MS = 6 * 60 * 60 * 1000;
const MAX_SHOWN_COUNT = 3;
/** Recency half-life: a signal one week old scores ~half a fresh one. */
const RECENCY_HALFLIFE_HOURS = 168;

/** Raw input to salience: kind + a normalized magnitude + age in hours. */
export interface RankInput {
  readonly kind: DigestKind;
  readonly urgency: number;
  readonly ageHours: number;
}

export const recency = (ageHours: number): number =>
  Math.pow(0.5, Math.max(0, ageHours) / RECENCY_HALFLIFE_HOURS);

export const salience = (input: RankInput): number =>
  BASE_WEIGHT[input.kind] * Math.max(0, input.urgency) * recency(input.ageHours);

/** Sort by salience desc, cap to `limit` (default 8 for the stored snapshot). */
export const topForSnapshot = <T extends { salience: number }>(
  items: ReadonlyArray<T>,
  limit = 8,
): T[] => [...items].sort((a, b) => b.salience - a.salience).slice(0, limit);

const isSuppressed = (id: string, shown: ShownState, nowMs: number): boolean => {
  const rec = shown[id];
  if (!rec) return false;
  if (rec.shown_count >= MAX_SHOWN_COUNT) return true;
  const lastMs = Date.parse(rec.last_shown_at);
  if (Number.isFinite(lastMs) && nowMs - lastMs < SUPPRESS_WINDOW_MS) return true;
  return false;
};

/** Surface-selection: ranked snapshot minus suppressed, top `limit`. */
export const pickUnshown = (
  items: ReadonlyArray<DigestItem>,
  shown: ShownState,
  now: Date,
  limit = 3,
): DigestItem[] => {
  const nowMs = now.getTime();
  return [...items]
    .sort((a, b) => b.salience - a.salience)
    .filter((it) => !isSuppressed(it.id, shown, nowMs))
    .slice(0, limit);
};
