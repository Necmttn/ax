/**
 * route-dispatch hook
 *
 * Fires on PreToolUse for the `Agent` tool. When a subagent dispatch has no
 * explicit `model`, matches the dispatch description (or first 120 chars of
 * prompt) against a routing table and emits a `warn` verdict suggesting a
 * cheaper model to the calling model.
 *
 * Verdict choice - warn vs inject:
 *   - `warn` encodes as `{ systemMessage: "..." }` on stdout (exit 0).
 *     Claude Code injects this into the model's context for the CURRENT turn,
 *     so the model can re-read the suggestion and re-dispatch with `model:`
 *     pinned.  `inject` (plain stdout) is for SessionStart/UserPromptSubmit
 *     context augmentation, not PreToolUse feedback; `block` (exit 2) would
 *     prevent the dispatch entirely, which is too aggressive.  `warn` is the
 *     right fit: it reaches the model without stopping the call.
 *   - Codex has no Agent-tool dispatch equivalent; this hook is Claude-only
 *     but the SDK fires it for any harness - it will just never match on Codex
 *     because Codex never emits an `Agent` tool name.
 *
 * The routing-table schema, built-in defaults, and the fail-open read live in
 * ../routing-table.ts (ADR-0014) - the same module `ax routing compile|tune`
 * builds against, so the hook and the CLI can never drift on format.
 */

import { Effect } from "effect";
import { defineHook, runMain } from "../define.ts";
import { loadRoutingTableOrDefault, matchRoutingTable } from "../routing-table.ts";
import { Verdict } from "../verdict.ts";

// Re-exported for consumers (ax hooks tooling, tests) that historically
// imported the schema from the hook file.
export { RoutingTableSchema } from "../routing-table.ts";

// Match logic now lives in ../routing-table.ts (matchRoutingTable) - the single
// matcher shared with `ax dispatches --candidates` (ADR-0014 follow-up).

// ---------------------------------------------------------------------------
// Cost multiplier hint (rough guidance - not exact)
// ---------------------------------------------------------------------------

const costHint = (suggest: string): string => {
  // Multipliers vs the expensive tiers (fable/opus) per current agent_model
  // pricing: fable->haiku 10x, opus->haiku 5x; fable->sonnet ~3x.
  switch (suggest) {
    case "haiku":
      return "~5-10x";
    case "sonnet":
      return "~2-3x";
    default:
      return "significantly";
  }
};

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
      const input = event.tool?.input ?? {};
      const model = input.model;
      const subagentType =
        typeof input.subagent_type === "string" ? input.subagent_type : undefined;
      const rawDescription =
        typeof input.description === "string" ? input.description : undefined;
      const rawPrompt =
        typeof input.prompt === "string" ? input.prompt.slice(0, 120) : undefined;

      // Explicit model set - the caller has already made a deliberate choice.
      if (model !== undefined && model !== null && model !== "") {
        return Verdict.allow;
      }

      const description = rawDescription ?? rawPrompt;

      const table = loadRoutingTableOrDefault();
      const match = matchRoutingTable(table, description, subagentType);

      if (match === null) return Verdict.allow;

      const label = rawDescription
        ? `"${rawDescription}"`
        : subagentType
          ? `agent-type "${subagentType}"`
          : `"${description ?? "(unknown)"}"`;

      const msg =
        `ax routing: ${label} looks like ${match.reason} work - ` +
        `consider model: "${match.suggest}" on this dispatch ` +
        `(est ${costHint(match.suggest)} cheaper). ` +
        `Explicit model silences this.`;

      return Verdict.warn(msg);
    }),
});

export default hook;
if (import.meta.main) void runMain(hook);
