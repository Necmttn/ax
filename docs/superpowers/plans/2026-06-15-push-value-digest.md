# Push-Value Digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push a short, ranked, deduped digest of the user's own ax signal into the agent's context at session start, turning passive ingest into a habit loop.

**Architecture:** Compute is split from surface by a snapshot file (`~/.ax/digest.json`), the same seam as the quota cache. A new ingest derive-stage computes + writes the ranked snapshot after every ingest (existing watcher picks it up, no watcher change). A SessionStart hook reads the snapshot, applies dedup against `~/.ax/digest-shown.json`, and injects the top 1-3 unshown items. An `ax digest` CLI renders/refreshes on demand.

**Tech Stack:** Bun, TypeScript (strict), Effect v4 (`effect@beta`), Effect Schema, SurrealDB via `@ax/lib/db`, `@ax/hooks-sdk` for the hook. Tests: `bun:test`.

**Spec:** `docs/superpowers/specs/2026-06-15-push-value-digest-design.md`

---

## File Structure

```
apps/axctl/src/digest/
  model.ts        - DigestItem / DigestSnapshot (Effect Schema) + decode helpers
  model.test.ts
  rank.ts         - pure salience scoring, top-N selection, suppression. No IO.
  rank.test.ts
  shown.ts        - dedup/rotation state read/write (~/.ax/digest-shown.json)
  shown.test.ts
  render.ts       - DigestItem[] → injection/CLI string (pure)
  render.test.ts
  sources.ts      - 4 source adapters: existing query → DigestItem[]
  sources.test.ts
  snapshot.ts     - orchestrate sources → rank → write ~/.ax/digest.json
  digest-stage.ts - co-located StageDef (tag: derive) + registry entry
apps/axctl/src/cli/digest.ts          - `ax digest` command (--json, --refresh)
packages/hooks-sdk/src/hooks/surface-digest.ts       - the SessionStart hook
packages/hooks-sdk/src/hooks/surface-digest.test.ts
```

Reuse, do not reinvent:
- Atomic-write pattern: copy `apps/axctl/src/quota/cache.ts` (`Bun.write` tmp + `mv`; `node:fs` is banned by `check:no-node-fs`).
- StageDef pattern: copy `apps/axctl/src/ingest/derive-opportunities.ts` (bottom "Co-located StageDef" section) + register in `apps/axctl/src/ingest/stage/registry.ts`.
- Existing source queries: `recommend` (`apps/axctl/src/improve/recommend.ts`), dispatch candidates (`apps/axctl/src/queries/dispatch-analytics.ts`), churn (find: `rg -l churn apps/axctl/src/queries`), quota cache (`apps/axctl/src/quota/cache.ts`).
- Hook pattern: copy `packages/hooks-sdk/src/hooks/route-dispatch.ts` + its `.test.ts`.

---

## Task 1: Data model (`model.ts`)

**Files:**
- Create: `apps/axctl/src/digest/model.ts`
- Test: `apps/axctl/src/digest/model.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/axctl/src/digest/model.test.ts
import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { DigestItem, DigestSnapshot, decodeSnapshotOrNull } from "./model.ts";

describe("digest model", () => {
  it("encodes + decodes a DigestItem round-trip", () => {
    const item = DigestItem.make({
      id: "cost:routing",
      kind: "cost",
      salience: 0.74,
      text: "routing could save ~$42/wk (38% inherit)",
      action: "ax dispatches --candidates",
      evidence: undefined,
      computed_at: new Date("2026-06-15T00:00:00Z"),
    });
    const encoded = Schema.encodeSync(DigestItem)(item);
    const decoded = Schema.decodeUnknownSync(DigestItem)(encoded);
    expect(decoded.id).toBe("cost:routing");
    expect(decoded.kind).toBe("cost");
  });

  it("decodeSnapshotOrNull returns null on garbage, snapshot on valid JSON", () => {
    expect(decodeSnapshotOrNull("not json")).toBeNull();
    expect(decodeSnapshotOrNull(JSON.stringify({ nope: true }))).toBeNull();
    const snap = DigestSnapshot.make({
      generated_at: new Date("2026-06-15T00:00:00Z"),
      window_days: 14,
      items: [],
    });
    const text = JSON.stringify(Schema.encodeSync(DigestSnapshot)(snap));
    expect(decodeSnapshotOrNull(text)?.window_days).toBe(14);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/digest/model.test.ts`
Expected: FAIL - `Cannot find module './model.ts'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/axctl/src/digest/model.ts
import { Schema } from "effect";

export const DigestKind = Schema.Literal("improve", "cost", "churn", "quota");
export type DigestKind = typeof DigestKind.Type;

/** One ranked, renderable digest line. `id` is a stable key used for dedup. */
export class DigestItem extends Schema.Class<DigestItem>("DigestItem")({
  id: Schema.String,
  kind: DigestKind,
  salience: Schema.Number,
  text: Schema.String,
  action: Schema.String,
  evidence: Schema.optional(Schema.String),
  computed_at: Schema.Date,
}) {}

/** A point-in-time ranked snapshot; store top-8, surface top-3. */
export class DigestSnapshot extends Schema.Class<DigestSnapshot>("DigestSnapshot")({
  generated_at: Schema.Date,
  window_days: Schema.Number,
  items: Schema.Array(DigestItem),
}) {}

/** Parse persisted snapshot JSON; null on any parse/decode failure (callers
 *  treat null as "no snapshot" and stay silent). */
export const decodeSnapshotOrNull = (text: string): DigestSnapshot | null => {
  try {
    return Schema.decodeUnknownSync(DigestSnapshot)(JSON.parse(text));
  } catch {
    return null;
  }
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/digest/model.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/digest/model.ts apps/axctl/src/digest/model.test.ts
git commit -m "feat(digest): DigestItem/DigestSnapshot schema + decode"
```

