# Onboarding as a help-then-contribute loop

**Date:** 2026-06-16
**Status:** design, pending review

## Problem

The "give this to your agent" onboarding prompt is a one-way, happy-path
script: install → ingest → label → show → next step. Two structural gaps:

1. **It drifts.** The prompt lives in two hand-maintained copies - the canonical
   `AGENT_ONBOARDING_PROMPT` (`packages/lib/src/agent-onboarding.ts`, post-install:
   `ax setup` + install.sh) and an inline duplicate in the landing copy button
   (`apps/site/app/components/landing-v2/dashboard-preview.tsx`). They have
   already diverged in wording, and the original design doc
   (`2026-06-07-agent-driven-first-ingest-design.md`) references a stale dashboard
   port (8520 vs the shipped 1738).

2. **It has no failure or feedback path.** When install breaks, data is missing,
   a number is wrong, or the agent spots a rough edge, the prompt has nothing to
   say. The run either silently degrades or stops. ax gets no signal back, and the
   user gets no route to contribute the fix.

The motivating case (real, 2026-06-16): a user runs a `/create-pr` command that
fans out ~10 verification agents, plus a stack of verification hooks
(rubocop-check, forbidden-colors, emdash, etc.), plus a `frontend-qc` agent that
"runs all the time." ax's report under-counts his verification activity -
"frontend-qc runs all the time, not seeing it in the report." **ax cannot
self-detect this.** Only the human, checking a reported number against their own
reality, catches it. The onboarding flow walks right past the single best moment
to surface it.

## Goal

Make onboarding a **two-way loop**: ax helps the user (install → ingest →
facts → label), and whenever a step fails, a reported fact is wrong, or the
agent spots a clear improvement, the agent - with explicit, per-artifact consent
- drives the user to **contribute the fix back**: a GitHub issue on
`github.com/Necmttn/ax`, optionally backed by a redacted shared session. One
source of truth, no drift. The "runs locally, you review every change" promise
is preserved: contribution is the first thing that ever leaves the box, so it is
always opt-in and shown in full first.

## Decisions

- **Single source.** `packages/lib/src/agent-onboarding.ts` is the only copy.
  Make it dependency-free (inline the dashboard port literal). Export two
  strings: `AGENT_ONBOARDING_PROMPT` (body) and `AGENT_ONBOARDING_WITH_INSTALL`
  (install prefix + body). The site imports the string from
  `@ax/lib/agent-onboarding` - a bare string tree-shakes with no `@ax/lib`
  runtime weight. Delete the inline `AGENT_PROMPT` in `dashboard-preview.tsx`.

- **Contribute scope = B (failures + improvement signals + interview).** Triggers
  are: (a) a step fails; (b) a reported fact is wrong or surprising to the user;
  (c) the agent notices a clear improvement / confusing output. Not "every
  surprise" (too noisy), not "hard failures only" (misses the misclassification
  class). When triggered, the agent **interviews** the user 2–3 sharp questions
  to pin a repro before drafting.

- **Reality-check beat.** After showing headline facts, the agent explicitly asks
  "does this match how you actually work?" with a seeded hint that verification
  activity often hides in PR commands, hooks, and subagents - if a number reads
  low versus the user's gut, that is a likely miss. This is the beat that
  surfaces the misclassification class.

- **Contribution artifact = B (direct file, confirm-before-send).** On a
  warranted contribution the agent drafts the GitHub issue, shows it in full,
  and on an explicit "yes" files it to `github.com/Necmttn/ax` via `gh` (the
  `ax-repo` skill path). For session evidence: `ax share --dry-run` shows the
  redacted gist first → on "yes" → `ax share` publishes → link pasted into the
  issue. No silent publishes; every artifact is shown before it leaves the box.

- **Woven, not a dedicated phase.** The CONTRIBUTE behavior is defined once near
  the top of the prompt as a reusable block ("whenever a trigger fires, do
  this") and referenced inline at the steps that can trigger it. Catches
  failures when they happen; the agent does not have to remember 4 steps back;
  the prompt stays short.

- **Verification named as the seeded example, kept generic.** Step 3's hint names
  verification (PR commands / hooks / subagents) as *an* example blind-spot, not
  the only one - primes the exact motivating class without hard-coding ax's
  feedback to one category.

## Components

### 1. `packages/lib/src/agent-onboarding.ts` - single source, two exports

- Drop the `DEFAULT_DASHBOARD_PORT` import; inline the literal `1738` (the file
  becomes zero-dep so the site can import it cheaply). If keeping a named port is
  preferred, re-export it from a zero-dep constants module both can share.
- `AGENT_ONBOARDING_PROMPT`: the body (steps 1–5 below). Used by
  `ax setup --agent-prompt`, install.sh, and `renderAgentOnboarding()`.
- `AGENT_ONBOARDING_WITH_INSTALL`: `const INSTALL_STEP = ...` + body, for the
  pre-install landing paste.
- `renderAgentOnboarding()` unchanged in shape (indented terminal wrapper).

### 2. `apps/site/app/components/landing-v2/dashboard-preview.tsx` - consume, don't copy

- Replace the inline `AGENT_PROMPT` template literal with an import of
  `AGENT_ONBOARDING_WITH_INSTALL` from `@ax/lib/agent-onboarding`.
- Keep `INSTALL_CMD` / `DOCS_URL` only if still referenced elsewhere in the
  component; otherwise move them into the shared module so the install line is
  also single-sourced.
- Verify the marketing bundle does not pull `@ax/lib`'s db/runtime code (the
  import must resolve to just the string export; confirm with a build + bundle
  inspection, since per-file `exports` should tree-shake cleanly).

