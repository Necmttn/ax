/**
 * Routing-table schema + read seam - the single source of truth for
 * ~/.ax/hooks/routing-table.json (ADR-0014).
 *
 * Consumed from two very different runtimes, so two readers live here:
 *
 *  - `readRoutingTableSync` / `loadRoutingTableOrDefault`: the hook FIRE PATH
 *    (`bun <file>.ts` from ~/.ax/hooks, ~70ms budget). Synchronous node:fs
 *    read so the hook's error channel stays `never` under plain bun, and
 *    whole-table fail-open semantics: ANY problem (missing file, bad JSON,
 *    schema mismatch) falls back to the built-in defaults - a corrupt table
 *    must never wedge or silently disable the agent.
 *
 *  - `loadStoredRoutingTable` (+ pure `parseStoredRoutingTable`): the axctl
 *    compile/tune side (`ax routing compile|tune|show`). Effect + FileSystem,
 *    row-level normalization: malformed class rows are dropped (not the whole
 *    table), a missing/non-object agentTypes becomes {}, and origin tags are
 *    preserved so merge logic can tell defaults from user rows. Returns null
 *    on a structurally bad file so callers can refuse to overwrite it.
 *
 * axctl's merge/compile/save logic stays in
 * apps/axctl/src/queries/routing-table-io.ts - this module owns only the
 * schema (types + validation) and the read path. Keep it dependency-light:
 * the fire path loads it via a file: dep on this package (no axctl imports,
 * `effect` only).
 */

import { Effect, FileSystem, Result, Schema } from "effect";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Schema (validation used on the fire path)
// ---------------------------------------------------------------------------

export const RoutingClassSchema = Schema.Struct({
  id: Schema.String,
  pattern: Schema.String,
  flags: Schema.optional(Schema.String),
  suggest: Schema.String,
  reason: Schema.String,
  // Provenance tag written by ax routing compile/tune ("default" | "user").
  // Kept as a plain optional string: the hook never reads origin, so an
  // unknown value must not fail the whole-table decode (which would silently
  // revert the user's routing table to the built-in defaults).
  origin: Schema.optional(Schema.String),
});