---

## Task 2: Ranking (`rank.ts`)

Pure functions: salience scoring, top-N store-selection, and suppression-aware surface-selection. No IO. This is the brain - test it hard.

**Files:**
- Create: `apps/axctl/src/digest/rank.ts`
- Test: `apps/axctl/src/digest/rank.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/axctl/src/digest/rank.test.ts
import { describe, expect, it } from "bun:test";
import { DigestItem } from "./model.ts";
import { BASE_WEIGHT, salience, topForSnapshot, pickUnshown } from "./rank.ts";

const mk = (over: Partial<{ id: string; kind: DigestItem["kind"]; urgency: number; ageHours: number }>) => {
  const kind = over.kind ?? "cost";
  return {
    id: over.id ?? `${kind}:x`,
    kind,
    urgency: over.urgency ?? 1,
    ageHours: over.ageHours ?? 0,
    text: "t",
    action: "a",
    evidence: undefined as string | undefined,
  };
};

describe("salience", () => {
  it("multiplies base[kind] x urgency x recency, recency decays with age", () => {
    const fresh = salience(mk({ kind: "churn", urgency: 2, ageHours: 0 }));
    const old = salience(mk({ kind: "churn", urgency: 2, ageHours: 168 }));
    expect(fresh).toBeCloseTo(BASE_WEIGHT.churn * 2 * 1, 5);
    expect(old).toBeLessThan(fresh);
  });

  it("churn outranks quota at equal urgency + age", () => {
    expect(salience(mk({ kind: "churn" }))).toBeGreaterThan(salience(mk({ kind: "quota" })));
  });
});

describe("topForSnapshot", () => {
  it("sorts by salience desc and caps at 8", () => {
    const items = Array.from({ length: 12 }, (_, i) =>
      mk({ id: `cost:${i}`, urgency: i }),
    );
    const top = topForSnapshot(items, 8);
    expect(top).toHaveLength(8);
    expect(top[0].id).toBe("cost:11");
    expect(top.at(-1)!.id).toBe("cost:4");
  });
});

describe("pickUnshown", () => {
  const now = new Date("2026-06-15T12:00:00Z");
  const item = (id: string, sal: number): DigestItem =>
    DigestItem.make({ id, kind: "cost", salience: sal, text: "t", action: "a", computed_at: now });

  it("returns top-3 ranked when nothing is suppressed", () => {
    const snap = [item("a", 3), item("b", 2), item("c", 1), item("d", 0.5)];
    const picked = pickUnshown(snap, {}, now, 3);
    expect(picked.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("suppresses items shown within 6h", () => {
    const snap = [item("a", 3), item("b", 2)];
    const shown = { a: { last_shown_at: new Date("2026-06-15T09:00:00Z").toISOString(), shown_count: 1 } };
    expect(pickUnshown(snap, shown, now, 3).map((p) => p.id)).toEqual(["b"]);
  });

  it("suppresses items with shown_count >= 3", () => {
    const snap = [item("a", 3), item("b", 2)];
    const shown = { a: { last_shown_at: "2026-06-01T00:00:00Z", shown_count: 3 } };
    expect(pickUnshown(snap, shown, now, 3).map((p) => p.id)).toEqual(["b"]);
  });

  it("quiet day: all suppressed → empty array", () => {
    const snap = [item("a", 3)];
    const shown = { a: { last_shown_at: new Date("2026-06-15T11:00:00Z").toISOString(), shown_count: 1 } };
    expect(pickUnshown(snap, shown, now, 3)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/digest/rank.test.ts`
Expected: FAIL - `Cannot find module './rank.ts'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/axctl/src/digest/rank.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/digest/rank.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/digest/rank.ts apps/axctl/src/digest/rank.test.ts
git commit -m "feat(digest): salience ranking + suppression-aware selection"
```

---

## Task 3: Shown-state (`shown.ts`)

Read/write the dedup state file with an atomic write, prune resolved ids.

**Files:**
- Create: `apps/axctl/src/digest/shown.ts`
- Test: `apps/axctl/src/digest/shown.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/axctl/src/digest/shown.test.ts
import { describe, expect, it } from "bun:test";
import { recordShown, pruneResolved, type ShownState } from "./shown.ts";

describe("recordShown", () => {
  const now = new Date("2026-06-15T12:00:00Z");
  it("inserts new ids with count 1", () => {
    const next = recordShown({}, ["a", "b"], now);
    expect(next.a.shown_count).toBe(1);
    expect(next.a.last_shown_at).toBe(now.toISOString());
    expect(next.b.shown_count).toBe(1);
  });
  it("increments existing ids and bumps last_shown_at", () => {
    const prev: ShownState = { a: { last_shown_at: "2026-06-01T00:00:00Z", shown_count: 1 } };
    const next = recordShown(prev, ["a"], now);
    expect(next.a.shown_count).toBe(2);
    expect(next.a.last_shown_at).toBe(now.toISOString());
  });
});

describe("pruneResolved", () => {
  it("drops shown ids not present in the live id set", () => {
    const prev: ShownState = {
      a: { last_shown_at: "x", shown_count: 1 },
      gone: { last_shown_at: "x", shown_count: 2 },
    };
    const next = pruneResolved(prev, new Set(["a"]));
    expect(Object.keys(next)).toEqual(["a"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/digest/shown.test.ts`
