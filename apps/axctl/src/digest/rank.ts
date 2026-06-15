import type { DigestItem, DigestKind } from "./model.ts";

/** Per-kind base weight. Tunable seed (spec §Ranking). */
export const BASE_WEIGHT: Record<DigestKind, number> = {
  churn: 1.0,
  improve: 0.9,
  cost: 0.8,
  quota: 0.5,
};

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
