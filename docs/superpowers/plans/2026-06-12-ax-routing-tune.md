# `ax routing tune` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the routing-table tuning loop to ax users: `~/.ax/hooks/routing-table.json` becomes the live source of truth (user classes survive regeneration), and `ax routing tune` mines the user's own dispatch history for new routing classes deterministically, with an `--emit-brief` agent handoff for judgment-sensitive proposals.

**Architecture:** Three new units. `routing-table-io.ts` owns the stored-table format (origin-tagged classes), merge semantics, and file IO. `routing-tune.ts` owns deterministic mining (token-prefix clustering over unmatched expensive inherit dispatches) as pure functions plus one Effect orchestrator. `ax-routing.ts` is the new CLI verb home (`ax routing tune|compile|show`); `ax dispatches compile-routing` stays as an alias delegating to the same merge-preserving compile. The route-dispatch hook already reads routing-table.json fail-open - it only needs an optional `origin` schema field.

**Tech Stack:** bun ≥1.3, TypeScript strict, Effect v4 beta (`Effect.gen`, `FileSystem`/`Path` services), `effect/unstable/cli` Command/Flag, bun:test.

**Spec:** `docs/superpowers/specs/2026-06-12-routing-tune-ship-and-campaign-design.md` (sub-project A; sub-project B = marketing, separate plan after this ships).

**Conventions for this repo:**
- Run tests with `bun test <path>`. If a global hook blocks `bun test`, write a tmp wrapper script (`/tmp/run-tests.sh` containing `#!/bin/sh\nexec bun test "$@"`) and run that.
- `apps/axctl` uses 4-space indent; `packages/hooks-sdk` uses 2-space.
- Consult `effect-solutions show basics services-and-layers` before writing new Effect code if any pattern below is unfamiliar.
- Commit after every task. Branch: `feat/routing-tune-ship` (already created).

**File map:**
- Create: `apps/axctl/src/queries/routing-table-io.ts` + `.test.ts` - stored format, merge, load/save
- Create: `apps/axctl/src/queries/routing-tune.ts` + `.test.ts` - mining + proposals + brief rendering
- Create: `apps/axctl/src/cli/commands/ax-routing.ts` - CLI group
- Modify: `apps/axctl/src/queries/dispatch-analytics.ts` - `matchRoutingWith`, export `EXPENSIVE_TIER_RE`, candidates accept a table, merge-preserving `compileRouting`
- Modify: `apps/axctl/src/queries/dispatch-analytics.test.ts` - new cases
- Modify: `packages/hooks-sdk/src/hooks/route-dispatch.ts` - optional `origin` field
- Modify: `apps/axctl/src/cli/index.ts` - register `routingRootCommand` + runtime manifest
- Modify: `apps/axctl/src/cli/commands/ax-dispatches.ts` - candidates use effective table; compile-routing delegates note
- Modify: `README.md`, `CLAUDE.md` - command docs

---

### Task 1: routing-table-io.ts - stored format + merge + IO

**Files:**
- Create: `apps/axctl/src/queries/routing-table-io.ts`
- Test: `apps/axctl/src/queries/routing-table-io.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/axctl/src/queries/routing-table-io.test.ts
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";

import { ROUTING_CLASSES } from "./dispatch-analytics.ts";
import {
    mergeRoutingTables,
    loadStoredRoutingTable,
    saveStoredRoutingTable,
    loadEffectiveRoutingTable,
    appendUserClasses,
    type StoredRoutingTable,
    type StoredRoutingClass,
} from "./routing-table-io.ts";

const fsLayers = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);
const run = <A, E>(eff: Effect.Effect<A, E, any>) =>
    Effect.runPromise(eff.pipe(Effect.provide(fsLayers)));

const userClass: StoredRoutingClass = {
    id: "my-mined-class",
    pattern: "^summarize",
    flags: "i",
    suggest: "haiku",
    reason: "mined from my history",
    origin: "user",
};

describe("mergeRoutingTables", () => {
    it("tags all default classes with origin: default", () => {
        const merged = mergeRoutingTables(ROUTING_CLASSES, null);
        expect(merged.classes.length).toBe(ROUTING_CLASSES.classes.length);
        for (const c of merged.classes) expect(c.origin).toBe("default");
    });

    it("preserves user classes from the existing file", () => {
        const existing: StoredRoutingTable = {
            version: 1,
            classes: [
                { ...ROUTING_CLASSES.classes[0]!, origin: "default" },
                userClass,
            ],
            agentTypes: { ...ROUTING_CLASSES.agentTypes },
        };
        const merged = mergeRoutingTables(ROUTING_CLASSES, existing);
        const ids = merged.classes.map((c) => c.id);
        expect(ids).toContain("my-mined-class");
        // defaults refresh: every current default present exactly once
        for (const d of ROUTING_CLASSES.classes) {
            expect(ids.filter((i) => i === d.id)).toHaveLength(1);
        }
    });

    it("drops stale default classes but never user classes", () => {
        const existing: StoredRoutingTable = {
            version: 1,
            classes: [
                { id: "removed-default", pattern: "^x", flags: "i", suggest: "sonnet", reason: "old", origin: "default" },
                userClass,
            ],
            agentTypes: {},
        };
        const merged = mergeRoutingTables(ROUTING_CLASSES, existing);
        const ids = merged.classes.map((c) => c.id);
        expect(ids).not.toContain("removed-default");
        expect(ids).toContain("my-mined-class");
    });

    it("user class shadowed by a new default of the same id defers to the default", () => {
        const existing: StoredRoutingTable = {
            version: 1,
            classes: [{ ...userClass, id: "spec-review" }],
            agentTypes: {},
        };
        const merged = mergeRoutingTables(ROUTING_CLASSES, existing);
        const specReview = merged.classes.filter((c) => c.id === "spec-review");
        expect(specReview).toHaveLength(1);
        expect(specReview[0]!.origin).toBe("default");
    });
});

describe("appendUserClasses", () => {
    it("appends with origin user and dedupes by id", () => {
        const base = mergeRoutingTables(ROUTING_CLASSES, null);
        const out = appendUserClasses(base, [userClass, userClass]);
        expect(out.classes.filter((c) => c.id === "my-mined-class")).toHaveLength(1);
        expect(out.classes.at(-1)!.origin).toBe("user");
    });
});

describe("load/save round-trip", () => {
    it("save then load returns the same table; missing file loads null", async () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-routing-io-"));
        const p = join(dir, "routing-table.json");
        const table = appendUserClasses(mergeRoutingTables(ROUTING_CLASSES, null), [userClass]);
        await run(saveStoredRoutingTable(p, table));
        const loaded = await run(loadStoredRoutingTable(p));
        expect(loaded).toEqual(table);
        const missing = await run(loadStoredRoutingTable(join(dir, "nope.json")));
        expect(missing).toBeNull();
    });

    it("loadEffectiveRoutingTable falls back to defaults when file missing or corrupt", async () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-routing-io-"));
        const corrupt = join(dir, "bad.json");
        writeFileSync(corrupt, "{not json");
        const eff1 = await run(loadEffectiveRoutingTable(corrupt));
        expect(eff1.classes.map((c) => c.id)).toEqual(ROUTING_CLASSES.classes.map((c) => c.id));
        const eff2 = await run(loadEffectiveRoutingTable(join(dir, "absent.json")));
        expect(eff2.classes.length).toBe(ROUTING_CLASSES.classes.length);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/axctl/src/queries/routing-table-io.test.ts`