Expected: FAIL - `Cannot find module './shown.ts'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/axctl/src/digest/shown.ts
import { decodeJsonOrNull } from "@ax/lib/decode";

export interface ShownRecord {
  readonly last_shown_at: string; // ISO
  readonly shown_count: number;
}
export type ShownState = Record<string, ShownRecord>;

export const defaultShownPath = (): string => `${process.env.HOME}/.ax/digest-shown.json`;

/** Read shown-state; never throws - corruption degrades to empty state. */
export async function loadShown(path: string): Promise<ShownState> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return {};
    const parsed = decodeJsonOrNull(await file.text());
    return parsed && typeof parsed === "object" ? (parsed as ShownState) : {};
  } catch {
    return {};
  }
}

/** Atomic write (tmp + mv), mirrors quota/cache.ts. node:fs is CI-banned. */
export async function saveShown(path: string, state: ShownState): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await Bun.write(tmp, `${JSON.stringify(state, null, 2)}\n`, { createPath: true });
  const result = Bun.spawnSync(["mv", tmp, path]);
  if (result.exitCode !== 0) {
    Bun.spawnSync(["rm", "-f", tmp]);
    throw new Error(`saveShown: mv failed (exit ${result.exitCode})`);
  }
}

export const recordShown = (prev: ShownState, ids: ReadonlyArray<string>, now: Date): ShownState => {
  const next: ShownState = { ...prev };
  for (const id of ids) {
    const existing = next[id];
    next[id] = {
      last_shown_at: now.toISOString(),
      shown_count: (existing?.shown_count ?? 0) + 1,
    };
  }
  return next;
};

/** Drop shown-state for ids no longer in the snapshot (resolved signals). */
export const pruneResolved = (prev: ShownState, liveIds: ReadonlySet<string>): ShownState => {
  const next: ShownState = {};
  for (const [id, rec] of Object.entries(prev)) if (liveIds.has(id)) next[id] = rec;
  return next;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/digest/shown.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/digest/shown.ts apps/axctl/src/digest/shown.test.ts
git commit -m "feat(digest): shown-state read/write + prune-resolved"
```

---

## Task 4: Render (`render.ts`)

**Files:**
- Create: `apps/axctl/src/digest/render.ts`
- Test: `apps/axctl/src/digest/render.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/axctl/src/digest/render.test.ts
import { describe, expect, it } from "bun:test";
import { DigestItem } from "./model.ts";
import { renderDigest } from "./render.ts";

const item = (text: string, action: string): DigestItem =>
  DigestItem.make({ id: text, kind: "cost", salience: 1, text, action, computed_at: new Date(0) });

describe("renderDigest", () => {
  it("returns empty string for no items (no bare header)", () => {
    expect(renderDigest([])).toBe("");
  });
  it("renders a header, one bullet per item with action arrow, and a footer", () => {
    const out = renderDigest([item("routing could save ~$42/wk", "ax dispatches --candidates")]);
    expect(out).toContain("[ax] since last session:");
    expect(out).toContain("• routing could save ~$42/wk → ax dispatches --candidates");
    expect(out).toContain("run `ax` for the full board.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/digest/render.test.ts`
Expected: FAIL - `Cannot find module './render.ts'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/axctl/src/digest/render.ts
import type { DigestItem } from "./model.ts";

/** One-line-per-item digest block. Empty string when no items (callers must
 *  emit nothing rather than a bare header). Shared by the hook and the CLI. */
export const renderDigest = (items: ReadonlyArray<DigestItem>): string => {
  if (items.length === 0) return "";
  const lines = items.map((it) => `  • ${it.text} → ${it.action}`);
  return ["[ax] since last session:", ...lines, "run `ax` for the full board."].join("\n");
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/digest/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/digest/render.ts apps/axctl/src/digest/render.test.ts
git commit -m "feat(digest): render digest block (shared hook + CLI)"
```

---

## Task 5: Sources (`sources.ts`)

Four adapters turning existing queries into `DigestItem[]`. Each is small: run the existing query, map the top row(s) to a `DigestItem` with `id`, `text`, `action`, and a pre-computed `salience` (via `rank.salience`). Sources never throw past a `DbError`; an empty result = `[]`.

Before writing, confirm the existing query fns + their return shapes:
```bash
rg -n "export const recommend" apps/axctl/src/improve/recommend.ts
rg -n "export (const|function)" apps/axctl/src/queries/dispatch-analytics.ts | head
rg -l churn apps/axctl/src/queries          # locate the churn query module
rg -n "export (const|function)" $(rg -l churn apps/axctl/src/queries | head -1) | head
sed -n '1,40p' apps/axctl/src/quota/cache.ts
```

**Files:**
- Create: `apps/axctl/src/digest/sources.ts`
- Test: `apps/axctl/src/digest/sources.test.ts`

- [ ] **Step 1: Write the failing test**

The four source fns are thin mappers; test the mapping logic with hand-built query rows (no live DB) by exporting pure `toItem` mappers alongside the Effect wrappers.

