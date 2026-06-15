/**
 * route-dispatch hook
 *
 * Fires on PreToolUse for the `Agent` tool. Advises subagent dispatches
 * quota-aware via additionalContext (the only mechanism that reaches the model
 * for Agent dispatches; CC bugs #39814 + #40580 confirmed updatedInput/deny
 * are ignored for the Agent tool):
 *
 *   - conserve mode: when a dispatch has no explicit model and matches a
 *     route-down class, emits additionalContext advising the model to
 *     re-dispatch with the suggested cheaper model (Verdict.advise).
 *   - splurge mode: subtractive - no advisory, runs on the strong inherited
 *     model (quota resets soon with headroom; no nag).
 *   - judgment guard (any mode): if a cheap explicit model is set for
 *     judgment work (review/design/audit) → advise the model to prefer the
 *     strong model (catch-rate gate).
 *
 * Spend mode keys off one knob: `routeDownEnforced = (mode === "conserve")`.
 * Mode is determined by AX_SPEND_MODE env override (conserve|splurge), else
 * by computeSpendMode reading the quota cache. Stale/missing cache → conserve
 * (fail-safe).
 *
 * The routing-table schema, built-in defaults, and the fail-open read live in
 * ../routing-table.ts (ADR-0014) - the same module `ax routing compile|tune`
 * builds against, so the hook and the CLI can never drift on format.
 */

import { Effect } from "effect";
import { defineHook, runMain } from "../define.ts";
import { decideVerdict } from "../decide-verdict.ts";
import { loadRoutingTableOrDefault } from "../routing-table.ts";
import { resolveDispatchModel } from "../resolve-dispatch-model.ts";
import {
  computeSpendMode,
  DEFAULT_SPEND_CONFIG,
  defaultQuotaCachePath,
  readQuotaCacheSync,
  type SpendConfig,
} from "../spend-mode.ts";

/**
 * Merge the table's optional spendMode block with DEFAULT_SPEND_CONFIG.
 * Only fields present in the table override the default; absent keys fall back.
 */
const resolveSpendConfig = (tableSpendMode: Partial<SpendConfig> | undefined): SpendConfig =>
  tableSpendMode === undefined
    ? DEFAULT_SPEND_CONFIG
    : {
        stalenessMs: tableSpendMode.stalenessMs ?? DEFAULT_SPEND_CONFIG.stalenessMs,
        nearResetMs7d: tableSpendMode.nearResetMs7d ?? DEFAULT_SPEND_CONFIG.nearResetMs7d,
        minRemainingPct: tableSpendMode.minRemainingPct ?? DEFAULT_SPEND_CONFIG.minRemainingPct,
        capFloorPct: tableSpendMode.capFloorPct ?? DEFAULT_SPEND_CONFIG.capFloorPct,
      };

// Re-exported for consumers (ax hooks tooling, tests) that historically
// imported the schema from the hook file.
export { RoutingTableSchema } from "../routing-table.ts";

// ---------------------------------------------------------------------------
// Hook definition
// ---------------------------------------------------------------------------

const hook = defineHook({
  name: "route-dispatch",
  events: ["PreToolUse"],
  // Only fire for Agent-tool dispatches.
  matcher: { tools: ["Agent"] },
  // No GitEnv needed: routing is pure table matching on the tool input.
  // (R = never is assignable to the HookDefinition's R = GitEnv.)
  run: (event) =>
    Effect.sync(() => {
      const input = (event.tool?.input ?? {}) as Record<string, unknown>;
      const modelRaw = input.model;
      const explicit = typeof modelRaw === "string" && modelRaw.length > 0;
      const cheap = explicit && /sonnet|haiku/i.test(modelRaw as string);
      const subagentType =
        typeof input.subagent_type === "string" ? input.subagent_type : undefined;
      const rawDescription =
        typeof input.description === "string" ? input.description : undefined;
      const rawPrompt =
        typeof input.prompt === "string" ? input.prompt.slice(0, 120) : undefined;
      const description = rawDescription ?? rawPrompt;

      const table = loadRoutingTableOrDefault();
      const resolution = resolveDispatchModel(table, description, subagentType);

      // Resolve spend config: table overrides win over DEFAULT_SPEND_CONFIG.
      const spendConfig = resolveSpendConfig(table.spendMode as Partial<SpendConfig> | undefined);

      // mode (conserve unless a fresh cache says splurge). Env override wins.
      const envMode = process.env.AX_SPEND_MODE;
      const computed = computeSpendMode(
        readQuotaCacheSync(defaultQuotaCachePath()),
        Date.now(),
        spendConfig,
      );
      const mode =
        envMode === "conserve" || envMode === "splurge" ? envMode : computed.mode;

      return decideVerdict({
        match: resolution.match !== null,
        explicit,
        cheap,
        judgmentStrong: resolution.judgmentStrong,
        routeDownEnforced: mode === "conserve",
        suggest: resolution.match?.suggest ?? "sonnet",
      });
    }),
});

export default hook;
if (import.meta.main) void runMain(hook);