Expected: FAIL - `Cannot find module './routing-table-io.ts'`

- [ ] **Step 3: Implement routing-table-io.ts**

```typescript
// apps/axctl/src/queries/routing-table-io.ts
/**
 * Stored routing-table format + IO.
 *
 * ~/.ax/hooks/routing-table.json is the live source of truth read by the
 * route-dispatch hook and `ax dispatches --candidates`. Classes carry an
 * `origin` tag: "default" rows are refreshed from ROUTING_CLASSES on every
 * `ax routing compile`; "user" rows (mined by `ax routing tune` or hand-added)
 * survive regeneration. Merge key: class id; a default id always wins.
 */
import { Effect, FileSystem, Path } from "effect";
import { homedir } from "node:os";
import { ROUTING_CLASSES, type RoutingClass, type RoutingTable } from "./dispatch-analytics.ts";

export type ClassOrigin = "default" | "user";

export interface StoredRoutingClass extends RoutingClass {
    readonly origin: ClassOrigin;
}

export interface StoredRoutingTable {
    readonly version: 1;
    readonly classes: ReadonlyArray<StoredRoutingClass>;
    readonly agentTypes: Readonly<Record<string, string>>;
}

export const defaultRoutingTablePath = (): string =>
    `${homedir()}/.ax/hooks/routing-table.json`;

/** Refresh defaults, keep user classes. Default ids always win on collision. */
export const mergeRoutingTables = (
    defaults: RoutingTable,
    existing: StoredRoutingTable | null,
): StoredRoutingTable => {
    const defaultClasses: StoredRoutingClass[] = defaults.classes.map((c) => ({
        ...c,
        origin: "default" as const,
    }));
    const defaultIds = new Set(defaultClasses.map((c) => c.id));
    const userClasses = (existing?.classes ?? []).filter(
        (c) => c.origin === "user" && !defaultIds.has(c.id),
    );
    return {
        version: 1,
        classes: [...defaultClasses, ...userClasses],
        agentTypes: { ...defaults.agentTypes, ...(existing?.agentTypes ?? {}) },
    };
};

/** Append mined classes as origin: user, deduping by id (first wins). */
export const appendUserClasses = (
    table: StoredRoutingTable,
    additions: ReadonlyArray<StoredRoutingClass>,
): StoredRoutingTable => {
    const seen = new Set(table.classes.map((c) => c.id));
    const fresh: StoredRoutingClass[] = [];
    for (const a of additions) {
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        fresh.push({ ...a, origin: "user" });
    }
    return { ...table, classes: [...table.classes, ...fresh] };
};

/** Read + parse the stored table. Null on missing file / bad JSON / bad shape. */
export const loadStoredRoutingTable = (
    path: string,
): Effect.Effect<StoredRoutingTable | null, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const text = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => null));
        if (text === null) return null;
        try {
            const parsed = JSON.parse(text) as StoredRoutingTable;
            if (parsed?.version !== 1 || !Array.isArray(parsed.classes)) return null;
            return parsed;
        } catch {
            return null;
        }
    });

export const saveStoredRoutingTable = (
    path: string,
    table: StoredRoutingTable,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const p = yield* Path.Path;
        yield* fs.makeDirectory(p.dirname(path), { recursive: true }).pipe(Effect.orDie);
        yield* fs.writeFileString(path, JSON.stringify(table, null, 2)).pipe(Effect.orDie);
    });

/**
 * The table the rest of the loop should match against: stored file if valid,
 * else built-in defaults. Same fail-open semantics as the route-dispatch hook.
 */
export const loadEffectiveRoutingTable = (
    path?: string,
): Effect.Effect<RoutingTable, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const stored = yield* loadStoredRoutingTable(path ?? defaultRoutingTablePath());
        if (stored === null) return ROUTING_CLASSES;
        return {
            version: 1,
            classes: stored.classes,
            agentTypes: stored.agentTypes,
        } satisfies RoutingTable;
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/axctl/src/queries/routing-table-io.test.ts`
Expected: PASS (all)

- [ ] **Step 5: Typecheck + commit**

Run: `bun run typecheck`
Expected: clean.

```bash
git add apps/axctl/src/queries/routing-table-io.ts apps/axctl/src/queries/routing-table-io.test.ts
git commit -m "feat(routing): stored routing-table format with origin-tagged merge"
```

---

### Task 2: dispatch-analytics - table-parameterized matching + candidates use effective table

**Files:**
- Modify: `apps/axctl/src/queries/dispatch-analytics.ts` (matchRouting at lines 141-175, EXPENSIVE_TIER_RE at line 128, fetchDispatchCandidates at lines 485-683)
- Test: `apps/axctl/src/queries/dispatch-analytics.test.ts`

- [ ] **Step 1: Write the failing tests** (append to the existing test file)

```typescript
// append to apps/axctl/src/queries/dispatch-analytics.test.ts
import { matchRoutingWith, EXPENSIVE_TIER_RE } from "./dispatch-analytics.ts";
// (merge into the existing import block from "./dispatch-analytics.ts")

describe("matchRoutingWith", () => {
    const customTable = {
        version: 1 as const,
        classes: [
            { id: "summarize", pattern: "^summarize", flags: "i", suggest: "haiku", reason: "bulk summaries" },
        ],
        agentTypes: {},
    };

    it("matches against the supplied table, not ROUTING_CLASSES", () => {
        const m = matchRoutingWith(customTable, "Summarize the changelog", null);
        expect(m?.classId).toBe("summarize");
        // a ROUTING_CLASSES-only pattern must NOT match through the custom table
        expect(matchRoutingWith(customTable, "Implement Task 1: foo", null)).toBeNull();
    });

    it("matchRouting still delegates to the built-in table", () => {
        expect(matchRouting("Implement the parser", null)?.classId).toBe("well-specified-impl");
    });
});

describe("EXPENSIVE_TIER_RE", () => {
    it("matches fable and opus, not sonnet/haiku", () => {
        expect(EXPENSIVE_TIER_RE.test("claude-fable-5")).toBe(true);
        expect(EXPENSIVE_TIER_RE.test("claude-opus-4-8")).toBe(true);
        expect(EXPENSIVE_TIER_RE.test("claude-sonnet-4-6")).toBe(false);
    });
});

describe("fetchDispatchCandidates with a custom table", () => {
    it("uses the supplied table for matching", async () => {
        // one spawned row whose description only matches the custom table
        const spawned = [{
            parent_id: "session:p1", child_id: "session:c1", ts: "2026-06-12T00:00:00Z",
            agent_type: "general-purpose", description: "Summarize the changelog", tool_use_id: "tu1",
        }];
        const usage = [{
            session_id: "session:c1", model: "claude-fable-5",
            prompt_tokens: 1000, completion_tokens: 100,
            cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: 1.0,
        }];
        const toolCalls = [{ session_id: "session:p1", call_id: "tu1", input_json: "{}" }];
        const layer = makeMockDb([spawned, usage, toolCalls, [], []]);
        const customTable = {
            version: 1 as const,
            classes: [{ id: "summarize", pattern: "^summarize", flags: "i", suggest: "haiku", reason: "bulk summaries" }],
            agentTypes: {},
        };
        const result = await run(
            fetchDispatchCandidates({ sinceDays: 14, table: customTable }),
            layer,
        );
        expect(result.candidates).toHaveLength(1);
        expect(result.candidates[0]!.routing_match.classId).toBe("summarize");
    });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `bun test apps/axctl/src/queries/dispatch-analytics.test.ts`
Expected: FAIL - `matchRoutingWith` / `EXPENSIVE_TIER_RE` not exported; `table` option not accepted.

- [ ] **Step 3: Implement**

In `dispatch-analytics.ts`:

3a. Line 128 - export the tier regex (was module-private):

```typescript
// Expensive model tiers (candidate filter)
export const EXPENSIVE_TIER_RE = /fable|opus/i;
```

3b. Replace `matchRouting` (lines 141-175) with a parameterized core + thin wrapper:

```typescript
export const matchRoutingWith = (
    table: RoutingTable,
    description: string | null,
    agentType: string | null,
): RoutingMatch | null => {
    // Agent-type rules win first (more specific)
    if (agentType) {
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
                const re = new RegExp(cls.pattern, cls.flags);
                if (re.test(description)) {
                    return {
                        classId: cls.id,
                        suggest: cls.suggest,
                        reason: cls.reason,
                        source: "description",
                    };
                }
            } catch {
                continue;
            }
        }
    }
    return null;
};