```typescript
// apps/axctl/src/digest/sources.test.ts
import { describe, expect, it } from "bun:test";
import { improveToItem, costToItem, churnToItem, quotaToItem } from "./sources.ts";

describe("source mappers", () => {
  const now = new Date("2026-06-15T12:00:00Z");

  it("improveToItem maps open-proposal count to an improve item", () => {
    const item = improveToItem(4, now);
    expect(item?.kind).toBe("improve");
    expect(item?.id).toBe("improve:open");
    expect(item?.action).toBe("ax improve recommend");
    expect(item?.text).toContain("4");
  });
  it("improveToItem returns null when zero proposals", () => {
    expect(improveToItem(0, now)).toBeNull();
  });

  it("costToItem maps weekly savings to a cost item", () => {
    const item = costToItem({ savingsPerWeekUsd: 42, inheritPct: 38 }, now);
    expect(item?.kind).toBe("cost");
    expect(item?.action).toBe("ax dispatches --candidates");
    expect(item?.text).toContain("42");
  });
  it("costToItem returns null below a $5/wk floor (not worth surfacing)", () => {
    expect(costToItem({ savingsPerWeekUsd: 3, inheritPct: 10 }, now)).toBeNull();
  });

  it("churnToItem maps repair-loop session to a churn item", () => {
    const item = churnToItem({ sessionId: "s1", repairLoc: 14, failedChecks: 1, topFile: "auth.ts" }, now);
    expect(item?.kind).toBe("churn");
    expect(item?.action).toBe("ax sessions churn --here");
    expect(item?.text).toContain("auth.ts");
  });
  it("churnToItem returns null when no repair LOC", () => {
    expect(churnToItem({ sessionId: "s1", repairLoc: 0, failedChecks: 0, topFile: null }, now)).toBeNull();
  });

  it("quotaToItem surfaces only above 70% window burn", () => {
    expect(quotaToItem({ windowLabel: "7d", pctUsed: 41 }, now)).toBeNull();
    const hot = quotaToItem({ windowLabel: "7d", pctUsed: 82 }, now);
    expect(hot?.kind).toBe("quota");
    expect(hot?.action).toBe("ax quota");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/digest/sources.test.ts`
Expected: FAIL - `Cannot find module './sources.ts'`.

- [ ] **Step 3: Write minimal implementation**

Pure mappers + Effect wrappers. The Effect wrappers call the existing queries confirmed in Step 0 and feed their results to the mappers; the mappers carry all branch logic so they're unit-testable without a DB.

```typescript
// apps/axctl/src/digest/sources.ts
import { Effect } from "effect";
import type { DbError } from "@ax/lib/errors";
import { SurrealClient } from "@ax/lib/db";
import { DigestItem } from "./model.ts";
import { salience } from "./rank.ts";
import { recommend } from "../improve/recommend.ts";

const COST_FLOOR_USD = 5;
const QUOTA_HOT_PCT = 70;

// ---- pure mappers (unit-tested) ----

export const improveToItem = (openCount: number, now: Date): DigestItem | null => {
  if (openCount <= 0) return null;
  return DigestItem.make({
    id: "improve:open",
    kind: "improve",
    salience: salience({ kind: "improve", urgency: openCount, ageHours: 0 }),
    text: `${openCount} improve proposal${openCount === 1 ? "" : "s"} pending`,
    action: "ax improve recommend",
    computed_at: now,
  });
};

export const costToItem = (
  input: { savingsPerWeekUsd: number; inheritPct: number },
  now: Date,
): DigestItem | null => {
  if (input.savingsPerWeekUsd < COST_FLOOR_USD) return null;
  return DigestItem.make({
    id: "cost:routing",
    kind: "cost",
    salience: salience({ kind: "cost", urgency: input.savingsPerWeekUsd, ageHours: 0 }),
    text: `routing could save ~$${Math.round(input.savingsPerWeekUsd)}/wk (${Math.round(input.inheritPct)}% inherit)`,
    action: "ax dispatches --candidates",
    computed_at: now,
  });
};

export const churnToItem = (
  input: { sessionId: string; repairLoc: number; failedChecks: number; topFile: string | null },
  now: Date,
): DigestItem | null => {
  if (input.repairLoc <= 0) return null;
  const where = input.topFile ? ` in ${input.topFile}` : "";
  return DigestItem.make({
    id: `churn:${input.sessionId}`,
    kind: "churn",
    salience: salience({ kind: "churn", urgency: input.repairLoc + input.failedChecks * 5, ageHours: 0 }),
    text: `repair-loop${where} (${input.repairLoc} LOC churned, ${input.failedChecks} failed check${input.failedChecks === 1 ? "" : "s"})`,
    action: "ax sessions churn --here",
    evidence: input.sessionId,
    computed_at: now,
  });
};

export const quotaToItem = (
  input: { windowLabel: string; pctUsed: number },
  now: Date,
): DigestItem | null => {
  if (input.pctUsed <= QUOTA_HOT_PCT) return null;
  return DigestItem.make({
    id: `quota:${input.windowLabel}`,
    kind: "quota",
    salience: salience({ kind: "quota", urgency: input.pctUsed / 100, ageHours: 0 }),
    text: `${Math.round(input.pctUsed)}% of your ${input.windowLabel} quota window used`,
    action: "ax quota",
    computed_at: now,
  });
};

// ---- Effect wrappers (call existing queries, feed the mappers) ----
// NOTE for implementer: wire each wrapper to the query confirmed in Step 0.
// recommend() is confirmed: Effect<RecommendItem[], DbError, SurrealClient>.
// dispatch candidates / churn: adapt the fn backing `ax dispatches --candidates`
// and `ax sessions churn`; quota: read the on-disk cache (quota/cache.ts) -
// no DB, so handle it in snapshot.ts rather than here.

export const improveItems = (
  now: Date,
): Effect.Effect<DigestItem[], DbError, SurrealClient> =>
  Effect.gen(function* () {
    const proposals = yield* recommend({});
    const item = improveToItem(proposals.length, now);
    return item ? [item] : [];
  });
```

