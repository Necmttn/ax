# Directive Mining - learn per-user "how to work" instructions

**Issue:** #535
**Status:** Rescoped v1 after adversarial review (see §0). Sections 1–6 describe the
v1 MVP; sections 7+ and §2.1/§2.6/§2.7 are the **deferred v2 vision** (preserved, not built).
**Date:** 2026-06-17
**Found via:** dogfooding `ax memory ops` (#531) → searching the user's "remember" turns → realising ax mines *corrections* but not *directives*.

---

## 0. Status - rescoped after adversarial review

A 4-reviewer panel (2 Codex + 2 Claude, distinct lenses) roasted the original design.
Unanimous across both models: the original v1 was over-built - a research program
stapled to an unproven hypothesis, with ~80% either duplicating the existing `improve`
pipeline or (for the community layer) unsafe as designed. This section records the
verdict and the rescope; the rest of the doc keeps the full design, tagged.

### 0.1 The v1 MVP (the only thing built first)

**One new signal - `deriveDirectives` - feeding the existing proposal pipeline.** It
flags *proactive standing-instruction* user turns (imperative-mood, not anchored to a
prior agent action - the gap `deriveCorrections` leaves, which only catches *reactive*
push-back) and emits them as `guidance`-form rows into `deriveProposals`. They then
surface in `ax improve recommend`, accept via the existing `.ax/tasks` brief, and accrue
`frequency` / verdict **for free**.

> **Zero new commands, zero new tables, zero community layer, zero n-gram miner.**
> This alone tests the core bet: *will users act on mined directives?* Everything else
> is gated on that answer.

### 0.2 Reuse map - what already ships (do NOT rebuild)

| Spec concept | Already exists | File |
|--------------|----------------|------|
| mine → propose → accept-brief → reconcile → measure | the whole loop | `ingest/derive-proposals.ts` + `improve/` |
| recurrence → escalate → measure (§2.5) | `frequency` on stable `dedupe_sig` + frozen `baseline` → verdict friction-delta | `derive-proposals.ts` |
| landing `memory\|guidance\|hook` (§2.3) | `INTERVENTION_FORM_REGISTRY` (`guidance\|skill\|harness_check\|subagent\|hook\|automation`) - a superset | `improve/intervention-forms.ts` |
| harness-noise filter (§2.2) | drops `<task-notification>` + `claude-subagent` | `ingest/signals/core.ts` (`deriveCorrections`) |
| grounding detectors (§7.5): `done-without-verification` | verification taxonomy (PR #474) | `check-family.ts` |
| grounding detectors (§7.5): `edit-on-main` | the enforce-worktree hook | hooks-sdk |
| "candidate query + pass/fail verdict" | `ax hooks cases` | `queries/feedback-cases.ts` |

So a "directive" is **a new `kind`/detector on the existing proposal pipeline**, not a
parallel subsystem. (Resolves §6 Q5: reuse, don't add a table.)

### 0.3 Deferred to v2 (built only if the MVP proves the bet)

- **§2.1 n-gram-lift miner** - gold-plating. §2.6 concedes ax already computes the
  antecedents; v1 wires those existing signals, no new mining. (Also: lift is
  statistically shaky at one-user scale - sparse N, and the same turn often both states
  the directive *and* triggers the outcome → circular labels.)
- **§2.7 workflow ladder** - pure speculation; defers its own payload.
- **§7 community layer (all of it)** - see §0.4. Premature *and* unsafe.
- **§7.5 grounding-detector registry as new code** - mostly reskins `insights.ts` /
  `check-family.ts` / `feedback-cases.ts`. v1 reuses those directly.
- **24-pattern `seed.json`** - demoted from "subsystem deliverable" to a starter/docs
  asset (it's generic agent hygiene any LLM regenerates; 12/24 detector refs are
  illustrative, pending the v2 registry).

### 0.4 Community layer - BLOCKED on security redesign (do not build)

The privacy reviewer found the contribution loop unsafe as designed. Hard blockers
before any community code:

1. `pull_request_target` auto-merge feeds data into **3 code-execution sinks**: detector
   `params` → SurrealQL **on every install** (injection unless params are a closed typed
   schema, bound never interpolated); free-text `directive`/`phrasings` → **stored XSS**
   on the site; validator pwn-request.
2. **">= N contributors" does not stop sybils** - content-hash dedup *is* the sybil
   counter (N free accounts, same hash → graduate → auto-seed a malicious `landing:hook`
   to every install). Define "independent"; require account history; invert (identical
   content from many fresh accounts = sybil signal, not diversity); **human gate before
   graduation**.
3. **Abstraction leaks** - `phrasings` are raw user turns; per-user `contributed/<login>.json`
   is world-readable on merge *before* the threshold applies. The "specifics stripped
   before anything leaves the machine" claim (§7.3) is false as written. Drop `phrasings`
   from published artifacts; compile from user gists (profile-publish model), not repo forks.
4. **One-time consent + auto-PATCH** of later-mined content (the watcher re-publishes
   `--if-stale`) → user consents to X, publishes X+Δ; git history is permanent. Require
   per-change consent showing the diff.
5. **Case evidence rows** are raw graph rows (`command_text`, paths) - scrubbing undefined.

→ Community layer is **too risky for v1**; redesign required before it ships.

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

> **⚠ v2 - DEFERRED (§0.3).** v1 does NOT build the n-gram miner; it wires ax's
> existing antecedent signals (churn/friction/fragility/repair, per §2.6) into the
> proposal pipeline. Lift is also statistically shaky at one-user scale (sparse N,
> circular labels). Kept here as the v2 vision.

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

### 2.6 Two entry points - antecedent (bottom-up) + directive (top-down)

A directive is the *reaction* to a problem; **what comes before it** - the recurring
friction that provoked it - is the **antecedent pattern**, and that's where autonomous
pattern-recognition + automation start. You say "dogfood before showing me" *because* an
agent kept claiming done without verifying. The directive is your hand-authored fix; the
antecedent is the **machine-recognisable pattern the fix addresses**. So there are two
entry points that meet at a shared spine:

```
BOTTOM-UP (behaviour)                            TOP-DOWN (words)
recurring friction pattern in the graph           user states a directive
   "agent keeps claiming done w/o verifying"         "dogfood before showing me"
            \                                        /
             \______________  DETECTOR  ____________/      <- the shared spine
                  (a named graph query that recognises the pattern)
                              |  recurs past threshold
                    candidate directive + proposed enforcement (consent-gated)
                              |  install hook
                    measure: did the antecedent drop?  -> verdict / escalate
```

A directive's detector *is* an antecedent recogniser. The **bottom-up path needs no
words** - so the "different users, different words" problem disappears entirely for the
autonomous lane. In ML terms: the directive (words) is the *supervised label*; the
antecedent (behaviour) is the *unsupervised pattern*. Mining antecedents proposes; the
directive confirms which ones matter. Semi-supervised, and it works even for users who
never articulate anything.

**ax already recognises most antecedents - reuse, don't rebuild.** The same queries are
the antecedent recognisers AND the directive detectors:

| Existing ax signal | Antecedent for directive |
|--------------------|--------------------------|
| `sessions churn` episodes (fail -> repair -> close) | verify-before-done, change-approach-after-2-fails |
| `insights friction` | general friction hotspots |
| `fragility_cascade` | risky-edit / stale-after-mutation |
| repair loops / verification taxonomy (failed checks) | verify-before-done |
| edit-without-read sequences | read-before-edit |

ax also already turns graph signals into proposals (`deriveProposals` / `improve
recommend`), so antecedent -> candidate is partly built. Bottom-up directive discovery is
mostly *wiring existing insight signals into the pattern/proposal loop*, not new
detection. This reframes the whole feature: not "mine what users say" but **"recognise
friction patterns, propose fixes, let user words confirm and sharpen."**

### 2.7 Granularity ladder - directives (atomic) -> workflows (sequence)

> **⚠ v2 - DEFERRED (§0.3).** Speculative; defers its own payload. Not built in v1.

The same mine -> ground -> propose -> automate -> measure loop applies at two scales:

```
atomic antecedent   ->  directive  ->  HOOK              (enforce a single rule)
sequence antecedent ->  workflow   ->  CODIFIED WORKFLOW  (automate an ordered arc: skill / checklist / command)
```

A **directive** is one "how to work" rule (verify-before-done). A **workflow** is a
recurring *ordered sequence* of actions/skills/episodes that accomplishes a kind of task -
e.g. the `claim -> worktree -> TDD -> verify -> PR` arc repeated three times in the
session that produced this spec. Both are patterns mined from the graph; they differ only
in granularity (single-turn antecedent vs. an ordered chain), and they share the same
detector/proposal/verdict spine - a workflow detector matches a *sequence* of tool/skill/
episode events rather than a single-turn shape.

ax already has the **sequence-scale machinery**: the `ax-extract-workflow` skill
("reconstruct the workflow behind a shipped artifact") and the `workflow_epoch` table.
So directive mining is the *atomic* rung of a ladder whose *sequence* rung already
exists - identifying directives is also the on-ramp to identifying workflows. Mining the
recurring action arcs (and the order directives fire within them) turns "how you work"
from scattered rules into reusable, suggestable, eventually-automatable workflows.
*(Workflow-scale detection is a follow-on; this spec ships the atomic rung and the shared
spine that the sequence rung plugs into.)*

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

## 7. Community layer - seed pack + contribution loop

> **🚫 v2 - BLOCKED + DEFERRED. Not built in v1.** Premature (§0.3) AND unsafe as
> designed (§0.4: auto-merge → 3 code-exec sinks, sybil threshold defeated by its own
> dedup, abstraction leaks raw turns, one-time consent + auto-PATCH). The 5 security
> blockers in §0.4 must be resolved by redesign before any community code. The curated
> `seed.json` (layer 1, §7.1) is the only safe-to-ship piece, demoted to a starter asset.

The local miner only pays off once a user has history; a **community pattern library
gives day-1 value** and turns ax into a two-sided system (your patterns + everyone's).
This is the parked registry/mesh design (`ax-registry-mesh-design`) with a *safer
wedge*: abstracted **patterns** instead of raw recovery verdicts. It rides existing
community rails - `ax profile publish` (consent gate), `community-nightly` (compile
worker), trending boards - so it's incremental, not greenfield. Strategically it's also
the adoption wedge (`team-adoption-roadmap`: push-value first, then contribution, then moat).

### 7.1 Three layers (ship 1 now, design 2-3)

1. **Curated seed pack** - `community/patterns/seed.json`: ~24 battle-tested directives
   across verification / output / process / git / quality / communication. Decoupled
   from the miner, **no privacy surface** (outbound-curated). Delivers immediate value:
   a fresh install ships with adoptable patterns. Many seeds are abstracted from real
   ax-user `feedback-*` memories - living proof the contribution concept works.
   **Shipped in this PR.**
2. **Contribution loop** - local mined directives, abstracted, consent-gated publish,
   compiled into pattern-stats, fed back as new seeds. See 7.3.
3. **Trending patterns board** - `community/patterns/trending.json` beside
   trending-skills; the moat + contributor recognition (same dynamic that already works
   for skills).

### 7.2 Pattern schema

```jsonc
{
  "id": "verify-before-claiming-done",        // stable kebab id
  "title": "Verify before claiming done",
  "category": "verification",                  // verification|output|process|git|quality|communication
  "directive": "Run the actual verification command and show its output before claiming something works/passes.",
  "phrasings": ["did you test it", "dogfood before showing", "show me it works"],
  "landing": "hook",                            // memory|guidance|hook (passive -> enforced)
  "rationale": "Unverified 'done' is the most common agent failure; enforceable as a gate.",
  "source": "curated"                           // curated|community
}
```

### 7.3 Contribution loop - where "auto" applies (and where it must not)

```
auto-MINE        local n-grams + candidates                      (no network)
auto-ABSTRACT    directive -> pattern SHAPE, specifics stripped    ("verify-before-claiming-done", not the raw turn)
consent PUBLISH  one yes, exact JSON shown                        (the ax profile publish model - NEVER auto)
auto-COMPILE     nightly: dedup + threshold + rank across users   (pattern-stats)
auto-SEED        installs pull top community patterns             (day-1 value, grows over time)
```

**Privacy is the whole game** (locked decision, v1): contribute the *generalized
pattern*, never the raw turn text (which leaks project names, paths, opinions).
Guarantees:
- abstraction strips specifics (paths, names, repos) **before anything leaves the machine**;
- publish is **consent-gated** - profile-publish precedent: show the exact JSON, one
  explicit yes, PATCH-in-place - **never automatic**;
- only patterns seen across **>= N independent contributors** compile into the public
  board (the threshold kills one-off / identifying patterns);
- validation reuses `community-users.yml` (schema-validated, data-only PR head, never executed).

### 7.4 Consume the seed (immediate-value surface)

- `ax patterns list [--category=C] [--json]` - browse the seed / community library.
- `ax patterns adopt <id>` - write the pattern into your setup via the existing
  `improve accept` brief path (memory / guidance / hook per its `landing`).
- `ax patterns suggest` - patterns you're not yet following (gap vs your `feedback-*`
  memories + installed hooks). The cold-start companion to the local miner.

### 7.5 Grounding layer - patterns are executable against the graph

A pattern is not just prose to eyeball; the behavioral ones are **executable against
the ax graph**. Grounding is what makes "are you following this?" and "did adopting it
help?" answerable, and what separates a *measurable* directive from a vibe. Three layers,
cleanly separated:

| Layer | Is | Grows via | Conflict |
|-------|-----|-----------|----------|
| **Detectors** | code - named, tested graph queries returning evidence rows | reviewed code PRs | n/a (curated) |
| **Patterns** | data - id + text + landing + `detector` ref + `groundable` | per-user files | zero |
| **Cases** | data - a pattern instance + the evidence rows a detector matched | per-user files | zero |

A **pattern binds to a detector** (a named graph query), which produces **cases**
(evidence rows) and **metrics** (violation counts) from the user's own graph.

**Security boundary:** contributors NEVER submit raw SurrealQL (running arbitrary
contributed queries against a local graph is a footgun). A pattern references a
**curated detector by id + params**; the detector registry is *code* - tested,
reviewed, named - so the data layer stays conflict-free AND the query layer stays safe.

Detector registry: `apps/axctl/src/patterns/detectors/*.ts`, each a named, deref-free
graph query (reusing the insights query toolkit, `check-family.ts`, churn-episode
logic, the `edited`/branch and `dispatches` model signals). Seed examples:

```
verify-before-claiming-done → "done-without-verification": assistant turn with done-language
   ("fixed/passing/works") AND no check-family tool_call in the same episode → violation rows
worktree-isolation          → "edit-on-main":   `edited` edge where checkout branch = main/master
dry-run-before-destructive  → "delete-without-dryrun": destructive tool_call (DELETE/DROP/rm) with
   no preceding count/dry-run in the episode
no-git-add-all              → "git-add-all":     Bash command_text matching `git add -A|.`
read-before-edit            → "edit-without-prior-read": Edit on a file with no preceding Read in session
```

**Not everything is groundable, and that's marked honestly.** Output-format / preference
patterns (`copy-in-codeblocks`, `full-absolute-paths`, `concise-output`, `typed-modular-testable`)
can't be detected from the graph; they carry `groundable: false`, `detector: null`, and
are adopted as guidance/memory, never auto-measured. In the v2 seed pack, **12 of 24
patterns are graph-grounded**, 12 are preference-only.

What grounding unlocks (the loop becomes real, not prose):
- **`ax patterns suggest`** runs groundable detectors over your graph → patterns you
  *actually violate*, ranked by violation count (behavioral, not keyword-matching).
- **Adoption is measurable**: install a pattern as a hook → detector violation count over
  time → did it drop? That confirms/escalates the verdict (§2.5 recurrence), grounded in
  evidence instead of guessed.
- **Contributed cases are verifiable**: a case ships `detector_id` + evidence shape, so
  the compile step can re-validate it's a real instance, not a claim. Dedup + the >=N
  threshold also handle privacy (one-off identifying cases never graduate).
- **Reuses the existing primitive**: `ax hooks cases` is already "candidate query +
  structured pass/fail verdict" - this extends that proven shape to community patterns.

### 7.6 Contribution format - conflict-free by construction (locked)

A single shared growing file (a JSON array) is the worst case for contribution: every
PR edits the same array → structural merge conflicts. Eval frameworks avoid this by
never sharing one growing file (promptfoo globs a *directory* of per-case files; eval
datasets append JSONL). ax already has the strongest version of this: **`community/users/<login>.json`** -
each user owns their own file, validated + auto-merged + nightly-compiled, so two
contributors *physically cannot* conflict. Mirror it exactly:

```
community/patterns/
  seed.json                  # maintainer-curated, single file, low churn - keep as-is
  contributed/
    <login>.json             # per-user, append-only, OWNER writes only -> zero conflict
  trending.json              # COMPILED nightly (generated, never hand-edit)
  index.json                 # COMPILED: merged seed + contributed, served to installs
```

A contributor only ever appends to `contributed/<login>.json` (patterns + cases). The
nightly compile (extends `community-nightly.yml`) merges curated + everyone's
contributed into `index.json` + `trending.json`, dedups by content hash, graduates a
pattern to public at >=N independent contributors. "Ever-growing list" = the union of
per-user files, grown by *adding files*, never editing a shared one. Validation reuses
`community-users.yml` (schema-checked, data-only PR head, never executed).

---

## 8. Open questions (community layer)

6. **Abstraction mechanism** - generalize a raw directive to a shareable pattern via
   deterministic templating off the matched n-gram, or an agent abstraction step in the
   brief (judgment, slower)? Determines how reliably specifics are stripped.
7. **Contribution threshold N** - how many independent contributors must surface a
   pattern before it compiles into the public board? (Higher = safer/less identifying,
   slower to grow.)
8. **Seed-on-install** - does `ax install` auto-offer the seed pack (opt-in prompt), or
   is adoption purely pull (`ax patterns adopt`)? Auto-offer = more day-1 value, but must
   not auto-write the user's config without consent.

## 9. Implementation slices (post-spec)

> **v1 = slice 0 ONLY.** Everything below slice 0 is **v2**, gated on the MVP proving the
> bet (and the community slices additionally gated on the §0.4 security redesign).

**v1 MVP**
0. `ingest/derive-directives.ts` - one signal that flags *proactive standing-instruction*
   user turns (imperative-mood, not anchored to a prior agent action) and emits a
   `guidance`-form row into the existing `deriveProposals` pipeline. Reuses
   `deriveCorrections`' harness-noise filter, `INTERVENTION_FORM_REGISTRY`, and the
   `frequency`/`baseline`/verdict machinery. Surfaces via `ax improve recommend`; accepts
   via the existing brief. **No new commands, tables, or community layer.** Tests on
   synthetic turn fixtures (directive vs task vs correction vs question).

**v2 (deferred - see §0.3 / §0.4)**

**Local miner**
1. `queries/directive-ngrams.ts` - lift table over `turn` × outcomes (deref-free,
   per-user). Tests on synthetic turn/outcome fixtures.
2. `ingest/derive-directive-candidates.ts` - flag + store candidates (harness-noise
   filtered); recurrence counter.
3. `cli/commands/ax-directives.ts` - `mine --emit-brief` / `list` / `ngrams`; brief
   template.
4. Directive record + `improve` proposal-kind wiring (or `directive` table per Q5);
   accept/lint reuse.
5. Dojo agenda item + escalation rule (memory->hook on recurrence threshold).

**Community layer**
6. Seed pack (`community/patterns/seed.json` + README) - **shipped in this PR**.
7. `cli/commands/ax-patterns.ts` - `list` / `adopt` / `suggest` over the seed pack;
   `adopt` reuses the `improve accept` brief path. *(Immediate-value slice - build next.)*
8. Abstraction + consent-gated contribution (`ax patterns contribute`, profile-publish
   rails), producing a `community/users` data PR.
9. `community-nightly` compile extension producing `community/patterns/trending.json`
   (dedup + threshold + rank); site trending-patterns board beside trending-skills.

**Cross-cutting**
10. Docs gates (cli.md, llms.txt, cli-reference.data.ts, VISIBLE_COMMANDS) for
    `ax directives` + `ax patterns`; MCP read-only views if warranted.