export const matchRouting = (
    description: string | null,
    agentType: string | null,
): RoutingMatch | null => matchRoutingWith(ROUTING_CLASSES, description, agentType);
```

3c. `fetchDispatchCandidates` - accept the table. Change the signature (line 486) and the match call (line 630):

```typescript
export const fetchDispatchCandidates = Effect.fn("queries.fetchDispatchCandidates")(
    function* (opts: { readonly sinceDays: number; readonly table?: RoutingTable }) {
        const table = opts.table ?? ROUTING_CLASSES;
        // ... body unchanged until criterion (c) ...
```

and at criterion (c):

```typescript
            // Candidate criterion (c): description or agent_type matches a routing class
            const routingMatch = matchRoutingWith(table, sp.description, sp.agent_type);
```

- [ ] **Step 4: Run tests**

Run: `bun test apps/axctl/src/queries/dispatch-analytics.test.ts && bun test apps/axctl/src/queries/routing-table-io.test.ts`
Expected: PASS (old + new).

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/queries/dispatch-analytics.ts apps/axctl/src/queries/dispatch-analytics.test.ts
git commit -m "feat(routing): table-parameterized matching, candidates accept an effective table"
```

---

### Task 3: merge-preserving compileRouting

**Files:**
- Modify: `apps/axctl/src/queries/dispatch-analytics.ts` (compileRouting, lines 689-705)
- Test: `apps/axctl/src/queries/dispatch-analytics.test.ts`

- [ ] **Step 1: Write the failing test** (append)

```typescript
describe("compileRouting merge-preserve", () => {
    it("preserves user classes across regeneration and tags defaults", async () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-compile-routing-"));
        const p = join(dir, "routing-table.json");
        // seed
        await runCompileRouting(p);
        // hand-add a user class (simulating a prior `ax routing tune` apply)
        const seeded = JSON.parse(readFileSync(p, "utf8"));
        seeded.classes.push({
            id: "my-mined-class", pattern: "^summarize", flags: "i",
            suggest: "haiku", reason: "mined", origin: "user",
        });
        writeFileSync(p, JSON.stringify(seeded));
        // regenerate
        const result = await runCompileRouting(p);
        expect(result.written).toBe(true);
        const after = JSON.parse(readFileSync(p, "utf8"));
        const ids = after.classes.map((c: { id: string }) => c.id);
        expect(ids).toContain("my-mined-class");
        expect(after.classes[0].origin).toBe("default");
        expect(after.classes.filter((c: { id: string }) => c.id === "spec-review")).toHaveLength(1);
    });
});
```

Note: the test file already imports `mkdtempSync`? It imports `readFileSync` only (line 16) - extend that import to `import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";`.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/axctl/src/queries/dispatch-analytics.test.ts`
Expected: FAIL - regenerated file lost `my-mined-class` (current implementation overwrites with `ROUTING_CLASSES`).

- [ ] **Step 3: Implement** - replace `compileRouting` body to load-merge-save via routing-table-io:

```typescript
import { loadStoredRoutingTable, mergeRoutingTables, saveStoredRoutingTable } from "./routing-table-io.ts";
// NOTE: routing-table-io imports ROUTING_CLASSES from this file. That is a
// module cycle bun/TS tolerate (type+const, no top-level side effects), but
// keep compileRouting's merge call referencing the imported helpers only.

export interface CompileRoutingResult {
    readonly path: string;
    readonly written: boolean;
    readonly preserved_user_classes: number;
}

export const compileRouting = (
    outPath?: string,
): Effect.Effect<CompileRoutingResult, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolvedPath = outPath ?? path.join(homedir(), ".ax", "hooks", "routing-table.json");
        const existing = yield* loadStoredRoutingTable(resolvedPath);
        const merged = mergeRoutingTables(ROUTING_CLASSES, existing);
        yield* saveStoredRoutingTable(resolvedPath, merged);
        const preserved = merged.classes.filter((c) => c.origin === "user").length;
        return { path: resolvedPath, written: true, preserved_user_classes: preserved };
    });
```

If the import cycle trips typecheck or runtime (`undefined` ROUTING_CLASSES at module init), break it by moving `RoutingClass`/`RoutingTable`/`ROUTING_CLASSES` into a new `apps/axctl/src/queries/routing-classes.ts` and re-exporting them from `dispatch-analytics.ts` (`export { ROUTING_CLASSES, type RoutingClass, type RoutingTable } from "./routing-classes.ts";`) so all existing importers keep working. Prefer the cycle-free split if you touch it at all.

- [ ] **Step 4: Run tests**

Run: `bun test apps/axctl/src/queries/`
Expected: PASS. The pre-existing test "compile-routing JSON shape via tmp dir" may assert the old shape (no `origin`); update its expectations to the merged shape (classes carry `origin: "default"`, result has `preserved_user_classes: 0`).

- [ ] **Step 5: Update the CLI text** in `apps/axctl/src/cli/commands/ax-dispatches.ts` line 199 to surface preservation:

```typescript
            console.log(
                result.preserved_user_classes > 0
                    ? `routing-table written: ${result.path} (${result.preserved_user_classes} user classes preserved)`
                    : `routing-table written: ${result.path}`,
            );
```

- [ ] **Step 6: Typecheck + commit**

Run: `bun run typecheck && bun test apps/axctl/src`
Expected: clean / pass.

```bash
git add apps/axctl/src/queries/dispatch-analytics.ts apps/axctl/src/queries/dispatch-analytics.test.ts apps/axctl/src/cli/commands/ax-dispatches.ts
git commit -m "feat(routing): compileRouting preserves origin:user classes on regenerate"
```

---

### Task 4: hooks-sdk - tolerate origin field in routing-table.json

**Files:**
- Modify: `packages/hooks-sdk/src/hooks/route-dispatch.ts` (RoutingClass schema, lines 33-39)
- Test: locate the existing hook test with `rg -l "route-dispatch" packages/hooks-sdk/src --glob '*.test.ts'`; if none exists, create `packages/hooks-sdk/src/hooks/route-dispatch.test.ts`

- [ ] **Step 1: Write the failing test** (2-space indent in this package)

```typescript
// packages/hooks-sdk/src/hooks/route-dispatch.test.ts (or append to existing)
import { describe, expect, it } from "bun:test";
import { Result, Schema } from "effect";

