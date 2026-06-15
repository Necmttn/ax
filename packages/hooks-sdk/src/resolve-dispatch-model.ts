// packages/hooks-sdk/src/resolve-dispatch-model.ts
//
// One classifier for "what model tier does this dispatch want." Shared by the
// route-dispatch hook (fire path) and `ax dispatches` candidates so the two can
// never disagree on the judgment∩route-down cell. Pure + Effect-free (importable
// in the ~70ms hot path), matching the spend-mode.ts / matchRoutingTable
// precedent. Judgment-first precedence mirrors decideVerdict rule 0: a review/
// design/audit dispatch is NEVER routed down, even when its description also
// matches a route-down class (regex drift).
import {
  matchRoutingTable,
  type RoutingMatch,
  type RoutingTableShape,
} from "./routing-table.ts";
import { JUDGMENT_STRONG_RE } from "./spend-mode.ts";

export type DispatchTier = "judgment" | "route-down" | "inherit";

export interface DispatchModelResolution {
  /** judgment → keep strong; route-down → cheaper tier; inherit → no opinion. */
  readonly tier: DispatchTier;
  /** Raw routing match (populated even when judgment wins), for classId/reason. */
  readonly match: RoutingMatch | null;
  readonly judgmentStrong: boolean;
  /** route-down → suggested cheaper model; judgment | inherit → null (keep strong/inherited). */
  readonly effectiveModel: string | null;
  readonly reason: string;
}

export const resolveDispatchModel = (
  table: RoutingTableShape,
  description: string | null | undefined,
  agentType: string | null | undefined,
): DispatchModelResolution => {
  const judgmentStrong =
    description != null && description.length > 0 && JUDGMENT_STRONG_RE.test(description);
  const match = matchRoutingTable(table, description, agentType);

  if (judgmentStrong) {
    return {
      tier: "judgment",
      match,
      judgmentStrong: true,
      effectiveModel: null,
      reason: "judgment work (review/design/audit) - keep the strong model",
    };
  }
  if (match) {
    return {
      tier: "route-down",
      match,
      judgmentStrong: false,
      effectiveModel: match.suggest,
      reason: match.reason,
    };
  }
  return {
    tier: "inherit",
    match: null,
    judgmentStrong: false,
    effectiveModel: null,
    reason: "no route-down class matched - keep the inherited model",
  };
};
