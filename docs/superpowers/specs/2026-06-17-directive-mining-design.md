# Directive Mining - learn per-user "how to work" instructions

**Issue:** #535
**Status:** Draft
**Date:** 2026-06-17
**Found via:** dogfooding `ax memory ops` (#531) → searching the user's "remember" turns → realising ax mines *corrections* but not *directives*.

---

## 1. Problem

ax already mines **corrections** (`deriveCorrections`): reactive signals where the
agent did something and the user pushed back. It does **not** capture **directives**:
*proactive* standing instructions where the user states how the agent should work -
independent of any failure.

> "remember to dogfood before you show anything to me"
> "you should remember this as a project memory and decide based on it when refactoring"
> "always wrap copy in ``` blocks"
> "give me full paths so I can click them"

These are the **highest-signal source for durable memory + guidance** - the user
literally telling the agent how to behave. Evidence they matter: in this user's own
graph, ~half of all turns containing "remember" already became `feedback-*` memories.
**The harvesting is happening - by hand.** This spec automates it.

### Why a naive detector fails
- A hand-tuned marker regex (`remember to|always|from now on`) is brittle and needs
  endless babysitting.
- **Different users use different words.** One says "remember to", another "make sure
  you", a third just uses bare imperatives. A shipped global list can't fit all.
- The word alone is noisy: of 12 "remember" turns in this user's history, only ~half
  were directives; the rest were filler ("I don't remember", "as I remember").

So the design must be **per-user, self-improving, and grounded in outcomes** - not a
static classifier.

---

## 2. Approach - CLI scaffolds deterministically, agent fills judgment

This is ax's established **brief** pattern. Direct siblings:
- `routing tune --emit-brief` (mine clusters deterministically; agent backtests judgment)
- `skills classify` (emit briefs for unclassified skills; agent tags)
- `improve accept` (proposal → `.ax/tasks/<id>.md` brief → agent acts → `lint` reconciles)
- `dojo spar-plan` (CLI freezes baseline; agent runs the variant)

Determinism where it belongs (counting, lift, recurrence - reproducible math),
judgment where it belongs (is this turn a real standing directive, what does it mean,
where should it land - the agent).

### 2.1 Mine n-grams by **lift**, not frequency

Frequency alone surfaces "the", "can you". The signal is **lift**:

```
lift(ngram) = P(outcome | turn contains ngram) / P(outcome)
```

where **outcome** = the user turn was followed (same session, within a bounded window)
by:
- a **memory write** - an `edited` edge to a `~/.claude/.../memory/` path (the signal
  `ax memory ops` exposes, #531/#532), **or**
- an **accepted `improve` proposal**, **or**
- a **hook/rule** added to `~/.ax/hooks/`.

High-lift n-grams (1–4 tokens, lowercased, over `role=user` turns) are **this user's
directive markers**. The table is:
- **data-derived per user** - no shipped regex,
- **re-fit every ingest** - grows as the user's vocabulary surfaces,
- **self-correcting** - an n-gram that stops leading to captured outcomes loses rank.

Cold start: until enough outcomes exist to compute stable lift, fall back to a small
**seed** marker set (imperative-mood heuristic + a handful of universal markers) at
**lower confidence**, clearly labelled as unconfirmed. The seed only bootstraps; lift
takes over as labels accumulate.

### 2.2 Flag candidates

User turns matching high-lift n-grams (or seed markers) that are **not yet captured**
as a memory / guidance / hook. Hard filters (the `deriveCorrections` pollution lesson):
- drop `<task-notification>` / harness-injected bodies,
- drop `source = claude-subagent` (dispatch prompts, not the human),
- drop turns already linked to an existing directive/memory/proposal.

### 2.3 Emit a brief

```
ax directives mine --emit-brief  →  .ax/tasks/directives-<date>.md
```

The brief lists each candidate turn with: the matched n-gram(s) + lift, the source
session/ts (clickable), recurrence count (§2.5), and a fill-in block per candidate:
`is_directive? · canonical_text · landing(memory|guidance|hook) · rationale`.

### 2.4 Agent fills → tracked directive records

The agent judges each candidate and writes a **directive** record. A directive is
modelled as a **new `improve` proposal kind** so it inherits the existing
accept / verdict / lint machinery for free - no parallel review surface.

Fields (on the proposal, or a sibling `directive` table if cleaner):
`text · evidence_turns[] · surfaced_ngrams[] · landing · status · recurrence · verdict`.

### 2.5 Track + grow via **recurrence** - "it keeps coming back" is the feature

A directive's *strength* = how often the user restates it across sessions. Recurrence
is the escalation signal, and it's exactly what answers "this will keep coming back":

```
said once               → memory note            (passive recall)
keeps recurring         → the note isn't landing  → ESCALATE to guidance / hook (enforcement)
stops after enforcement → it's working            → retire to background
```

The system **measures whether its own directives are being followed**. If the user
keeps telling the agent "dogfood before showing me" every week, that's proof the
memory note failed to change behaviour → escalate it to a `verify`-style gate. The
miner counts recurrence automatically (same directive re-surfaced by the same/related
n-grams across sessions), so directives **self-prioritise and self-escalate** with no
manual tuning. This is the engine that "keeps improving."

---

## 3. The loop

```
mine    directive-ngrams query: rank n-grams by lift vs outcomes (per user, re-fit each ingest)
flag    user turns matching high-lift n-grams, not yet captured → candidates (harness noise filtered)
brief   ax directives mine --emit-brief → .ax/tasks/directives-<date>.md
fill    agent judges each: real directive? meaning? landing? → writes directive record
track   directive: text, evidence, recurrence, status, landing, verdict
grow    recurrence ↑ → escalate memory→hook; lift table sharpens as outcomes accumulate; self-clearing
```

Runs as: a recurring **ingest derive stage** (flag candidates each ingest) + a
self-clearing **dojo/retro agenda item** (surface unconfirmed directives for a yes/no).
A candidate vanishes once it becomes a directive or is dismissed.

---

## 4. Surface

- `ax directives mine [--emit-brief] [--days=N]` - rank candidate directive turns by
  n-gram lift; emit the agent brief.
- `ax directives list [--status=active|candidate|escalated] [--json]` - tracked
  directives, sorted by recurrence.
- `ax directives ngrams [--json]` - the learned per-user lift table (transparency /
  debugging; this is what makes "different users, different words" visible).
- Dojo: a `directives` agenda item when unconfirmed candidates exist.
- Reuse `ax improve accept` / `lint` for the accept→apply→reconcile path.

---

## 5. Explicitly NOT

- **No embeddings.** The clustering spike (`embedding-clustering-spike`) rejected them:
  noise-dominated, only 1/8 clusters real. Stay lexical (n-gram + lift) and
  outcome-grounded - cheaper, explainable, and the grounding does the work embeddings
  couldn't.
- **No hand-maintained global marker list.** Markers are *learned per user* from
  outcomes; the only shipped lexicon is the tiny cold-start seed.
- **No auto-write of directives.** The agent (judgment) writes them via the brief;
  the CLI only scaffolds candidates. Mirrors every other ax brief loop.

---

## 6. Open questions

1. **Confirmation window** - what counts as a turn "leading to" an outcome: same
   session only? same session within ±N turns? Topical match (shared file/skill/keyword)
   in addition to temporal? (Tighter = higher precision lift, fewer labels.)
2. **Directive vs task** - v1 binary (directive-or-not), or full 4-way
   (directive / task / question / correction) so it also de-noises the `turn` table for
   other consumers (e.g. "what the user actually asked", which came up this session)?
3. **Landing default** - when the agent is unsure, does a new directive default to
   `memory` (safe, passive) and only escalate on recurrence, or can the agent open it
   straight as a `hook` when the text is clearly an enforceable gate?
4. **Recurrence identity** - how is "the same directive restated" detected across
   sessions: shared canonical_text similarity, shared surfaced n-gram, or shared
   landing target? (Determines how reliably escalation fires.)
5. **Schema** - reuse `proposal` with a new `kind`, or a dedicated `directive` table?
   Reuse is less surface but may strain the proposal shape (recurrence, landing,
   escalation state have no `proposal` home today).

---

## 7. Implementation slices (post-spec)

1. `queries/directive-ngrams.ts` - lift table over `turn` × outcomes (deref-free,
   per-user). Tests on synthetic turn/outcome fixtures.
2. `ingest/derive-directive-candidates.ts` - flag + store candidates (harness-noise
   filtered); recurrence counter.
3. `cli/commands/ax-directives.ts` - `mine --emit-brief` / `list` / `ngrams`; brief
   template.
4. Directive record + `improve` proposal-kind wiring (or `directive` table per Q5);
   accept/lint reuse.
5. Dojo agenda item + escalation rule (memory→hook on recurrence threshold).
6. Docs gates (cli.md, llms.txt, cli-reference.data.ts, VISIBLE_COMMANDS) +
   `ax directives` in MCP if read-only views warrant it.
