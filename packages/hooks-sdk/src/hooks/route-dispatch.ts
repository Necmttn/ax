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
 */

import { Effect, Result, Schema } from "effect";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { defineHook, runMain } from "../define.ts";
import { GitEnv } from "../git-env.ts";
import { Verdict } from "../verdict.ts";

// ---------------------------------------------------------------------------
// Routing table schema
// ---------------------------------------------------------------------------

const RoutingClass = Schema.Struct({
  id: Schema.String,
  pattern: Schema.String,
  flags: Schema.optional(Schema.String),
  suggest: Schema.String,
  reason: Schema.String,
  // Provenance tag written by ax routing compile/tune ("default" | "user").
  // Kept as a plain optional string: the hook never reads origin, so an
  // unknown value must not fail the whole-table decode (which would silently
  // revert the user's routing table to DEFAULT_TABLE).
  origin: Schema.optional(Schema.String),
});

const RoutingTable = Schema.Struct({
  version: Schema.Literal(1),
  classes: Schema.Array(RoutingClass),
  agentTypes: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

type RoutingTableType = Schema.Schema.Type<typeof RoutingTable>;

export { RoutingTable as RoutingTableSchema };

// ---------------------------------------------------------------------------
// Built-in defaults (used when ~/.ax/hooks/routing-table.json is absent /
// unparseable - the hook must work before any compile-routing step exists)
// ---------------------------------------------------------------------------

const DEFAULT_TABLE: RoutingTableType = {
  version: 1,
  classes: [
    // Quality reviews and PR reviews deliberately have NO class: the main
    // model is the Q&A reviewer in this workflow, so only the mechanical
    // spec-compliance pass routes down. Mirrors ROUTING_CLASSES in
    // apps/axctl/src/queries/dispatch-analytics.ts (compile-routing unifies).
    {
      id: "spec-review",
      pattern: "^spec review",
      flags: "i",
      suggest: "sonnet",
      reason: "spec-compliance checklist review",
    },
    {
      id: "search-locate",
      pattern: "^(pattern-find|locate|find|map|sweep|grep)",
      flags: "i",
      suggest: "haiku",
      reason: "code search/sweep",
    },
    {
      id: "research",
      pattern: "^(research|investigate docs|study)",
      flags: "i",
      suggest: "sonnet",
      reason: "web/docs research",
    },
    {
      id: "well-specified-impl",
      pattern: "^implement ",
      flags: "i",
      suggest: "sonnet",
      reason: "spec'd implementation",
    },
    {
      id: "bulk-mechanical",
      pattern: "^(write announcements|regenerate|standardize|merge main)",
      flags: "i",
      suggest: "sonnet",
      reason: "bulk mechanical work",
    },
    // Mined by /routing-tune 2026-06-12; mirrors dispatch-analytics.ts.
    {
      id: "task-N-impl",
      pattern: "^Task \\d+:",
      flags: "i",
      suggest: "sonnet",
      reason: "numbered plan-task implementation",
    },
    {
      id: "bug-fix",
      pattern: "^Fix\\s",
      flags: "i",
      suggest: "sonnet",
      reason: "bounded bug-fix remediation",
    },
    {
      id: "feature-add",
      pattern: "^Add\\s",
      flags: "i",
      suggest: "sonnet",
      reason: "additive feature with a clear target",
    },
  ],
  agentTypes: {
    Explore: "haiku",
    "codebase-locator": "haiku",
    "codebase-pattern-finder": "haiku",
    "codebase-analyzer": "sonnet",
  },
};

// ---------------------------------------------------------------------------
// Load routing table (synchronous; fails open on any error)
// ---------------------------------------------------------------------------

const ROUTING_TABLE_PATH = `${homedir()}/.ax/hooks/routing-table.json`;

const decodeRoutingTable = Schema.decodeUnknownResult(RoutingTable);

/**
 * Load and validate the routing table from disk.
 * Returns DEFAULT_TABLE on any error (missing file, bad JSON, schema mismatch).
 */
const loadRoutingTable = (): RoutingTableType => {
  try {
    const text = readFileSync(ROUTING_TABLE_PATH, "utf8");
    const parsed: unknown = JSON.parse(text);
    const result = decodeRoutingTable(parsed);
    if (Result.isSuccess(result)) return result.success;
    // Schema validation failed - fall back to defaults (fail open)
    return DEFAULT_TABLE;
  } catch {
    // File absent, unreadable, or non-JSON - fall back to defaults
    return DEFAULT_TABLE;
  }
};

// ---------------------------------------------------------------------------
// Match logic (pure, synchronous)
// ---------------------------------------------------------------------------

interface MatchResult {
  readonly classId: string;
  readonly suggest: string;
  readonly reason: string;
  readonly source: "agentType" | "description";
}

const matchTable = (
  table: RoutingTableType,
  description: string | undefined,
  subagentType: string | undefined,
): MatchResult | null => {
  // 1. Agent-type rules win first (more specific)
  if (subagentType && table.agentTypes) {
    const suggest = table.agentTypes[subagentType];
    if (suggest) {
      return {
        classId: `agent-type:${subagentType}`,
        suggest,
        reason: `agent type ${subagentType}`,
        source: "agentType",
      };
    }
  }

  // 2. Description/prompt pattern matching
  if (description) {
    for (const cls of table.classes) {
      try {
        const flags = cls.flags ?? "";
        const re = new RegExp(cls.pattern, flags);
        if (re.test(description)) {
          return {
            classId: cls.id,
            suggest: cls.suggest,
            reason: cls.reason,
            source: "description",
          };
        }
      } catch {
        // Malformed regex in routing table entry - skip this entry
        continue;
      }
    }
  }

  return null;
};

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
  run: (event) =>
    // GitEnv is required by the HookDefinition interface signature, but this
    // hook does not need git state. We yield* it to satisfy the type, but
    // never call any of its methods.
    Effect.gen(function* () {
      void (yield* GitEnv); // satisfy R=GitEnv; unused

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

      const table = loadRoutingTable();
      const match = matchTable(table, description, subagentType);

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
