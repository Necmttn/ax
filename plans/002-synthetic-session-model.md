# 002 - Stop one `<synthetic>` message from relabelling a whole session's model

- **Written against commit:** `d70e1b3e` (branch `fix/751-pricing-claude-opus-5-unpriced-the`)
- **Status:** TODO
- **Depends on:** nothing
- **Blocks:** nothing

## Why this matters

Claude Code emits assistant entries whose `message.model` is the literal string
`"<synthetic>"` - messages the harness generated without an API call. ax picks a
session's model with **last-write-wins** over every entry, so a single trailing
synthetic entry overwrites the real model for the entire session.

`normalizeModelName` maps `"<synthetic>"` to `null` (correctly - it is not a
model), so those sessions then price at **$0** and render as **UNPRICED** in the
cost rollups.

Live database, at the time of writing:

- `SELECT count() FROM session WHERE model = '<synthetic>'` → **148**
- `SELECT count(), math::sum(prompt_tokens), math::sum(estimated_cost_usd) FROM
  session_token_usage WHERE model = '<synthetic>'` → **148 rows, 645,067,300
  prompt tokens, $0.00**
- The `turn_token_usage` rows for those same 148 sessions total **$384.82** -
  a lower bound on what is missing at session grain, since turn rows are
  themselves incomplete.

One concrete session, `0e6ae51b-0865-4804-b89f-b834d30f5afa`:

```
SELECT model, count() FROM turn_token_usage WHERE session = session:`0e6ae51b-…` GROUP BY model;
-- [{model: "<synthetic>", n: 1}, {model: "claude-opus-4-8", n: 306}]
```

306 real `claude-opus-4-8` turns, one synthetic turn - and the session-level row
is filed under `<synthetic>` with 53,362,299 prompt tokens costed at $0.

The damage is not only cost: `session.model` feeds every model-grouped surface
(`ax cost models`, `ax cost split`, dispatch analytics, profile model shares), so
148 sessions are attributed to a non-existent model everywhere.

## Current state

`apps/axctl/src/ingest/transcripts.ts:966-973`:

```ts
            seq += 1;
            const role = type ?? "unknown";
            const message = entry.message ?? null;
            const entryModel = message?.model ?? entry.model ?? null;
            if (entryModel) {
                model = entryModel;
                if (session) session.model = entryModel;
            }
```

`model` (the local) flows into each per-turn usage row
(`transcripts.ts:992`); `session.model` flows into the session-level usage row
(`transcripts.ts:1176`, `model: session.model`) and into the `session` record
itself (`transcripts.ts:1511`, `model: extracted.session.model`).

The sentinel is recognised in exactly one place today -
`apps/axctl/src/ingest/model-pricing.ts:362-364`:

```ts
export function normalizeModelName(model: string | null | undefined): string | null {
    const trimmed = model?.trim();
    if (!trimmed || trimmed === "<synthetic>") return null;
```

## What to do

### Step 1 - name the sentinel once, in the pricing module

In `apps/axctl/src/ingest/model-pricing.ts`, just above `normalizeModelName`,
add and export the constant plus a predicate, and use them in
`normalizeModelName` so there is a single definition:

```ts
/**
 * Claude Code's placeholder `model` on assistant entries it generated WITHOUT an
 * API call. It is not a model: it must never win a session's model attribution
 * and must never be priced.
 */
export const SYNTHETIC_MODEL_SENTINEL = "<synthetic>";

export const isSyntheticModel = (model: string | null | undefined): boolean =>
    model?.trim() === SYNTHETIC_MODEL_SENTINEL;
```

Rewrite the guard inside `normalizeModelName` to use `isSyntheticModel(trimmed)`
instead of the inline string compare. Behaviour must be identical.

### Step 2 - do not let the sentinel overwrite the session model

In `apps/axctl/src/ingest/transcripts.ts`, import `isSyntheticModel` from
`./model-pricing.ts` (there are already imports from that module in this file -
match the existing import grouping) and change the block at lines 969-973 to:

```ts
            const entryModel = message?.model ?? entry.model ?? null;
            // `<synthetic>` marks a harness-generated entry with no API call. It
            // is not a model, and attribution here is last-write-wins, so one
            // trailing synthetic entry used to relabel the whole session -
            // filing its real spend under a non-model that prices at $0.
            if (entryModel && !isSyntheticModel(entryModel)) {
                model = entryModel;
                if (session) session.model = entryModel;
            }
```

That is the entire behavioural change: a synthetic entry now leaves the
last real model in place instead of clobbering it.

**Edge case to preserve:** a session whose entries are *all* synthetic keeps
`session.model === null`, exactly as it does today for a session with no model
at all. Do not substitute a placeholder.

Verify:

```
bunx tsc --noEmit -p tsconfig.json
```

Expected: no `error TS` lines. (`bun run typecheck` can exit 0 while CI's plain
`tsc` fails - CI gates on the command above.)

### Step 3 - tests

