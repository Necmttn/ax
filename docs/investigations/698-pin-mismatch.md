# #698 - dispatch `!` pin mismatches: known model-drop, not a pin bug

**Date:** 2026-07-16
**Verdict:** **Known model-drop - ax attribution is CORRECT.** No CC pin bug, no ax attribution bug.
**Method:** read-only `ax dispatches --days=14 --json` against the live DB + raw child/parent transcript inspection under `~/.claude/projects/`. No ingest, no DB writes.

## Question

`ax dispatches --days=14` shows rows with `dispatch_model: sonnet` but `child_model: !claude-fable-5`
($16–29 each). Were these the documented harness drop (first leg honored the pin, continuation legs
fell back), or something new - a child that NEVER ran sonnet (ax attribution error, or a real Claude
Code pin bug)?

## Answer

The documented drop, on all six rows. The pin **was** honored: each child starts on
`claude-sonnet-5` and switches to `claude-fable-5` - the **parent's own model** - on the first
`SendMessage` continuation. ax's per-leg accounting reproduces the transcript exactly.

## The six mismatch rows (14d window, all `dispatch_model: sonnet` → `child_model: claude-fable-5`)

| ts (UTC) | description | child session | sonnet turns | fable turns | child_cost | dropped_cost |
|---|---|---|---|---|---|---|
| 2026-07-12T03:58:41 | Implement Task 5: reconcile lock | `a2c40fe74f3aca4dc` | 85 | 35 | $28.79 | $13.97 |
| 2026-07-10T10:25:05 | Implement Task 4 pipeline | `a1cebf8bbcbdc4c91` | 91 | 40 | $27.73 | $13.64 |
| 2026-07-12T03:12:26 | Implement Task 2: executor throwing | `a24a0d20ab9b96bb7` | 97 | 22 | $26.60 | $6.94 |
| 2026-07-10T10:07:11 | Implement Task 2 SpeechEngine | `aef8229eb86e0f6a5` | 40 | 89 | $22.37 | $16.72 |
| 2026-07-12T02:56:19 | Implement Task 3: pipeline handler | `afa509dc1c249bdc3` | 88 | 22 | $17.82 | $5.97 |
| 2026-07-04T09:37:46 | Implement Task 3: v1 bindings | `a09ebf7c88379859e` | 70 | 30 | $15.98 | $6.70 |

**The structural tell:** every one of the six carries **both** a sonnet leg and a fable leg. A genuine
pin failure would produce a fable-**only** child (no sonnet leg at all). None of the six looks like that.

## Transcript evidence (2 of 6 verified at the raw-message level)

### Row 1 - "Implement Task 5: reconcile lock"

- Parent: `6c68b846-1d0b-4e21-9e99-a3c7339eeff5` (ran `claude-fable-5`, 180 msgs)
- Parent's dispatch call `toolu_013RnnsNadc4ghMeAmELTt6d`:
  `{ name: "Agent", model: "sonnet", subagent_type: "general-purpose" }` - **pin was sent**
- Child: `subagents/agent-a2c40fe74f3aca4dc.jsonl`, 120 assistant messages, one single transition:

```
msg   1: 2026-07-12T03:58:43.316Z  ->  claude-sonnet-5     # pin HONORED
msg  86: 2026-07-12T04:12:30.671Z  ->  claude-fable-5      # drop
```

Trigger, 7s before the switch - no compact boundary anywhere in the child:

```
2026-07-12T04:12:23.212Z  user       The coordinator sent a message while you were working:\nRevie…
2026-07-12T04:12:30.671Z  assistant  claude-fable-5
```

Per-model counts: 85 `claude-sonnet-5`, 35 `claude-fable-5` - **identical** to ax's `child_legs`.

### Row 4 - "Implement Task 2 SpeechEngine" (different project, different day)

- Parent: `470fc362-f81f-4556-9bd9-adbd186daa8b` (ran `claude-fable-5`, 425 msgs)
- Dispatch call `toolu_017qZbohxzbvDFkd1Tke38wf`: `{ model: "sonnet", description: "Implement Task 2 SpeechEngine" }`
- Child `agent-aef8229eb86e0f6a5.jsonl`:

```
msg   1: 2026-07-10T10:07:14.351Z  ->  claude-sonnet-5
msg  41: 2026-07-10T10:15:29.998Z  ->  claude-fable-5   (coordinator SendMessage at 10:15:22.948Z)
```

Per-model counts: 40 sonnet / 89 fable - again **identical** to ax's `child_legs`.

## Mechanism

The drop target is not arbitrary: in both cases the child continues on **the parent session's model**
(`claude-fable-5`), which is what "the harness drops the Agent `model` override on
SendMessage/compact continuations" predicts. Here the trigger is specifically **SendMessage**
(`"The coordinator sent a message while you were working:"`); neither child contains a compact
boundary. A second SendMessage later in row 4 (11:32:42) does not switch anything back - once
dropped, the child stays on the parent's model for the rest of the run.

Cost consequence is real: $128.18 across 42 dropped dispatches in the window (`dropped_cost_usd`),
i.e. work that was routed to sonnet and billed at frontier rates after the first continuation.

## Why no code change

- **Attribution is correct.** `child_legs` turn counts match the transcripts exactly on both sampled
  sessions; `model_dropped` fires on precisely the rows where a leg ran off-pin.
- **The output does not mislead.** The existing footer in `apps/axctl/src/cli/commands/ax-dispatches.ts:281-287`
  already states it: *"N routed dispatches continued on a different model ($X on dropped legs, marked
  "!") - the harness drops the model override on SendMessage/compact continuations."* The `!` marker plus
  that footer is an accurate account of what the transcripts show. A row-level footnote would restate it.
- The one arguable gap - `child_model` names only the drop target (fable), not the majority model
  (sonnet ran 85/120 turns in row 1) - is what `!` + `child_legs` in `--json` exist to express. Not
  worth a schema/UX change on this evidence.

**Falsifier:** a `!` row whose `child_legs` contain **no** leg matching `dispatch_model` would be a real
pin failure (child never honored the pin). None of the six is that. Worth re-checking if a fable-only
child ever appears.

## Separate finding: `claude-sonnet-5` is unpriced → $0 (NOT #698, worth its own issue)

Chasing why every sonnet leg above reports `cost_usd: 0` surfaced an unrelated and larger bug.

`ax cost models --days=14` on this machine:

```
claude-sonnet-5   572 sessions   1,999,887,365 prompt   7,300,585 completion   1,866,502,376 cache_read   $0.0000
claude-sonnet-4-6  11 sessions      13,361,274 prompt      58,557 completion      11,725,611 cache_read  $10.4728
```

**Root cause:** `apps/axctl/src/ingest/model-pricing.ts` - `BUILTIN_MODEL_PRICING_CATALOG` has no
`claude-sonnet-5` key, and the family fallback (lines 413-416) only covers
`claude-fable-5` / `claude-haiku-4-5` / `claude-opus-4` / `claude-sonnet-4`:

```ts
if (modelKey.startsWith("claude-fable-5"))  return catalog.get("claude-fable-5")  ?? null;
if (modelKey.startsWith("claude-haiku-4-5")) return catalog.get("claude-haiku-4-5") ?? null;
if (modelKey.startsWith("claude-opus-4"))   return catalog.get("claude-opus-4")   ?? null;
if (modelKey.startsWith("claude-sonnet-4")) return catalog.get("claude-sonnet-4") ?? null;
// claude-sonnet-5 matches nothing -> null -> estimated_cost_usd = 0
```

`claude-sonnet-4-6` prices only because it prefix-matches `claude-sonnet-4`. `claude-sonnet-5` matches
nothing. Same gap for `gpt-5.6-sol` (168 sessions, 766M prompt tokens, $0), `gpt-5.6-luna`, `gpt-5.6-terra`.

**Blast radius:** every cost surface that reads `estimated_cost_usd` understates sonnet-5 and gpt-5.6
spend as zero - `ax cost models`, `cost split`, `cost routability`, `dispatches`. It also makes
route-to-sonnet look free, which flatters exactly the routing decisions ax is meant to measure.

**Not fixed here, deliberately:** the fix is a pricing-catalog change whose effect only lands on
re-ingest/backfill, and this investigation is scoped read-only (no ingest, no DB writes) - so it could
not be verified in this worktree. Filed as a follow-up instead.