export const RoutingTableSchema = Schema.Struct({
  version: Schema.Literal(1),
  classes: Schema.Array(RoutingClassSchema),
  agentTypes: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

/** Decoded shape of a stored routing table (flags/origin/agentTypes optional). */
export type RoutingTableShape = Schema.Schema.Type<typeof RoutingTableSchema>;

// ---------------------------------------------------------------------------
// Strict compile-side types (every default carries explicit flags/agentTypes)
// ---------------------------------------------------------------------------

export interface RoutingClass {
  readonly id: string;
  readonly pattern: string;
  readonly flags: string;
  readonly suggest: string; // "sonnet" | "haiku"
  readonly reason: string;
}

export interface RoutingTable {
  readonly version: 1;
  readonly classes: ReadonlyArray<RoutingClass>;
  readonly agentTypes: Readonly<Record<string, string>>;
}

export type ClassOrigin = "default" | "user";

/**
 * What a load from disk can actually promise: legacy files (written by the
 * pre-origin `ax dispatches compile-routing`) and hand-added rows may lack
 * the origin tag. axctl's mergeRoutingTables accepts this shape and always
 * RETURNS definite origins (origin-less rows are migrated to "user").
 */
export interface LoadedRoutingClass extends RoutingClass {
  readonly origin?: ClassOrigin;
}

export interface LoadedRoutingTable {
  readonly version: 1;
  readonly classes: ReadonlyArray<LoadedRoutingClass>;
  readonly agentTypes: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Match (the single matcher both the fire-path hook and `ax dispatches
// --candidates` consume - ADR-0014 follow-up; they had byte-identical copies)
// ---------------------------------------------------------------------------

export interface RoutingMatch {
  readonly classId: string;
  readonly suggest: string;
  readonly reason: string;
  readonly source: "agentType" | "description";
}

/**
 * Match a dispatch's agent-type + description against a routing table. Agent-type
 * rules win first (more specific); then description is tested against each class
 * pattern in order, first hit wins. A malformed regex in a class is skipped, not
 * fatal. Accepts the loose `RoutingTableShape` (flags/agentTypes optional) so
 * both the fire path (hand-edited table on disk) and the strict in-memory
 * `RoutingTable` (assignable to the shape) call it unchanged.
 */
export const matchRoutingTable = (
  table: RoutingTableShape,
  description: string | null | undefined,
  agentType: string | null | undefined,
): RoutingMatch | null => {
  if (agentType && table.agentTypes) {
    const suggest = table.agentTypes[agentType];
    if (suggest) {
      return {
        classId: `agent-type:${agentType}`,
        suggest,
        reason: `agent type ${agentType}`,
        source: "agentType",
      };
    }
  }
  if (description) {
    for (const cls of table.classes) {
      try {
        const re = new RegExp(cls.pattern, cls.flags ?? "");
        if (re.test(description)) {
          return {
            classId: cls.id,
            suggest: cls.suggest,
            reason: cls.reason,
            source: "description",
          };
        }
      } catch {
        // Malformed regex in a routing-table entry - skip it.
        continue;
      }
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// Path
// ---------------------------------------------------------------------------

export const defaultRoutingTablePath = (): string =>
  `${homedir()}/.ax/hooks/routing-table.json`;

// ---------------------------------------------------------------------------
// Built-in defaults: the shipped seed (axctl exposes it as ROUTING_CLASSES).
// Used by the fire path when routing-table.json is absent/unparseable - the
// route-dispatch hook must work before any compile-routing step exists - and
// refreshed into the stored table on every `ax routing compile`.
// ---------------------------------------------------------------------------

export const DEFAULT_ROUTING_TABLE: RoutingTable = {
  version: 1,
  classes: [
    // Quality reviews and PR reviews deliberately have NO class: the main
    // model is the Q&A reviewer in this workflow, so only the mechanical
    // spec-compliance pass routes down.
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
    // Mined by /routing-tune 2026-06-12 (adversarially backtested over 90d;
    // brief: .ax/tasks/routing-tune-undated.md). The colon in task-N-impl
    // is load-bearing: "Task 4 spec compliance review" (no colon) must NOT
    // match - reviews stay on the main model.
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
// Fire-path read (synchronous; fails open on any error)
// ---------------------------------------------------------------------------

const decodeRoutingTable = Schema.decodeUnknownResult(RoutingTableSchema);

/**
 * Synchronously read + validate a stored routing table.
 * Returns null on ANY error (missing file, bad JSON, schema mismatch).
 */
export const readRoutingTableSync = (
  path: string = defaultRoutingTablePath(),
): RoutingTableShape | null => {
  try {
    const text = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(text);
    const result = decodeRoutingTable(parsed);
    if (Result.isSuccess(result)) return result.success;
    return null;
  } catch {
    return null;
  }
};

/**
 * The fire-path loader: stored table if valid, else the built-in defaults
 * (fail open - a corrupt table must never disable routing suggestions).
 */
export const loadRoutingTableOrDefault = (
  path: string = defaultRoutingTablePath(),
): RoutingTableShape => readRoutingTableSync(path) ?? DEFAULT_ROUTING_TABLE;

// ---------------------------------------------------------------------------
// Compile-side read (row-level normalization; null = structurally bad file)
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Rebuild a class row from untrusted JSON; null when required fields are bad. */
const normalizeClassRow = (row: unknown): LoadedRoutingClass | null => {
  if (!isRecord(row)) return null;
  if (
    typeof row.id !== "string" ||
    typeof row.pattern !== "string" ||
    typeof row.suggest !== "string" ||
    typeof row.reason !== "string"
  ) {
    return null;
  }
  const base = {
    id: row.id,
    pattern: row.pattern,
    flags: typeof row.flags === "string" ? row.flags : "",
    suggest: row.suggest,
    reason: row.reason,
  };
  const origin = row.origin === "default" || row.origin === "user" ? row.origin : undefined;
  return origin === undefined ? base : { ...base, origin };
};

/**
 * Parse + normalize stored routing-table text. Null on bad JSON or a bad
 * top-level shape. Malformed class rows are dropped; a missing or non-object
 * agentTypes becomes {} (hand-edited files must not type-lie downstream).
 */
export const parseStoredRoutingTable = (text: string): LoadedRoutingTable | null => {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.classes)) {
      return null;
    }
    const classes = parsed.classes
      .map(normalizeClassRow)
      .filter((c): c is LoadedRoutingClass => c !== null);
    const agentTypes: Record<string, string> = isRecord(parsed.agentTypes)
      ? Object.fromEntries(
          Object.entries(parsed.agentTypes).filter(
            (e): e is [string, string] => typeof e[1] === "string",
          ),
        )
      : {};
    return { version: 1, classes, agentTypes } satisfies LoadedRoutingTable;
  } catch {
    return null;
  }
};

/**
 * Read + parse + normalize the stored table (Effect/FileSystem variant for
 * axctl's compile/tune path). Null on missing file / bad JSON / bad top-level
 * shape - callers use null to refuse overwriting a corrupt file.
 */
export const loadStoredRoutingTable = (
  path: string,
): Effect.Effect<LoadedRoutingTable | null, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => null));
    if (text === null) return null;
    return parseStoredRoutingTable(text);
  });