// The schema is module-private; test through the exported decode boundary by
// re-declaring the input shape the hook must accept from disk.
// Add this export to route-dispatch.ts: `export { RoutingTable as RoutingTableSchema };`
import { RoutingTableSchema } from "./route-dispatch.ts";

describe("route-dispatch routing-table schema", () => {
  it("accepts origin-tagged classes written by ax routing compile/tune", () => {
    const decode = Schema.decodeUnknownResult(RoutingTableSchema);
    const result = decode({
      version: 1,
      classes: [
        { id: "spec-review", pattern: "^spec review", flags: "i", suggest: "sonnet", reason: "x", origin: "default" },
        { id: "mined", pattern: "^summarize", flags: "i", suggest: "haiku", reason: "y", origin: "user" },
      ],
      agentTypes: { Explore: "haiku" },
    });
    expect(Result.isSuccess(result)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to check current behavior**

Run: `bun test packages/hooks-sdk/src/hooks/route-dispatch.test.ts`
Expected: FAIL on the missing `RoutingTableSchema` export. (Effect Schema ignores excess properties by default, but the explicit optional field + export makes the contract testable and survives a future strict-decode change.)

- [ ] **Step 3: Implement** - in `route-dispatch.ts`:

```typescript
const RoutingClass = Schema.Struct({
  id: Schema.String,
  pattern: Schema.String,
  flags: Schema.optional(Schema.String),
  suggest: Schema.String,
  reason: Schema.String,
  origin: Schema.optional(Schema.Literals(["default", "user"])),
});
```

and after the `RoutingTable` struct declaration add:

```typescript
export { RoutingTable as RoutingTableSchema };
```

If `Schema.Literals` doesn't exist in this effect beta, use `Schema.Union(Schema.Literal("default"), Schema.Literal("user"))` - check `.references/effect-smol/packages/effect/src/Schema.ts` for the current literal-union API before guessing.

- [ ] **Step 4: Run tests**

Run: `bun test packages/hooks-sdk`
Expected: PASS (existing hook tests + new).

- [ ] **Step 5: Commit**

```bash
git add packages/hooks-sdk/src/hooks/route-dispatch.ts packages/hooks-sdk/src/hooks/route-dispatch.test.ts
git commit -m "feat(hooks-sdk): route-dispatch schema accepts origin-tagged routing classes"
```

---

### Task 5: routing-tune.ts - deterministic mining (pure functions)

**Files:**
- Create: `apps/axctl/src/queries/routing-tune.ts`
- Test: `apps/axctl/src/queries/routing-tune.test.ts`

Mining algorithm: normalize each unmatched description to a two-token prefix key (lowercased, digit-runs → `N`, punctuation stripped), group by key, keep clusters with ≥3 members, derive a regex pattern from the key, suggest haiku when the cluster is dominated by search-tier agent types, flag judgment-work clusters (never auto-applied).

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/axctl/src/queries/routing-tune.test.ts
import { describe, expect, it } from "bun:test";
import type { DispatchRow } from "./dispatch-analytics.ts";
import { ROUTING_CLASSES } from "./dispatch-analytics.ts";
import {
    normalizeKey,
    clusterRows,
    buildProposals,
    JUDGMENT_RE,
    renderTuneBrief,
    type TuneProposal,
} from "./routing-tune.ts";

const row = (description: string, agent_type = "general-purpose", cost = 1): DispatchRow => ({
    ts: "2026-06-12T00:00:00Z", parent_id: "p", child_id: "c",
    agent_type, description, dispatch_model: "inherit",
    child_model: "claude-fable-5", child_cost_usd: cost,
    prompt_tokens: 0, completion_tokens: 0, cache_read_tokens: 0, cache_create_tokens: 0,
});

describe("normalizeKey", () => {
    it("two-token lowercase prefix, digits collapsed to N, punctuation stripped", () => {
        expect(normalizeKey("Summarize the changelog")).toBe("summarize the");
        expect(normalizeKey("Port module 3: parser")).toBe("port module");
        expect(normalizeKey("Triage 12 issues")).toBe("triage N");
    });
    it("single-token descriptions key on that token", () => {
        expect(normalizeKey("Refactor")).toBe("refactor");
    });
    it("empty/null-ish input yields null", () => {
        expect(normalizeKey("")).toBeNull();
        expect(normalizeKey("  ")).toBeNull();
    });
});

describe("clusterRows + buildProposals", () => {
    const rows = [
        row("Summarize the changelog", "general-purpose", 2),
        row("Summarize the release notes", "general-purpose", 3),
        row("Summarize the diff", "general-purpose", 1),
        row("Triage 12 issues", "general-purpose", 1),  // count 1 -> dropped
        row("Sweep docs for stale links", "Explore", 1),
        row("Sweep docs for flaky markers", "Explore", 2),
        row("Sweep docs for dead flags", "codebase-locator", 1),
        row("Review architecture of ingest", "general-purpose", 5),
        row("Review architecture of studio", "general-purpose", 5),
        row("Review architecture of hooks", "general-purpose", 5),
    ];

    it("clusters by key and drops below-threshold clusters", () => {
        const clusters = clusterRows(rows);
        const proposals = buildProposals(clusters);
        const ids = proposals.map((p) => p.id);
        expect(ids).toContain("summarize-the");
        expect(ids).toContain("sweep-docs");
        expect(ids).not.toContain("triage-N");
    });

    it("suggests haiku for search-tier-dominated clusters, sonnet otherwise", () => {
        const proposals = buildProposals(clusterRows(rows));
        const sweep = proposals.find((p) => p.id.startsWith("sweep"));
        const summarize = proposals.find((p) => p.id === "summarize-the");
        expect(sweep?.suggest).toBe("haiku");
        expect(summarize?.suggest).toBe("sonnet");
    });

    it("flags judgment clusters; pattern derives from the key with N -> \\d+", () => {
        const proposals = buildProposals(clusterRows(rows));
        const review = proposals.find((p) => p.id === "review-architecture");
        expect(review?.judgment).toBe(true);
        const summarize = proposals.find((p) => p.id === "summarize-the");
        expect(summarize?.pattern).toBe("^summarize\\s+the");
        expect(summarize?.judgment).toBe(false);
        expect(new RegExp(summarize!.pattern, "i").test("Summarize the weekly report")).toBe(true);
    });

    it("orders proposals by total cost desc and carries examples + counts", () => {
        const proposals = buildProposals(clusterRows(rows));
        expect(proposals[0]!.id).toBe("review-architecture"); // $15 cluster
        const summarize = proposals.find((p) => p.id === "summarize-the")!;
        expect(summarize.count).toBe(3);
        expect(summarize.total_cost_usd).toBe(6);
        expect(summarize.examples.length).toBeGreaterThan(0);
    });
});

describe("JUDGMENT_RE", () => {
    it("matches review/critique/design/plan/audit/judge/verify/assess", () => {
        for (const word of ["Review X", "Critique Y", "Design Z", "Plan the migration", "Audit deps", "Judge outputs", "Verify claims", "Assess risk"]) {
            expect(JUDGMENT_RE.test(word)).toBe(true);
        }
        expect(JUDGMENT_RE.test("Summarize the changelog")).toBe(false);
    });
});

describe("renderTuneBrief", () => {
    it("renders proposals with backtest instructions and the apply command", () => {
        const proposals: TuneProposal[] = [{
            id: "summarize-the", pattern: "^summarize\\s+the", flags: "i", suggest: "sonnet",
            reason: "mined 2026-06-12: 3 dispatches, $6.00 addressable",
            count: 3, total_cost_usd: 6, examples: ["Summarize the changelog"], judgment: false,
        }];
        const brief = renderTuneBrief(proposals, { days: 30, date: "2026-06-12" });
        expect(brief).toContain("summarize-the");
        expect(brief).toContain("adversarially");
        expect(brief).toContain("ax routing tune --apply");
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/axctl/src/queries/routing-tune.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement routing-tune.ts**

```typescript
// apps/axctl/src/queries/routing-tune.ts
/**
 * `ax routing tune` - deterministic mining of new routing classes from the
 * user's own dispatch history.
 *
 * The agent-driven /routing-tune workflow (committed, ax-repo-only) remains
 * the tool for tuning the shipped ROUTING_CLASSES defaults; this module is the
 * user-facing deterministic subset: cluster unmatched expensive inherit
 * dispatches by two-token description prefix, propose origin:user classes.
 *
 * Honest-savings semantics (PR #312): proposals report ADDRESSABLE spend (the
 * cluster's actual child cost), not a fabricated repriced delta.
 *
 * Judgment-work clusters (review/critique/design/...) are NEVER auto-applied:
 * quality reviews stay on the main model by design; those proposals only ship
 * via --emit-brief for an agent to adversarially backtest.
 */
import { Effect } from "effect";
import {
    fetchDispatches,
    matchRoutingWith,
    EXPENSIVE_TIER_RE,
    type DispatchRow,
    type RoutingTable,
} from "./dispatch-analytics.ts";

export const JUDGMENT_RE = /\b(review|critique|design|plan|audit|judge|verif\w*|assess|architect\w*)\b/i;

const HAIKU_AGENT_TYPES = new Set(["Explore", "codebase-locator", "codebase-pattern-finder"]);

export interface TuneProposal {
    readonly id: string;
    readonly pattern: string;
    readonly flags: "i";
    readonly suggest: "sonnet" | "haiku";
    readonly reason: string;
    readonly count: number;
    readonly total_cost_usd: number;
    readonly examples: ReadonlyArray<string>;
    readonly judgment: boolean;
}

/** Two-token lowercase prefix; digit runs -> "N"; punctuation stripped. */
export const normalizeKey = (description: string | null): string | null => {
    if (!description) return null;
    const tokens = description
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((t) => t.toLowerCase().replace(/\d+/g, "N").replace(/[^a-z0-9N-]/g, ""))
        .filter((t) => t.length > 0);
    if (tokens.length === 0) return null;
    return tokens.join(" ");
};

export const clusterRows = (
    rows: ReadonlyArray<DispatchRow>,
): Map<string, DispatchRow[]> => {
    const clusters = new Map<string, DispatchRow[]>();
    for (const r of rows) {
        const key = normalizeKey(r.description);
        if (key === null) continue;
        const list = clusters.get(key) ?? [];
        list.push(r);
        clusters.set(key, list);
    }
    return clusters;
};

const MIN_CLUSTER_SIZE = 3;

const escapeToken = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "summarize the" -> "^summarize\s+the"; "task N" -> "^task\s+\d+" */
const keyToPattern = (key: string): string =>
    "^" + key.split(" ").map((t) => (t === "N" ? "\\d+" : escapeToken(t))).join("\\s+");

export const buildProposals = (
    clusters: Map<string, DispatchRow[]>,
): TuneProposal[] => {
    const proposals: TuneProposal[] = [];
    for (const [key, rows] of clusters) {
        if (rows.length < MIN_CLUSTER_SIZE) continue;
        const totalCost = rows.reduce((s, r) => s + r.child_cost_usd, 0);
        const haikuCount = rows.filter((r) => r.agent_type !== null && HAIKU_AGENT_TYPES.has(r.agent_type)).length;
        const suggest: "sonnet" | "haiku" = haikuCount * 2 >= rows.length ? "haiku" : "sonnet";
        const examples = rows
            .slice(0, 3)
            .map((r) => r.description ?? "")
            .filter((d) => d.length > 0);
        const judgment = JUDGMENT_RE.test(key) || examples.some((e) => JUDGMENT_RE.test(e));
        proposals.push({
            id: key.replace(/\s+/g, "-"),
            pattern: keyToPattern(key),
            flags: "i",
            suggest,
            reason: `mined: ${rows.length} dispatches, $${totalCost.toFixed(2)} addressable`,
            count: rows.length,
            total_cost_usd: totalCost,
            examples,
            judgment,
        });
    }
    proposals.sort((a, b) => b.total_cost_usd - a.total_cost_usd);
    return proposals;
};

/** Fetch window -> filter inherit+expensive+unmatched -> cluster -> proposals. */
export const fetchTuneProposals = Effect.fn("queries.fetchTuneProposals")(
    function* (opts: { readonly sinceDays: number; readonly table: RoutingTable }) {
        const result = yield* fetchDispatches({
            sinceDays: opts.sinceDays,
            limit: Number.MAX_SAFE_INTEGER,
        });
        const unmatched = result.rows.filter(
            (r) =>
                r.dispatch_model === "inherit" &&
                r.child_model !== null &&
                EXPENSIVE_TIER_RE.test(r.child_model) &&
                matchRoutingWith(opts.table, r.description, r.agent_type) === null,
        );
        return buildProposals(clusterRows(unmatched));
    },
);

export const renderTuneBrief = (
    proposals: ReadonlyArray<TuneProposal>,
    opts: { readonly days: number; readonly date: string },
): string => {
    const lines: string[] = [
        `# routing-tune brief - ${opts.date}`,
        "",
        `Mined from the last ${opts.days} days of dispatch history. Each proposal is a`,
        "candidate routing class for `~/.ax/hooks/routing-table.json`.",
        "",
        "## Your task (agent)",
        "",
        "For each proposal below, adversarially backtest it: search the dispatch",
        "history for descriptions that MATCH the pattern but are judgment work",
        "(quality review, design, architecture, planning) - those must stay on the",
        "main model. Kill any proposal with plausible false positives. Then apply",
        "the survivors:",
        "",
        "```bash",
        `ax routing tune --apply=<id,id,...>   # apply surviving proposals by id`,
        "```",
        "",
        "## Proposals",
        "",
        "| id | pattern | suggest | dispatches | addressable | judgment-flagged |",
        "|---|---|---|---|---|---|",
    ];
    for (const p of proposals) {
        lines.push(
            `| ${p.id} | \`${p.pattern.replace(/\|/g, "\\|")}\` | ${p.suggest} | ${p.count} | $${p.total_cost_usd.toFixed(2)} | ${p.judgment ? "YES" : "no"} |`,
        );
    }
    lines.push("", "### Examples per proposal", "");
    for (const p of proposals) {
        lines.push(`- **${p.id}**: ${p.examples.map((e) => `"${e}"`).join(", ")}`);
    }
    lines.push("");
    return lines.join("\n");
};
```

- [ ] **Step 4: Run tests**

Run: `bun test apps/axctl/src/queries/routing-tune.test.ts`
Expected: PASS. (`fetchTuneProposals` is covered in Task 6 with a mock DB.)

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/queries/routing-tune.ts apps/axctl/src/queries/routing-tune.test.ts
git commit -m "feat(routing): deterministic tune mining - prefix clustering, judgment blocklist, brief rendering"
```

---

### Task 6: fetchTuneProposals integration test + apply helper

**Files:**
- Modify: `apps/axctl/src/queries/routing-tune.ts` (add `applyProposals`)
- Test: `apps/axctl/src/queries/routing-tune.test.ts`

- [ ] **Step 1: Write the failing tests** (append; reuse the `makeMockDb` pattern - copy the helper from `dispatch-analytics.test.ts` lines 36-56 into this test file)

```typescript
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchTuneProposals, applyProposals } from "./routing-tune.ts";

type QueryResult = Array<Record<string, unknown>>;
const makeMockDb = (results: QueryResult[]): Layer.Layer<SurrealClient> => {
    const stub: SurrealClientShape = {
        query: (_sql: string) => Effect.succeed(results as [QueryResult, ...QueryResult[]]),
    } as unknown as SurrealClientShape;
    return Layer.succeed(SurrealClient, stub);
};
const fsLayers = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

describe("fetchTuneProposals", () => {
    it("only mines inherit + expensive + unmatched rows", async () => {
        const spawned = [
            // 3x unmatched expensive inherit -> should cluster
            { parent_id: "session:p", child_id: "session:c1", ts: "t", agent_type: "general-purpose", description: "Summarize the changelog", tool_use_id: "t1" },
            { parent_id: "session:p", child_id: "session:c2", ts: "t", agent_type: "general-purpose", description: "Summarize the diff", tool_use_id: "t2" },
            { parent_id: "session:p", child_id: "session:c3", ts: "t", agent_type: "general-purpose", description: "Summarize the notes", tool_use_id: "t3" },
            // matched by default table (well-specified-impl) -> excluded
            { parent_id: "session:p", child_id: "session:c4", ts: "t", agent_type: "general-purpose", description: "Implement the parser", tool_use_id: "t4" },
            // explicit model -> excluded
            { parent_id: "session:p", child_id: "session:c5", ts: "t", agent_type: "general-purpose", description: "Summarize the API", tool_use_id: "t5" },
        ];
        const usage = ["c1", "c2", "c3", "c4", "c5"].map((c) => ({
            session_id: `session:${c}`, model: "claude-fable-5",
            prompt_tokens: 100, completion_tokens: 10,
            cache_read_tokens: 0, cache_create_tokens: 0, cost_usd: 1,
        }));
        const toolCalls = [
            { session_id: "session:p", call_id: "t1", input_json: "{}" },
            { session_id: "session:p", call_id: "t2", input_json: "{}" },
            { session_id: "session:p", call_id: "t3", input_json: "{}" },
            { session_id: "session:p", call_id: "t4", input_json: "{}" },
            { session_id: "session:p", call_id: "t5", input_json: JSON.stringify({ model: "sonnet" }) },
        ];
        const layer = makeMockDb([spawned, usage, toolCalls, []]);
        const proposals = await Effect.runPromise(
            fetchTuneProposals({ sinceDays: 30, table: ROUTING_CLASSES }).pipe(Effect.provide(layer)),
        );
        expect(proposals).toHaveLength(1);
        expect(proposals[0]!.id).toBe("summarize-the");
        expect(proposals[0]!.count).toBe(3);
    });
});

describe("applyProposals", () => {
    it("appends non-judgment proposals as origin:user and skips judgment ones", async () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-tune-apply-"));
        const p = join(dir, "routing-table.json");
        const proposals: TuneProposal[] = [
            { id: "summarize-the", pattern: "^summarize\\s+the", flags: "i", suggest: "sonnet", reason: "mined", count: 3, total_cost_usd: 6, examples: [], judgment: false },
            { id: "review-architecture", pattern: "^review\\s+architecture", flags: "i", suggest: "sonnet", reason: "mined", count: 3, total_cost_usd: 15, examples: [], judgment: true },
        ];
        const result = await Effect.runPromise(
            applyProposals(p, proposals, { ids: null }).pipe(Effect.provide(fsLayers)),
        );
        expect(result.applied.map((a) => a.id)).toEqual(["summarize-the"]);
        expect(result.skipped_judgment.map((s) => s.id)).toEqual(["review-architecture"]);
        const stored = JSON.parse(readFileSync(p, "utf8"));
        const mined = stored.classes.find((c: { id: string }) => c.id === "summarize-the");
        expect(mined.origin).toBe("user");
    });

    it("with explicit ids, applies exactly those (judgment included - the agent vetted them)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-tune-apply-"));
        const p = join(dir, "routing-table.json");
        const proposals: TuneProposal[] = [
            { id: "review-architecture", pattern: "^review\\s+architecture", flags: "i", suggest: "sonnet", reason: "mined", count: 3, total_cost_usd: 15, examples: [], judgment: true },
        ];
        const result = await Effect.runPromise(
            applyProposals(p, proposals, { ids: ["review-architecture"] }).pipe(Effect.provide(fsLayers)),
        );
        expect(result.applied.map((a) => a.id)).toEqual(["review-architecture"]);
        expect(result.skipped_judgment).toHaveLength(0);
    });
});
```

(Also extend the top-of-file import of `routing-tune.ts` symbols to include `ROUTING_CLASSES` from `dispatch-analytics.ts` - already imported in Step 1 of Task 5.)

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/axctl/src/queries/routing-tune.test.ts`
Expected: FAIL - `applyProposals` not exported.

- [ ] **Step 3: Implement `applyProposals`** (append to routing-tune.ts)

```typescript
import { FileSystem, Path } from "effect";
import { ROUTING_CLASSES } from "./dispatch-analytics.ts";
import {
    appendUserClasses,
    loadStoredRoutingTable,
    mergeRoutingTables,
    saveStoredRoutingTable,
    type StoredRoutingClass,
} from "./routing-table-io.ts";

export interface ApplyResult {
    readonly path: string;
    readonly applied: ReadonlyArray<TuneProposal>;
    readonly skipped_judgment: ReadonlyArray<TuneProposal>;
}

/**
 * Apply proposals to the stored routing table.
 * ids === null  -> auto mode: apply all NON-judgment proposals, report skips.
 * ids === [...] -> explicit mode (post-brief): apply exactly those ids;
 *                  judgment flags are ignored because an agent vetted them.
 */
export const applyProposals = (
    tablePath: string,
    proposals: ReadonlyArray<TuneProposal>,
    opts: { readonly ids: ReadonlyArray<string> | null },
): Effect.Effect<ApplyResult, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const selected = opts.ids === null
            ? proposals.filter((p) => !p.judgment)
            : proposals.filter((p) => opts.ids!.includes(p.id));
        const skipped = opts.ids === null ? proposals.filter((p) => p.judgment) : [];
        const existing = yield* loadStoredRoutingTable(tablePath);
        const base = mergeRoutingTables(ROUTING_CLASSES, existing);
        const additions: StoredRoutingClass[] = selected.map((p) => ({
            id: p.id,
            pattern: p.pattern,
            flags: p.flags,
            suggest: p.suggest,
            reason: p.reason,
            origin: "user" as const,
        }));
        const next = appendUserClasses(base, additions);
        yield* saveStoredRoutingTable(tablePath, next);
        return { path: tablePath, applied: selected, skipped_judgment: skipped };
    });
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test apps/axctl/src/queries/ && bun run typecheck`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/queries/routing-tune.ts apps/axctl/src/queries/routing-tune.test.ts
git commit -m "feat(routing): fetchTuneProposals pipeline + applyProposals with judgment gating"
```

---

### Task 7: `ax routing` CLI group + wiring

**Files:**
- Create: `apps/axctl/src/cli/commands/ax-routing.ts`
- Modify: `apps/axctl/src/cli/index.ts` (import at ~line 19; command list at ~line 113; `RUNTIME_BY_COMMAND` spread at ~line 77)
- Modify: `apps/axctl/src/cli/commands/ax-dispatches.ts` (description note only)

No unit-test file for the command layer (matches repo convention - `ax-dispatches.ts` has none; logic lives in tested query modules). Verification is the smoke run in Step 3.

- [ ] **Step 1: Implement ax-routing.ts**

```typescript
// apps/axctl/src/cli/commands/ax-routing.ts
/**
 * `ax routing` - routing-table operations (the tune side of the cost loop).
 *
 *   ax routing tune [--days=N] [--dry-run] [--emit-brief] [--apply=id,id] [--out=PATH] [--json]
 *     Mine dispatch history for new routing classes. Default: apply non-judgment
 *     proposals to ~/.ax/hooks/routing-table.json (origin: user) and print the
 *     diff; judgment-flagged proposals are listed but never auto-applied.
 *     --dry-run prints proposals only. --emit-brief writes
 *     .ax/tasks/routing-tune-<date>.md for an agent to adversarially backtest.
 *     --apply=ids applies exactly those proposal ids (post-brief).
 *
 *   ax routing compile [--out=PATH] [--json]
 *     Merge-preserving regenerate (same engine as `ax dispatches compile-routing`).
 *
 *   ax routing show [--out=PATH] [--json]
 *     Print the effective table with origins.
 */
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { writeFileSync, mkdirSync } from "node:fs";
import { prettyPrint } from "@ax/lib/json";
import { compileRouting } from "../../queries/dispatch-analytics.ts";
import {
    defaultRoutingTablePath,
    loadEffectiveRoutingTable,
    loadStoredRoutingTable,
    mergeRoutingTables,
} from "../../queries/routing-table-io.ts";
import { ROUTING_CLASSES } from "../../queries/dispatch-analytics.ts";
import {
    applyProposals,
    fetchTuneProposals,
    renderTuneBrief,
} from "../../queries/routing-tune.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { fail, jsonFlag, optionValue } from "./shared.ts";

const usd = (n: number): string => `$${n.toFixed(2)}`;

const printProposals = (proposals: ReadonlyArray<{ id: string; pattern: string; suggest: string; count: number; total_cost_usd: number; judgment: boolean }>) => {
    console.log(
        `${"id".padEnd(28)}  ${"pattern".padEnd(32)}  ${"suggest".padEnd(8)}  ${"count".padStart(5)}  ${"addressable".padStart(11)}  judgment`,
    );
    for (const p of proposals) {
        console.log(
            `${p.id.padEnd(28)}  ${p.pattern.padEnd(32)}  ${p.suggest.padEnd(8)}  ` +
            `${String(p.count).padStart(5)}  ${usd(p.total_cost_usd).padStart(11)}  ${p.judgment ? "YES" : "no"}`,
        );
    }
};

const tuneCommand = Command.make(
    "tune",
    {
        days: Flag.integer("days").pipe(Flag.withDefault(30)),
        dryRun: Flag.boolean("dry-run").pipe(Flag.withDefault(false)),
        emitBrief: Flag.boolean("emit-brief").pipe(Flag.withDefault(false)),
        apply: Flag.string("apply").pipe(Flag.optional),
        out: Flag.string("out").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ days, dryRun, emitBrief, apply, out, json }) => Effect.gen(function* () {
        if (!Number.isInteger(days) || days <= 0) {
            fail(`ax routing tune: --days must be a positive integer (got "${days}")`);
        }
        const tablePath = optionValue(out) ?? defaultRoutingTablePath();
        const table = yield* loadEffectiveRoutingTable(tablePath);
        const proposals = yield* fetchTuneProposals({ sinceDays: days, table });

        if (proposals.length === 0) {
            console.log(`(no unmatched expensive inherit clusters in the last ${days} days - table is keeping up)`);
            return;
        }

        if (dryRun) {
            if (json) { console.log(prettyPrint({ proposals })); return; }
            printProposals(proposals);
            console.log(`\n${proposals.length} proposals  addressable spend: ${usd(proposals.reduce((s, p) => s + p.total_cost_usd, 0))}  (${days} days)`);
            console.log(`apply non-judgment: ax routing tune --days=${days}   brief: ax routing tune --emit-brief`);
            return;
        }

        if (emitBrief) {
            const date = new Date().toISOString().slice(0, 10);
            const briefDir = ".ax/tasks";
            const briefPath = `${briefDir}/routing-tune-${date}.md`;
            mkdirSync(briefDir, { recursive: true });
            writeFileSync(briefPath, renderTuneBrief(proposals, { days, date }));
            if (json) { console.log(prettyPrint({ brief: briefPath, proposals })); return; }
            console.log(`brief written: ${briefPath} (${proposals.length} proposals)`);
            console.log(`hand it to your agent; survivors apply with: ax routing tune --apply=<ids>`);
            return;
        }

        const applyRaw = optionValue(apply);
        const ids = applyRaw === undefined
            ? null
            : applyRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
        const result = yield* applyProposals(tablePath, proposals, { ids });
        if (json) { console.log(prettyPrint(result)); return; }
        if (result.applied.length > 0) {
            console.log(`applied ${result.applied.length} classes to ${result.path}:`);
            printProposals(result.applied);
        } else {
            console.log("(nothing applied)");
        }
        if (result.skipped_judgment.length > 0) {
            console.log(`\nskipped ${result.skipped_judgment.length} judgment-flagged proposals (reviews/design stay on the main model):`);
            printProposals(result.skipped_judgment);
            console.log(`vet them via: ax routing tune --emit-brief`);
        }
    }),
).pipe(
    Command.withDescription(
        "Mine dispatch history for new routing classes and apply them to the routing table. " +
        "--days=N (default 30)  --dry-run  --emit-brief (agent backtest handoff)  --apply=id,id  --out=PATH  --json",
    ),
);

const compileCommand = Command.make(
    "compile",
    {
        out: Flag.string("out").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ out, json }) => Effect.gen(function* () {
        const result = yield* compileRouting(optionValue(out));
        if (json) { console.log(prettyPrint(result)); return; }
        console.log(
            result.preserved_user_classes > 0
                ? `routing-table written: ${result.path} (${result.preserved_user_classes} user classes preserved)`
                : `routing-table written: ${result.path}`,
        );
    }),
).pipe(
    Command.withDescription(
        "Regenerate the routing table from built-in defaults, preserving origin:user classes. --out=PATH  --json",
    ),
);

const showCommand = Command.make(
    "show",
    {
        out: Flag.string("out").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ out, json }) => Effect.gen(function* () {
        const tablePath = optionValue(out) ?? defaultRoutingTablePath();
        const stored = yield* loadStoredRoutingTable(tablePath);
        const merged = stored ?? mergeRoutingTables(ROUTING_CLASSES, null);
        if (json) { console.log(prettyPrint({ path: tablePath, stored: stored !== null, table: merged })); return; }
        if (stored === null) {
            console.log(`(no ${tablePath} - showing built-in defaults; seed it with: ax routing compile)`);
        }
        console.log(`${"id".padEnd(28)}  ${"pattern".padEnd(40)}  ${"suggest".padEnd(8)}  origin`);
        for (const c of merged.classes) {
            console.log(`${c.id.padEnd(28)}  ${c.pattern.padEnd(40)}  ${c.suggest.padEnd(8)}  ${c.origin}`);
        }
        for (const [agentType, model] of Object.entries(merged.agentTypes)) {
            console.log(`${("agent-type:" + agentType).padEnd(28)}  ${"".padEnd(40)}  ${model.padEnd(8)}  default`);
        }
    }),
).pipe(
    Command.withDescription("Print the effective routing table with class origins. --out=PATH  --json"),
);

export const routingRootCommand = Command.make("routing").pipe(
    Command.withDescription(
        "Routing-table operations: tune (mine your dispatch history), compile (regenerate defaults), show.",
    ),
    Command.withSubcommands([tuneCommand, compileCommand, showCommand]),
);

export const axRoutingRuntime: RuntimeManifest = {
    routing: {
        runtime: {
            kind: "db-conditional",
            fallback: "db",
            subcommands: {
                compile: "none",
                show: "none",
            },
        },
        hidden: false,
    },
};
```

Note: `tune` writes the brief with bare `node:fs` sync calls. If the repo's `check:no-node-fs` gate (see memory: allowlist) rejects `node:fs` in `apps/axctl/src/cli/commands/`, switch the brief write to the Effect `FileSystem` service exactly as `saveStoredRoutingTable` does, or add the file to the gate's allowlist - check `scripts/` for the gate script and follow whichever pattern `ax improve accept` (which also writes `.ax/tasks/` briefs) already uses. Mirror that brief-writing pattern; do not invent a new one.

- [ ] **Step 2: Wire into cli/index.ts**

At line 19, alongside the dispatches import:

```typescript
import { routingRootCommand, axRoutingRuntime } from "./commands/ax-routing.ts";
```

In `RUNTIME_BY_COMMAND` (~line 77), next to `...axDispatchesRuntime,`:

```typescript
    ...axRoutingRuntime,
```

In the command list (~line 113), after `dispatchesRootCommand,`:

```typescript
    routingRootCommand,
```

Wire the candidates branch to the file-backed table - in `ax-dispatches.ts` `cmdDispatches` (line 59-60), load the effective table and pass it:

```typescript
import { loadEffectiveRoutingTable } from "../../queries/routing-table-io.ts";
// (add to the existing import block)

        if (input.candidates) {
            const table = yield* loadEffectiveRoutingTable();
            const result = yield* fetchDispatchCandidates({ sinceDays: input.sinceDays, table });
```

This closes the unify: hook, candidates, and tune all match against `~/.ax/hooks/routing-table.json` with the same fail-open fallback to `ROUTING_CLASSES`.

Also update `ax-dispatches.ts` `compileRoutingCommand` description (line 203-207) to mention the new home:

```typescript
        "Write ~/.ax/hooks/routing-table.json from the built-in ROUTING_CLASSES constant, " +
        "preserving origin:user classes (alias of `ax routing compile`). " +
        "--out=PATH overrides default path. " +
        "--skill-md=PATH instead regenerates the ax:routing-table section of a skill markdown. --json",
```

- [ ] **Step 3: Smoke test from source**

```bash
bun run typecheck
./apps/axctl/bin/axctl routing show
./apps/axctl/bin/axctl routing tune --days=30 --dry-run
./apps/axctl/bin/axctl routing tune --days=30 --dry-run --json
./apps/axctl/bin/axctl routing compile --out=/tmp/ax-rt-smoke.json && cat /tmp/ax-rt-smoke.json | head -20
```

Expected: typecheck clean; `show` prints the default table (or the live one); `tune --dry-run` prints real proposals or the "(table is keeping up)" line; compile writes origin-tagged JSON. If `ax routing tune` hangs, suspect the known `enrichSessions`/watcher wedge (memory: sessions-here-hang-modes) - tune only uses `fetchDispatches`, which is flat SQL, so a hang here is a real bug in this change, not the known one.

- [ ] **Step 4: Full gate + commit**

```bash
bun test apps/axctl/src packages/hooks-sdk && bun run typecheck
git add apps/axctl/src/cli/commands/ax-routing.ts apps/axctl/src/cli/index.ts apps/axctl/src/cli/commands/ax-dispatches.ts
git commit -m "feat(cli): ax routing tune|compile|show - user-facing routing-table tuning"
```

---

### Task 8: docs

**Files:**
- Modify: `README.md` ("Route the expensive model where it earns its keep" section, ~line 180)
- Modify: `CLAUDE.md` ("Dispatch routing" section)

- [ ] **Step 1: README** - in the routing section, replace the command block and the workflow sentence:

```markdown
```bash
ax cost split --days=7              # main loop vs subagents, by model
ax dispatches --candidates          # model-less dispatches + est savings
ax routing tune                     # mine YOUR history for new routing classes
ax routing compile                  # regenerate the table (user classes preserved)
ax hooks install ~/.ax/hooks/route-dispatch.ts --providers=claude
```

The `route-dispatch` hook warns when a mechanical dispatch forgets an explicit
model; the `efficient-dispatch` skill (via `npx skills add Necmttn/ax`) teaches
the orchestration pattern; `ax improve recommend` surfaces a proposal when
missed savings accumulate; `ax routing tune` mines new routing classes from
your own dispatch history (judgment work is never auto-routed - vet those via
`--emit-brief`). One source of truth - `~/.ax/hooks/routing-table.json` -
measured end to end. See [docs/design/cost-routing.md](docs/design/cost-routing.md).
```

- [ ] **Step 2: CLAUDE.md** - in "Dispatch routing", update the compile-routing line and add:

```markdown
`ax routing tune [--days=N] [--dry-run] [--emit-brief] [--apply=id,...] [--out=PATH]` - mine unmatched expensive inherit dispatches for new routing classes (two-token prefix clustering, ≥3 members). Auto-applies non-judgment proposals to `~/.ax/hooks/routing-table.json` as `origin: user`; judgment-flagged ones (review/design/plan/audit) only ship via `--emit-brief` → `.ax/tasks/routing-tune-<date>.md` → agent backtest → `--apply=ids`.
`ax routing compile [--out=PATH]` - merge-preserving regenerate (defaults refresh, user classes survive). `ax dispatches compile-routing` is an alias.
`ax routing show` - effective table with origins.
The routing table file is now the source of truth for the hook AND `ax dispatches --candidates` (unify done); ROUTING_CLASSES remains the shipped default seed. The committed `/routing-tune` workflow stays the dev-side tool for tuning the defaults themselves.
```

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs(routing): ax routing tune|compile|show command docs"
```

---

### Task 9: final verification

- [ ] **Step 1: Full repo gates**

```bash
bun test && bun run typecheck && bun run build
```

Expected: all pass. (If a global hook blocks `bun test`, use the tmp wrapper noted in the header.)

- [ ] **Step 2: End-to-end dogfood**

```bash
./apps/axctl/bin/axctl routing compile
./apps/axctl/bin/axctl routing tune --dry-run --days=30
./apps/axctl/bin/axctl routing show
./apps/axctl/bin/axctl dispatches --candidates --days=14 | tail -5
```

Expected: compile seeds/refreshes the live table preserving any user classes; tune surfaces real clusters from the last 30 days (there is known unmatched spend); show displays origins; candidates still works against the file-backed table.

- [ ] **Step 3: Push + PR**

```bash
git push -u origin feat/routing-tune-ship
gh pr create --title "feat(routing): ax routing tune - user-facing routing-table tuning" --body "..."
```

PR body: link the spec, summarize the unify (routing-table.json now source of truth), the deterministic mining + judgment gating, and the alias story. End with the standard generated-with footer.