> Implementer: add `costItems` and `churnItems` Effect wrappers in the same
> shape - call the confirmed query fn, map the top row through `costToItem` /
> `churnToItem`, return `[]` when null. Keep all branch logic in the mappers
> (already tested). `quotaItems` reads the quota cache file and is assembled in
> `snapshot.ts` (Task 6) because it is not a DB query.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/digest/sources.test.ts`
Expected: PASS (mapper tests; Effect wrappers covered in Task 6 snapshot test).

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/digest/sources.ts apps/axctl/src/digest/sources.test.ts
git commit -m "feat(digest): source mappers (improve/cost/churn/quota) + improve wrapper"
```

---

## Task 6: Snapshot writer + ingest stage (`snapshot.ts`, `digest-stage.ts`)

Orchestrate sources → rank top-8 → write `~/.ax/digest.json` atomically; expose it as a `derive`-tagged StageDef and register it.

**Files:**
- Create: `apps/axctl/src/digest/snapshot.ts`
- Create: `apps/axctl/src/digest/digest-stage.ts`
- Modify: `apps/axctl/src/ingest/stage/registry.ts` (add import + 2 entries)
- Test: `apps/axctl/src/digest/snapshot.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/axctl/src/digest/snapshot.test.ts
import { describe, expect, it } from "bun:test";
import { DigestItem } from "./model.ts";
import { assembleSnapshot } from "./snapshot.ts";

describe("assembleSnapshot", () => {
  const now = new Date("2026-06-15T12:00:00Z");
  const mk = (id: string, kind: DigestItem["kind"], sal: number): DigestItem =>
    DigestItem.make({ id, kind, salience: sal, text: id, action: "a", computed_at: now });

  it("merges all source items, ranks, caps at 8, stamps window + generated_at", () => {
    const items = Array.from({ length: 10 }, (_, i) => mk(`cost:${i}`, "cost", i));
    const snap = assembleSnapshot(items, { now, windowDays: 14 });
    expect(snap.items).toHaveLength(8);
    expect(snap.items[0].id).toBe("cost:9");
    expect(snap.window_days).toBe(14);
    expect(snap.generated_at).toEqual(now);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/digest/snapshot.test.ts`
Expected: FAIL - `Cannot find module './snapshot.ts'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/axctl/src/digest/snapshot.ts
import { Effect, Schema } from "effect";
import type { DbError } from "@ax/lib/errors";
import { SurrealClient } from "@ax/lib/db";
import { DigestSnapshot, type DigestItem } from "./model.ts";
import { topForSnapshot } from "./rank.ts";
import { improveItems } from "./sources.ts";
import { loadQuotaCache, defaultQuotaCachePath } from "../quota/cache.ts";
import { quotaToItem } from "./sources.ts";

export const defaultDigestPath = (): string => `${process.env.HOME}/.ax/digest.json`;

/** Pure: rank + cap + stamp. Unit-tested without IO. */
export const assembleSnapshot = (
  items: ReadonlyArray<DigestItem>,
  opts: { now: Date; windowDays: number },
): DigestSnapshot =>
  DigestSnapshot.make({
    generated_at: opts.now,
    window_days: opts.windowDays,
    items: topForSnapshot(items, 8),
  });

/** Collect items from every source (DB sources via Effect; quota via cache). */
export const collectItems = (
  now: Date,
): Effect.Effect<DigestItem[], DbError, SurrealClient> =>
  Effect.gen(function* () {
    const out: DigestItem[] = [];
    out.push(...(yield* improveItems(now)));
    // out.push(...(yield* costItems(now)));   // implementer: add when wired
    // out.push(...(yield* churnItems(now)));  // implementer: add when wired
    const quota = yield* Effect.promise(() => loadQuotaCache(defaultQuotaCachePath()));
    if (quota) {
      // implementer: map the 7d window pct from the QuotaSnapshot shape.
      const q = quotaToItem({ windowLabel: "7d", pctUsed: quota.seven_day?.utilization ?? 0 }, now);
      if (q) out.push(q);
    }
    return out;
  });

/** Atomic write (tmp + mv); mirrors quota/cache.ts. */
export async function writeSnapshot(path: string, snap: DigestSnapshot): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  const json = JSON.stringify(Schema.encodeSync(DigestSnapshot)(snap), null, 2);
  await Bun.write(tmp, `${json}\n`, { createPath: true });
  const result = Bun.spawnSync(["mv", tmp, path]);
  if (result.exitCode !== 0) {
    Bun.spawnSync(["rm", "-f", tmp]);
    throw new Error(`writeSnapshot: mv failed (exit ${result.exitCode})`);
  }
}

/** Build + persist the snapshot for the given window. */
export const buildAndWrite = (
  now: Date,
  windowDays: number,
): Effect.Effect<DigestSnapshot, DbError, SurrealClient> =>
  Effect.gen(function* () {
    const items = yield* collectItems(now);
    const snap = assembleSnapshot(items, { now, windowDays });
    yield* Effect.promise(() => writeSnapshot(defaultDigestPath(), snap));
    return snap;
  });
```

> Implementer: confirm the `QuotaSnapshot` field for 7d utilization in
> `apps/axctl/src/quota/schema.ts` and fix the `quota.seven_day?.utilization`
> access to the real shape. Add `costItems` / `churnItems` to `collectItems`
> once their wrappers exist (Task 5 note).