Add a case to `apps/axctl/src/ingest/transcripts.test.ts`. Find an existing test
that builds a small transcript and asserts on the produced session/usage - use it
as the structural pattern (search for `usageLines(` in that file; there is
already a case at roughly line 1539 using `usageLines("some-unpriced-model")`).

The new case must assert: given entries `[assistant model "claude-opus-4-8" with
usage, assistant model "<synthetic>"]`, the resulting session model is
`"claude-opus-4-8"` - NOT `"<synthetic>"`.

Add a second, pure case to `apps/axctl/src/ingest/model-pricing.test.ts`:

```ts
    it("treats <synthetic> as a non-model everywhere", () => {
        expect(isSyntheticModel("<synthetic>")).toBe(true);
        expect(isSyntheticModel(" <synthetic> ")).toBe(true);
        expect(isSyntheticModel("claude-opus-5")).toBe(false);
        expect(isSyntheticModel(null)).toBe(false);
        expect(normalizeModelName(SYNTHETIC_MODEL_SENTINEL)).toBeNull();
    });
```

Add `isSyntheticModel` and `SYNTHETIC_MODEL_SENTINEL` to that file's import list.

Verify:

```
bun test apps/axctl/src/ingest/model-pricing.test.ts apps/axctl/src/ingest/transcripts.test.ts
bun test
```

Expected: both suites green. On the full run, exactly 4 failures are pre-existing
and unrelated - `apps/studio-desktop/src/electron/*.test.ts` failing with
`Electron failed to install correctly`. Any OTHER failure is yours.

### Step 4 - heal the 148 existing sessions

The fix only helps sessions ingested afterwards. To correct history, the affected
transcripts must be re-read:

```
ax ingest --reparse=claude,subagents
```

Do NOT write a SQL migration that rewrites `session.model` in place - the correct
model per session comes from re-parsing the transcript, and the re-parse path
already exists (`--reparse` clears the skip-unchanged watermark; see
`apps/axctl/src/ingest/reparse-targets.ts`).

**Caveat to state in the PR body, not to fix here:** re-parsing rewrites
`session.model` and the session usage row's `model`, but `derive-cost-backfill`
only prices rows `WHERE estimated_cost_usd IS NONE`. The 148 rows currently store
`estimated_cost_usd = 0` (not NONE) for some providers - check before claiming
the money reappears:

```
curl -s -u root:root -H "surreal-ns: ax" -H "surreal-db: main" -X POST \
  http://127.0.0.1:8521/sql --data-binary \
  "SELECT count() AS n FROM session_token_usage WHERE model = '<synthetic>' AND estimated_cost_usd IS NONE GROUP ALL;"
```

If `n` is less than 148, the remainder needs the repricing path that does not yet
exist (finding 5 of the audit) - say so plainly rather than implying the fix
recovers all of it.

## Boundaries

**In scope:** `apps/axctl/src/ingest/model-pricing.ts` (constant + predicate,
reuse in `normalizeModelName`), `apps/axctl/src/ingest/transcripts.ts` (the
model-attribution guard only), and the two test files named above.

**Out of scope - do not touch:**
- Per-turn model attribution (`transcripts.ts:992`). Turn rows correctly record
  the synthetic entry as synthetic; only session-level rollup was wrong.
- `estimateCost`, `componentCost`, `fastMultiplier` - plans 001 and 003.
- Any SQL migration or in-place rewrite of `session` / `session_token_usage`.
- The Codex / Pi / OpenCode / Cursor parsers - the sentinel is Claude-specific.

## Done criteria

1. `bunx tsc --noEmit -p tsconfig.json` prints no `error TS` lines.
2. `bun test apps/axctl/src/ingest/model-pricing.test.ts apps/axctl/src/ingest/transcripts.test.ts` - all pass.
3. `bun test` - only the 4 pre-existing electron failures.
4. `rg -n '"<synthetic>"' apps/axctl/src --glob '!*.test.ts'` returns exactly ONE
   hit: the `SYNTHETIC_MODEL_SENTINEL` definition.
5. The new transcripts test fails when the guard in step 2 is reverted (confirm
   by temporarily reverting, running, and restoring - a test that passes either
   way is not testing the fix).

## Test plan

- Pure predicate coverage in `model-pricing.test.ts` (no DB, no fixtures).
- Behavioural coverage in `transcripts.test.ts`, following the existing
  `usageLines(...)` fixture pattern in that file: a two-entry transcript where
  the synthetic entry is last, asserting the real model survives.

## Maintenance note

`<synthetic>` is a Claude Code harness detail; if another harness introduces its
own placeholder, extend `isSyntheticModel` rather than adding a second inline
compare. The reason this went unnoticed is that `normalizeModelName` handled the
sentinel *correctly* at the pricing boundary - the attribution site upstream had
no idea the value was special. Any new consumer of `message.model` should route
through `isSyntheticModel` first.

## Escape hatches

- If the transcripts test fixture helper does not let you set `message.model`
  per entry, STOP and report rather than restructuring the fixture layer.
- If `rg -n '"<synthetic>"'` shows the sentinel is also compared in a parser you
  were told not to touch, report it - do not widen the change silently.
