---
name: ax-narrate
description: Write the agent-generated narration of the current session - the reviewable story of what changed, including what never reaches a PR (user corrections, abandoned attempts, tool failures). Triggers on "narrate this session", "summarize what changed", "write the session story", "narrate what we did", "session narration". Output is .ax/narrations/<session-id>.json for the ax studio narration view. Do NOT fire on "summarize this file" or generic recap questions answered inline - this skill writes a structured artifact.
role: verification
---

# ax:narrate - write the session's story as a structured narration

You were there. This skill turns YOUR OWN memory of the session into a
reviewable artifact: 3-7 stops in reading-flow order, each anchored to
real evidence - code hunks, turn numbers, user quotes, failures. The
point is to capture what a PR diff never shows: the corrections, the
dead ends, the recoveries.

The artifact validates against `SessionNarration` in
`apps/studio/src/routes/narration-types.ts` and renders in ax studio.

## Step 1 - identify the session

- Preferred: `ax sessions here --days=1 --json` and pick the current
  session's id (the one matching this conversation). Use the short id.
- If `ax` is unavailable or the session isn't ingested yet, derive a
  slug: `<repo>-<YYYYMMDD-HHmm>`. Note in `meta` that turn seqs are
  best-effort ordinals in that case.
- If available, `ax sessions show <id> --json` gives you the real turn
  seqs to anchor against. Prefer real seqs over guesses.

## Step 2 - reconstruct the story from your own context

Re-read the conversation in your head before writing anything:

1. What did the user originally ask for? (intent)
2. What existed before, what exists now? (before/after)
3. Where did the user redirect or correct you? EVERY one of these
   becomes a `correction` anchor. No exceptions.
4. Which tool failures actually mattered (changed your approach, cost
   real time, forced a workaround)? Each becomes a `tool_failure`
   anchor. Skip trivial retries that changed nothing.
5. Which attempts were abandoned? They get a stop or at least a
   `turn` anchor - abandonment is part of the story.

## Step 3 - choose 3-7 stops, in reading-flow order

A stop is a LOGICAL unit of change, not a file. If three files changed
for one reason, that is ONE stop with several anchors. Order rules
(stolen from the code-tour playbook because they work):

- Entry point first: the change that, understood alone, unlocks the rest.
- Cause before effect: the correction comes before the code it caused.
- Definitions before consumers: types/schema stops before usage stops.
- Verification last: tests, typecheck, and the failures hit on the way.
- Combine trivial housekeeping into one final stop, or omit it.

## Step 4 - write each stop

- **title**: short and friendly. "Call counts become a char diffstat",
  not "Changes to files-touched.ts".
- **gist**: ONE sentence. Not two. A reader who reads nothing else must
  get the stop from the gist. Conversational, the way you'd say it to
  a colleague.
- **detail**: 2-4 sentences of markdown (paragraphs, `inline code`,
  **bold**). Say WHY the change looks the way it does; "we did X
  instead of Y because Z" is exactly what the reader wants.
- **transition**: a short connective phrase to the next stop; empty
  string `""` for the last stop.
- **anchors**: MUST be non-empty. An unanchored stop is an unsupported
  claim. Anchor kinds:

| kind | required fields | use for |
|---|---|---|
| `file_hunk` | `file`, `old_text`, `new_text`, `label`, opt `turn_seq` | a real code change |
| `code_state` | `artifact`, `label`, `lang`, `code`, opt `turn_seq` | the evolving architecture snapshot |
| `turn` | `turn_seq`, `label` | a plain moment in the transcript |
| `user_direction` | `turn_seq`, `quote` | user steering (not correcting) |
| `correction` | `turn_seq`, `quote`, `outcome` | user correcting course |
| `tool_failure` | `turn_seq`, `tool`, `error_excerpt`, `recovery` | consequential failure |
| `term` | `name`, `definition` | a domain term the story leans on |

### Hard anchor rules

- `file_hunk` carries VERBATIM old/new fragments from the actual edits
  you made - copy the real text, never paraphrase code. Keep hunks
  short (5-15 lines per side); pick the most telling fragment, not the
  whole edit. `old_text: null` for pure insertions, `new_text: null`
  for pure deletions. Never both null.
- Every user correction/redirect in the session gets a `correction`
  anchor with a verbatim (trimmed) `quote` and a concrete `outcome` -
  what actually changed because of it.
- Every consequential tool failure gets a `tool_failure` anchor with a
  real `error_excerpt` and how you recovered (or `"abandoned"`).
- Never fabricate turn seqs. Use `ax sessions show` seqs when you have
  them; otherwise count user turns from the start of the conversation
  and say so in the detail.
- `code_state` is the architecture spine of the narration: pick ONE
  stable `artifact` id (e.g. `"review-architecture"`) and restate the
  FULL snapshot at each stop where the design moved - pseudo-code of
  types/interfaces, how they compose, and the call stack (plan-style:
  `Caller -> Callee // note`). Consecutive snapshots of the same
  artifact animate token-by-token in studio, so KEEP shared lines
  byte-identical between stops and let only the real delta differ - a
  new method, a renamed shape, an added edge case. Use `code_state`
  for the evolving design; use `file_hunk` for one-off code jumps
  (those render as static before/after diffs, not motion).

## Step 5 - emit the artifact

Write `.ax/narrations/<session-id>.json` (create the directory if
needed) with exactly this top-level shape:

```json
{
  "schema_version": 1,
  "kind": "narration",
  "meta": {
    "session_id": "<id>",
    "generated_at": "<ISO-8601 now>",
    "generator": "skill",
    "model": "<your model id>"
  },
  "title": "...",
  "intent": "...",
  "before": "...",
  "after": "...",
  "stops": [ { "title": "...", "gist": "...", "detail": "...", "transition": "...", "anchors": [ ... ] } ]
}
```

Before finishing, self-check against the validator's rules:

- `stops` non-empty (3-7), every stop's `anchors` non-empty.
- Every gist is one sentence; every `correction` has an `outcome`;
  every `tool_failure` has a `recovery`; no `file_hunk` with both
  sides null or empty.
- Strings are plain JSON strings (escape newlines in hunks as `\n`).

Then tell the user where the file landed and give a 2-line summary of
the story you wrote. Do not paste the whole JSON into chat.