```typescript
// apps/axctl/src/digest/digest-stage.ts
import { Effect, Schema } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { BaseStageStats, IngestContext, StageMeta } from "../ingest/stage/types.ts";
import type { StageDef } from "../ingest/stage/registry.ts";
import { buildAndWrite } from "./snapshot.ts";

export const DigestKey = Schema.Literal("digest");
export type DigestKey = typeof DigestKey.Type;

export class DigestStats extends BaseStageStats.extend<DigestStats>("DigestStats")({
  items: Schema.Number,
}) {}

/** Derive-tagged: runs last, computes + writes ~/.ax/digest.json. A failure
 *  here is logged by the runner and never affects the ingest that preceded it. */
export const digestStage: StageDef<DigestStats, SurrealClient> = {
  meta: StageMeta.make({ key: "digest", deps: ["proposals", "derive-metrics"], tags: ["derive"] }),
  run: (_ctx: IngestContext) =>
    Effect.gen(function* () {
      const t0 = Date.now();
      const snap = yield* buildAndWrite(new Date(), 14);
      return DigestStats.make({
        durationMs: Date.now() - t0,
        summary: `wrote digest with ${snap.items.length} items`,
        items: snap.items.length,
      });
    }),
};
```

- [ ] **Step 4: Register the stage**

Edit `apps/axctl/src/ingest/stage/registry.ts`:
1. Add import near the other stage imports (line ~30):
   ```typescript
   import { DigestKey, digestStage } from "../../digest/digest-stage.ts";
   ```
2. Add `DigestKey` to the `IngestStageKey` union (line ~37, end of the `Schema.Union([...])` list).
3. Add `digestStage` to the end of `ALL_STAGES` (line ~61).

- [ ] **Step 5: Run tests + typecheck + verify stage registered**

Run: `bun test apps/axctl/src/digest/snapshot.test.ts`
Expected: PASS.
Run: `bun run typecheck`
Expected: no errors.
Run: `ax ingest --stages=digest --dry-run --json` (from repo root)
Expected: JSON lists the `digest` stage (proves registry wiring; dry-run does not execute).

- [ ] **Step 6: Commit**

```bash
git add apps/axctl/src/digest/snapshot.ts apps/axctl/src/digest/digest-stage.ts apps/axctl/src/digest/snapshot.test.ts apps/axctl/src/ingest/stage/registry.ts
git commit -m "feat(digest): snapshot writer + derive stage, registered in StageRegistry"
```

---

## Task 7: SessionStart hook (`surface-digest.ts`)

Read snapshot + shown-state, freshness-guard, pick top-3 unshown, inject, record shown.

**Files:**
- Create: `packages/hooks-sdk/src/hooks/surface-digest.ts`
- Test: `packages/hooks-sdk/src/hooks/surface-digest.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/hooks-sdk/src/hooks/surface-digest.test.ts
import { describe, expect, it } from "bun:test";
import { decideDigestVerdict } from "./surface-digest.ts";
import { Verdict } from "../verdict.ts";

const item = (id: string, sal: number) => ({
  id, kind: "cost" as const, salience: sal, text: id, action: "a", computed_at: new Date(0).toISOString(),
});

describe("decideDigestVerdict", () => {
  const now = new Date("2026-06-15T12:00:00Z");

  it("injects rendered top-3 when snapshot is fresh and items unshown", () => {
    const snap = { generated_at: now.toISOString(), window_days: 14, items: [item("a", 3)] };
    const v = decideDigestVerdict(snap, {}, now, 24);
    expect(v.verdict._tag).toBe("Inject");
    expect(v.verdict._tag === "Inject" && v.verdict.context).toContain("[ax]");
    expect(v.shownIds).toEqual(["a"]);
  });

  it("allows (silent) when snapshot is null", () => {
    expect(decideDigestVerdict(null, {}, now, 24).verdict).toEqual(Verdict.allow);
  });

  it("allows (silent) when snapshot is stale beyond max-age hours", () => {
    const stale = { generated_at: new Date("2026-06-13T00:00:00Z").toISOString(), window_days: 14, items: [item("a", 3)] };
    expect(decideDigestVerdict(stale, {}, now, 24).verdict).toEqual(Verdict.allow);
  });

  it("allows (silent) when all items suppressed", () => {
    const snap = { generated_at: now.toISOString(), window_days: 14, items: [item("a", 3)] };
    const shown = { a: { last_shown_at: new Date("2026-06-15T11:00:00Z").toISOString(), shown_count: 1 } };
    expect(decideDigestVerdict(snap, shown, now, 24).verdict).toEqual(Verdict.allow);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/hooks-sdk/src/hooks/surface-digest.test.ts`
Expected: FAIL - `Cannot find module './surface-digest.ts'`.

- [ ] **Step 3: Write minimal implementation**

The hook keeps decision logic in a pure `decideDigestVerdict` (unit-tested), and the `defineHook` `run` does the IO around it. Note: `apps/axctl` is not importable from `packages/hooks-sdk`, so the hook re-derives the tiny bits it needs (snapshot shape, rank suppression, render) by importing from `@ax/lib`-level shared code OR by duplicating the 3 pure fns. To avoid a cross-package dep cycle, copy `pickUnshown` + `renderDigest` + the snapshot decode into a shared module under `packages/lib/src/digest-shared.ts` and import from both sides.

First, create the shared pure module:

```typescript
// packages/lib/src/digest-shared.ts
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
export interface ShownRecord { last_shown_at: string; shown_count: number; }
export type ShownState = Record<string, ShownRecord>;

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

export const isSnapshotFresh = (snap: DigestSnapshotJson, now: Date, maxAgeHours: number): boolean => {
  const genMs = Date.parse(snap.generated_at);
  if (!Number.isFinite(genMs)) return false;
  return now.getTime() - genMs < maxAgeHours * 3600_000;
};
```

> Implementer: refactor Task 4's `render.ts` and Task 2's `pickUnshown` to
> re-export from this shared module (DRY) so there is a single source of the
> 6h window + render format. Update the imports in `render.ts` / `rank.ts`
> accordingly and re-run their tests.

Now the hook:

```typescript
// packages/hooks-sdk/src/hooks/surface-digest.ts
import { Effect } from "effect";
import { defineHook } from "../define.ts";
import { Verdict } from "../verdict.ts";
import {
  type DigestSnapshotJson, type ShownState,
  pickUnshownJson, renderDigestJson, isSnapshotFresh,
} from "@ax/lib/digest-shared";

const DIGEST_PATH = () => `${process.env.HOME}/.ax/digest.json`;
const SHOWN_PATH = () => `${process.env.HOME}/.ax/digest-shown.json`;
const MAX_AGE_HOURS = 24;

/** Pure decision: returns the verdict + which ids were shown (for recording).
 *  Stale/empty/suppressed → Allow (silent). Unit-tested. */
export const decideDigestVerdict = (
  snap: DigestSnapshotJson | null,
  shown: ShownState,
  now: Date,
  maxAgeHours: number,
): { verdict: Verdict; shownIds: string[] } => {
  if (!snap || !isSnapshotFresh(snap, now, maxAgeHours)) return { verdict: Verdict.allow, shownIds: [] };
  const picked = pickUnshownJson(snap.items, shown, now, 3);
  const text = renderDigestJson(picked);
  if (!text) return { verdict: Verdict.allow, shownIds: [] };
  return { verdict: Verdict.inject(text), shownIds: picked.map((p) => p.id) };
};

const readJson = async <T>(path: string): Promise<T | null> => {
  try {
    const f = Bun.file(path);
    if (!(await f.exists())) return null;
    return JSON.parse(await f.text()) as T;
  } catch { return null; }
};

const recordShownIds = async (path: string, ids: string[], now: Date): Promise<void> => {
  if (ids.length === 0) return;
  const prev = (await readJson<ShownState>(path)) ?? {};
  const next: ShownState = { ...prev };
  for (const id of ids) next[id] = { last_shown_at: now.toISOString(), shown_count: (prev[id]?.shown_count ?? 0) + 1 };
  try {
    const tmp = `${path}.${process.pid}.tmp`;
    await Bun.write(tmp, `${JSON.stringify(next, null, 2)}\n`, { createPath: true });
    Bun.spawnSync(["mv", tmp, path]);
  } catch { /* degrade to no-dedup; never crash the hook */ }
};

export default defineHook({
  name: "surface-digest",
  events: ["SessionStart"],
  run: (_event) =>
    Effect.gen(function* () {
      const now = new Date();
      const snap = yield* Effect.promise(() => readJson<DigestSnapshotJson>(DIGEST_PATH()));
      const shown = (yield* Effect.promise(() => readJson<ShownState>(SHOWN_PATH()))) ?? {};
      const { verdict, shownIds } = decideDigestVerdict(snap, shown, now, MAX_AGE_HOURS);
      yield* Effect.promise(() => recordShownIds(SHOWN_PATH(), shownIds, now));
      return verdict;
    }),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/hooks-sdk/src/hooks/surface-digest.test.ts`
Expected: PASS (4 cases).
Run: `bun test packages/lib` (covers digest-shared if a test exists) and re-run Tasks 2+4 tests after the DRY refactor:
Run: `bun test apps/axctl/src/digest/rank.test.ts apps/axctl/src/digest/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck both packages**

Run: `bun run typecheck`
Expected: no errors. (Confirms `@ax/lib/digest-shared` resolves from both `apps/axctl` and `packages/hooks-sdk`; if the export map needs an entry, add `"./digest-shared": "./src/digest-shared.ts"` to `packages/lib/package.json` `exports`.)

- [ ] **Step 6: Commit**

```bash
git add packages/lib/src/digest-shared.ts packages/lib/package.json packages/hooks-sdk/src/hooks/surface-digest.ts packages/hooks-sdk/src/hooks/surface-digest.test.ts apps/axctl/src/digest/rank.ts apps/axctl/src/digest/render.ts
git commit -m "feat(digest): SessionStart surface-digest hook + shared pure selection/render"
```

---

## Task 8: `ax digest` CLI command

`ax digest` renders the current snapshot; `--json` prints raw; `--refresh` recomputes first.

**Files:**
- Create: `apps/axctl/src/cli/digest.ts`
- Modify: the CLI command registry (find: `rg -n "quota" apps/axctl/src/cli/index.ts` to see how `ax quota` is wired, mirror it)
- Test: `apps/axctl/src/cli/digest.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/axctl/src/cli/digest.test.ts
import { describe, expect, it } from "bun:test";
import { DigestSnapshot, DigestItem } from "../digest/model.ts";
import { renderDigestCli } from "./digest.ts";

