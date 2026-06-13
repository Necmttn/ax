<!--
TARGET REPO: github.com/anthropics/claude-code
STATUS: DRAFT - do NOT post until the user confirms. This file is for review only.

To file once confirmed:
  gh issue create \
    --repo anthropics/claude-code \
    --title "Subagent model override silently dropped after a continuation boundary (SendMessage follow-up / post-compaction resume)" \
    --body-file docs/findings/2026-06-13-claude-code-model-drop.md
-->

# Subagent model override silently dropped after a continuation boundary

## Summary

When a subagent (Task / Agent dispatch) is given an explicit `model` parameter
(e.g. `model: "sonnet"`), Claude Code applies that model only to the **first leg**
of the subagent's run. If the subagent's work continues past a continuation
boundary - a parent `SendMessage` follow-up to the subagent, or a post-compaction
resume ("This session is being continued from a previous conversation that ran out
of context") - the continued legs silently run on the **parent session's** model
(e.g. a frontier model) instead of the one that was requested.

There is no error and no warning. The override is simply dropped, and the dispatch
still reports success - so the off-model spend is invisible.

## What happened

1. Dispatch a Task with an explicit cheap model (`model: "sonnet"`).
2. The first leg of the subagent honors it - assistant messages carry the requested model.
3. The subagent hits a continuation boundary:
   - the parent sends a follow-up via `SendMessage`, **or**
   - the run is long enough to trigger compaction and resumes with the standard
     "This session is being continued from a previous conversation…" message.
4. From that point on, every assistant message in the child transcript carries the
   **parent's** model, not the requested one - for the rest of the run.

## Expected

The requested `model` override should persist for the **entire** subagent run,
across `SendMessage` follow-ups and post-compaction resumes. A subagent dispatched
with `model: "sonnet"` should run on sonnet until it finishes, regardless of how
many continuation boundaries it crosses.

## Reproduction

1. Dispatch a Task/Agent with an explicit cheap model, e.g. `model: "sonnet"`,
   while the parent session is on a frontier model.
2. Either give the subagent enough work to trigger a compaction, or send it a
   follow-up with `SendMessage` after its first leg completes.
3. Inspect the child transcript and read the per-assistant-message model field
   (`message.model`) around the continuation boundary. It flips from the requested
   model back to the parent's model and stays there.

## Impact

This silently defeats cost routing - including Claude Code's own `model` dispatch
parameter. You request a cheap model, the first leg honors it, then the bulk of a
long task silently bills at the frontier rate. Because the dispatch still succeeds,
nothing surfaces the drop; it's only visible if you read the raw child transcripts
or reconcile per-message model against per-message token cost.

### Quantified (single machine, 30-day window)

These numbers are from **one reporter's machine**, surfaced by an external
telemetry tool that reconciles per-message model against token cost - not an
Anthropic-side measurement. They illustrate the magnitude, not a population rate.

- **66** routed dispatches (each carried an explicit, non-inherit `model`) had child
  legs that ran on a **different** model than requested.
- **$571.52** of spend on those off-model ("dropped") legs.
- Across 5 individually inspected child transcripts, the model-flip timestamp lands
  within seconds of a continuation event in every case.

**Concrete example.** A dispatch ("Implement S2-T4: migrate mutations to bus")
requested `model: sonnet`:

- The sonnet leg ran ~2.9M cache-read / ~25k output tokens (~$1.2).
- The parent then sent a follow-up ("Inline execution - you are the implementer;
  execute your own plan").
- After that follow-up, the session flipped to the parent's frontier model and ran
  ~89.8M cache-read / ~134k output tokens.
- **~$116 of the ~$117 total dispatch cost happened *after* the override was dropped.**

## Evidence / how to verify yourself

Each assistant message in a subagent transcript carries its own `message.model`.
The model value changes at the continuation boundary (the post-compact
"This session is being continued…" user message, or a parent follow-up).

Inspect a child transcript directly:

```
~/.claude/projects/<session>/subagents/agent-<id>.jsonl
```

Walk the assistant entries and watch `message.model`. You'll see the requested
override on the early entries, then a switch to the parent session's model at the
first continuation boundary, persisting to the end of the run.

---

*Surfaced by an external local telemetry tool that reconciles per-message model
against per-message token cost.*
