/**
 * Quota-aware spend-mode signal for the route-dispatch hook fire path.
 *
 * Pure functions + a synchronous cache reader (mirrors readRoutingTableSync in
 * routing-table.ts - same fire-path constraint: ~70ms budget, `node:fs` sync,
 * fail-open on any error). No Effect in this module - it runs under plain bun.
 *
 * Exports:
 *   QuotaSnapshot  - minimal local type (matches apps/axctl/src/quota/schema.ts)
 *   readQuotaCacheSync - sync fail-open read of ~/.ax/quota-cache.json
 *   computeSpendMode   - pure mode decision
 *   DEFAULT_SPEND_CONFIG
 *   JUDGMENT_STRONG_RE - NARROW, review-focused regex for the HOOK ONLY. It
 *                        deliberately wants bare/spec review to route down (an
 *                        advisory nudge). routing-tune does NOT use this - it has
 *                        its own BROAD JUDGMENT_GUARD_RE because its auto-apply
 *                        gate must over-flag (see routing-tune.ts).
 */
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QuotaWindow {
  readonly utilization: number;
  readonly resets_at: string;
}

/**
 * Minimal local mirror of apps/axctl/src/quota/schema.ts:QuotaSnapshot.
 * We only assert `v === 1` and `fetched_at` is a string; extra fields are
 * allowed (`[k: string]: unknown`) so the hook fire path doesn't need to
 * depend on the full schema module.
 */
export interface QuotaSnapshot {
  readonly v: 1;
  readonly fetched_at: string;
  readonly five_hour: QuotaWindow | null;
  readonly seven_day: QuotaWindow | null;
  readonly [k: string]: unknown;
}

export type SpendMode = "conserve" | "splurge";

export interface SpendModeResult {
  readonly mode: SpendMode;
  readonly reason: string;
  readonly stale: boolean;
}

export interface SpendConfig {
  /** Cache age above which the snapshot is treated as stale (ms). Default 5 min. */
  readonly stalenessMs: number;
  /** 7d window "near reset" threshold (ms). Default 24h. */
  readonly nearResetMs7d: number;
  /** Minimum remaining % (100 - utilization) required to splurge. Default 25%. */
  readonly minRemainingPct: number;
  /** If any window is at or above this utilization %, block splurge. Default 80%. */
  readonly capFloorPct: number;
}

export const DEFAULT_SPEND_CONFIG: SpendConfig = {
  stalenessMs: 5 * 60_000,
  nearResetMs7d: 24 * 3600_000,
  minRemainingPct: 25,
  capFloorPct: 80,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const parseMs = (iso: string): number | null => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

// ---------------------------------------------------------------------------
// Judgment regex
// ---------------------------------------------------------------------------

/**
 * Strong judgment work that must stay on the main/strong model. Matches
 * quality/pr/final/adversarial/code review, design, audit, architect, critique,
 * judge - and deliberately NOT a bare "review" or "spec review" (the spec-review
 * routing class is a deliberate route-down target).
 *
 * Matches:  quality review, PR review, final review, adversarial review, code review
 *           design, audit, architect*, critique, critic*, judg*
 * Non-match: "spec review", "spec-compliance review", bare "review"
 */
export const JUDGMENT_STRONG_RE =
  /\b(?:(?:quality|pr|final|adversarial|code)\s+review|design|audit|architect\w*|critique|critic\w*|judg\w*)\b/i;

// ---------------------------------------------------------------------------
// computeSpendMode (pure)
// ---------------------------------------------------------------------------

/**
 * Decide the current spend mode from a quota snapshot.
 *
 * splurge = 7d window is near reset (<nearResetMs7d) AND has headroom
 *           (remaining > minRemainingPct) AND neither window is near its cap.
 *
 * Everything else → conserve. A null or stale snapshot → conserve + stale:true.
 * The 5h window NEVER triggers splurge on its own.
 */
export const computeSpendMode = (
  snapshot: QuotaSnapshot | null,
  nowMs: number,
  config: SpendConfig,
): SpendModeResult => {
  if (snapshot === null) {
    return { mode: "conserve", reason: "no cache", stale: true };
  }

  const fetchedMs = parseMs(snapshot.fetched_at);
  const stale = fetchedMs === null || nowMs - fetchedMs > config.stalenessMs;
  if (stale) {
    return { mode: "conserve", reason: "stale cache", stale: true };
  }

  const sevenDay = snapshot.seven_day;
  if (!sevenDay) {
    return { mode: "conserve", reason: "no 7d window", stale: false };
  }

  const resetMs = parseMs(sevenDay.resets_at);
  if (resetMs === null) {
    return { mode: "conserve", reason: "bad 7d resets_at", stale: false };
  }

  const nearReset = resetMs - nowMs < config.nearResetMs7d;
  const headroom = 100 - sevenDay.utilization > config.minRemainingPct;
  const sevenNearCap = sevenDay.utilization >= config.capFloorPct;
  // Fail safe toward conserve: a present-but-garbage 5h window (non-finite
  // utilization) counts as near-cap (blocks splurge). A null/absent 5h window
  // stays not-near-cap (no 5h signal - the 7d path is what gates splurge).
  const fiveNearCap =
    snapshot.five_hour != null &&
    !(
      Number.isFinite(snapshot.five_hour.utilization) &&
      snapshot.five_hour.utilization < config.capFloorPct
    );

  if (nearReset && headroom && !sevenNearCap && !fiveNearCap) {
    return { mode: "splurge", reason: "7d reset soon with surplus", stale: false };
  }
  return { mode: "conserve", reason: "default", stale: false };
};

// ---------------------------------------------------------------------------
// readQuotaCacheSync (fire-path sync read, mirrors readRoutingTableSync)
// ---------------------------------------------------------------------------

/**
 * Synchronously read the quota cache from disk.
 * Returns null on ANY error (missing file, bad JSON, wrong shape).
 * Never throws. Mirrors the fail-open semantics of readRoutingTableSync.
 */
export const readQuotaCacheSync = (path: string): QuotaSnapshot | null => {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as QuotaSnapshot;
    if (parsed && parsed.v === 1 && typeof parsed.fetched_at === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
};

export const defaultQuotaCachePath = (): string =>
  `${process.env.HOME}/.ax/quota-cache.json`;