describe("renderDigestCli", () => {
  it("renders all stored items (not just top-3) with an empty-state line", () => {
    const empty = DigestSnapshot.make({ generated_at: new Date(0), window_days: 14, items: [] });
    expect(renderDigestCli(empty)).toContain("nothing to surface");
    const snap = DigestSnapshot.make({
      generated_at: new Date(0), window_days: 14,
      items: [DigestItem.make({ id: "cost:routing", kind: "cost", salience: 1, text: "routing save $42/wk", action: "ax dispatches --candidates", computed_at: new Date(0) })],
    });
    const out = renderDigestCli(snap);
    expect(out).toContain("routing save $42/wk");
    expect(out).toContain("ax dispatches --candidates");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/cli/digest.test.ts`
Expected: FAIL - `Cannot find module './digest.ts'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/axctl/src/cli/digest.ts
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { DigestSnapshot } from "../digest/model.ts";
import { defaultDigestPath, buildAndWrite } from "../digest/snapshot.ts";
import { decodeSnapshotOrNull } from "../digest/model.ts";

/** Full-board CLI render (all stored items, not the hook's top-3). */
export const renderDigestCli = (snap: DigestSnapshot): string => {
  if (snap.items.length === 0) return "[ax] nothing to surface right now.";
  const lines = snap.items.map((it) => `  • ${it.text}\n      → ${it.action}`);
  return [`[ax] your board (${snap.window_days}d window):`, ...lines].join("\n");
};

export const runDigest = (opts: { json: boolean; refresh: boolean }): Effect.Effect<string, unknown, SurrealClient> =>
  Effect.gen(function* () {
    let snap: DigestSnapshot | null;
    if (opts.refresh) {
      snap = yield* buildAndWrite(new Date(), 14);
    } else {
      const text = yield* Effect.promise(async () => {
        const f = Bun.file(defaultDigestPath());
        return (await f.exists()) ? await f.text() : null;
      });
      snap = text ? decodeSnapshotOrNull(text) : null;
    }
    if (!snap) return opts.json ? "null" : "[ax] no snapshot yet - run `ax digest --refresh` or ingest first.";
    return opts.json ? JSON.stringify(snap, null, 2) : renderDigestCli(snap);
  });
```

- [ ] **Step 4: Wire into the CLI registry**

Run `rg -n "quota" apps/axctl/src/cli/index.ts` to find the `ax quota` registration, then add a sibling `digest` subcommand with two boolean flags (`--json`, `--refresh`) that calls `runDigest`, provides the app DB layer, and prints the returned string. Follow the exact `Command`/`withIngest`-free pattern used by `quota` (quota has DB runtime "none"; digest needs the DB layer for `--refresh`, so mirror a DB-backed read command like `ax cost models` for layer provision).

- [ ] **Step 5: Run test + manual smoke**

Run: `bun test apps/axctl/src/cli/digest.test.ts`
Expected: PASS.
Run: `bun run apps/axctl/src/cli/index.ts digest --refresh` (DB must be up)
Expected: prints the board or the empty-state line; writes `~/.ax/digest.json`.
Run: `bun run apps/axctl/src/cli/index.ts digest --json`
Expected: prints the snapshot JSON.

- [ ] **Step 6: Commit**

```bash
git add apps/axctl/src/cli/digest.ts apps/axctl/src/cli/digest.test.ts apps/axctl/src/cli/index.ts
git commit -m "feat(digest): ax digest CLI (--json, --refresh)"
```

---

## Task 9: Install the hook + end-to-end verification

- [ ] **Step 1: Install the SessionStart hook**

Run: `ax hooks install $(pwd)/packages/hooks-sdk/src/hooks/surface-digest.ts --providers=claude,codex`
Expected: writes the hook entry into `~/.claude/settings.json` SessionStart (and codex config). Verify: `jq '.hooks.SessionStart' ~/.claude/settings.json` shows the surface-digest fire path.

- [ ] **Step 2: Seed a snapshot + fire the hook**

Run: `bun run apps/axctl/src/cli/index.ts digest --refresh`
Then simulate a SessionStart event:
```bash
echo '{"hook_event_name":"SessionStart","cwd":"'$(pwd)'"}' | bun packages/hooks-sdk/src/hooks/surface-digest.ts
```
Expected: prints the `[ax] since last session:` block to stdout (or nothing if everything is suppressed/below thresholds). Run it twice - second run within 6h should print nothing for already-shown items (dedup works).

- [ ] **Step 3: Verify shown-state recorded**

Run: `jq . ~/.ax/digest-shown.json`
Expected: one record per surfaced id with `shown_count` and `last_shown_at`.

- [ ] **Step 4: Full repo gates**

Run: `bun test` (repo-wide)
Expected: all pass.
Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit any fixups + update spec status**

Tick the spec checklist in `docs/superpowers/specs/2026-06-15-push-value-digest-design.md` and commit.

```bash
git add -A
git commit -m "chore(digest): install SessionStart hook + e2e verification"
```

---

## Self-Review Notes

- **Spec coverage:** model (T1), ranking+suppression (T2), shown-state (T3), render (T4), 4 sources (T5), snapshot+derive-stage wiring (T6), SessionStart hook+inject+freshness guard (T7), `ax digest` CLI (T8), install+e2e (T9). All spec sections mapped.
- **Cross-package constraint:** `packages/hooks-sdk` cannot import `apps/axctl`; resolved by `packages/lib/src/digest-shared.ts` (pure, Effect/DB-free) imported by both, with axctl's `rank.ts`/`render.ts` re-exporting from it for DRY (T7 Step 3).
- **Known implementer follow-ups (explicitly flagged, not placeholders):** wire `costItems`/`churnItems` Effect wrappers to the confirmed query fns (T5); confirm the `QuotaSnapshot` 7d-utilization field name (T6); mirror the exact CLI registration pattern (T8 Step 4). Each names the file + the `rg` command to resolve it.