### 3. The prompt body (new shape)

```
Set up ax for me, end to end. ax is a local agent-experience graph over my
Claude Code + Codex history - it runs locally and I review every change.

CONTRIBUTE-BACK (do this whenever a trigger below fires; never publish anything
without showing it to me first and getting an explicit yes):
  Triggers - a step fails; a fact you report looks wrong or surprising to me; you
  spot a clear bug or improvement in ax itself.
  When one fires: ask me 2–3 sharp questions to pin down what I expected, which
  command/hook/agent is involved, and how often - enough for a repro. Then draft
  a GitHub issue for github.com/Necmttn/ax, show me the full draft, and on my yes
  file it via `gh` (the ax-repo skill). If a session is the evidence, run
  `ax share --dry-run` first, show me the redacted gist, and only publish with
  `ax share` on my yes - then link it in the issue.

1. INGEST - run `ax ingest --dry-run`, tell me the ETA in plain words. Then run
   `ax ingest` in the background with AX_PROGRESS=plain and watch it for progress
   + completion; tell me I can watch it fill live at `ax serve` →
   http://127.0.0.1:1738. On failure or zero data after it finishes → CONTRIBUTE.
   When it finishes, summarize what landed: sessions, turns, top skills/tools.

2. VERIFY - run `ax doctor`. If anything isn't ok, diagnose and fix it, re-run
   until it is. If the cause is a bug in ax (not my environment) → CONTRIBUTE.

3. FACTS + REALITY CHECK - show me the headline facts (sessions, turns, top
   skills + tools). Then ask: does this match how I actually work? Heads-up:
   verification often hides inside PR commands, hooks, and subagents, so if a
   number reads lower than my gut says, that's a likely miss. If I disagree with
   any fact → CONTRIBUTE (the disagreement is the repro).

4. LABEL - run `ax skills classify`; it writes one .ax/tasks/classify-<skill>.md
   brief per skill I use that ax can't role-tag. For each: read the skill, fill
   the YAML (`primary_role:` required; secondary/confidence/rationale optional);
   run `ax roles` to reuse existing labels; then `ax skills lint` to apply. Then
   show `ax skills weighted` + `ax skills config`; tell me what you labeled and
   why, and flag anything marked orphan or out-of-scope. "no unclassified
   skills" is fine.

5. NEXT STEP - recommend 1–2 under-used skills you'd reach for based on what you
   saw, then end with a concrete CTA: the exact command or prompt to run next and
   the outcome it produces.
```

(Exact wording is finalized during implementation; this is the structure +
substance to lock.)

## Data flow

```
ax setup / install.sh / landing copy button
  └─ single source: agent-onboarding.ts (body  ±  install prefix)
       └─ user pastes into Claude Code / Codex
            └─ agent runs steps 1–5
                 ├─ step fails / zero data ─────┐
                 ├─ user disagrees with a fact ─┼─► CONTRIBUTE block
                 └─ agent spots a bug ──────────┘     ├─ interview (2–3 Qs, repro)
                                                      ├─ draft issue → show → yes → gh
                                                      └─ ax share --dry-run → show → yes → publish → link
```

## Error handling / edge cases

- **No `gh` or unauthenticated:** the ax-repo skill already falls back to printing
  a plain GitHub URL the user opens manually. The prompt relies on that fallback;
  it does not assume `gh` is present.
- **User declines a contribution:** the agent records nothing externally and
  continues onboarding. Declining is the default until an explicit yes.
- **False-positive trigger (agent over-eager):** the interview step is the
  gate - if 2–3 questions don't yield a real repro, the agent drops it rather
  than filing noise. Soft "huh" findings that don't survive the interview are not
  filed.
- **Privacy of a shared session:** `ax share` is already redacted; `--dry-run`
  shows exactly what would publish. The prompt never shares without that preview.
- **Compiled-binary live ingest caveat** (from the prior spec) is unchanged: the
  dashboard reflects the growing graph; the rich bar is in the agent-tailed log.

## Testing

- `agent-onboarding.ts`: both exports present; body contains the CONTRIBUTE block
  and steps 1–5; `AGENT_ONBOARDING_WITH_INSTALL` starts with the install step and
  contains the body; no `DEFAULT_DASHBOARD_PORT` import remains (or it resolves
  zero-dep). Snapshot the strings.
- `dashboard-preview.tsx`: imports the shared export, no inline `AGENT_PROMPT`
  literal remains (assert by grep in a test or a lint rule), and the rendered
  copy equals `AGENT_ONBOARDING_WITH_INSTALL`.
- Bundle check: site build succeeds and the marketing chunk does not include
  `@ax/lib` db/runtime symbols (manual/CI grep on the built chunk).
- No behavioral CLI changes - `ax setup`, `ax share`, `ax-repo` are reused as-is;
  no new command, so no new command-docs gate beyond the prompt text.

## Out of scope

- New CLI commands or flags - the loop composes existing primitives (`ax ingest`,
  `ax doctor`, `ax skills *`, `ax share`, the `ax-repo` skill). No `ax contribute`
  command in v1.
- Auto-filing without consent, or any telemetry that leaves the box without a
  per-artifact yes.
- Structured/long interview flows - 2–3 questions to get a repro, no more.
- Wiring `ax dojo draft` (local staging) into the loop - chosen artifact path is
  direct-file (decision B); local-draft staging is a possible later option for a
  softer-severity tier, deferred.
- Changing `ax doctor` / `ax share` internals - used as-is.
