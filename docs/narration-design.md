# Session narration - design note

Agent-generated, reviewable story of what changed in one session, including
everything a PR diff erases: user directions and corrections, abandoned
attempts, tool failures and recoveries.

## Flow

```
session ends
  └─ ax-narrate skill (skills/narrate/SKILL.md) fires in-context
       │  the agent reconstructs the story from ITS OWN memory of the
       │  session, optionally cross-checking turn seqs via `ax sessions show`
       └─ writes .ax/narrations/<session-id>.json
            └─ ingest picks the file up (planned: narration stage in the
               StageRegistry, same watcher that tails transcripts)
                 └─ studio renders it (NarrationPanel,
                    apps/studio/src/routes/narration-panel.tsx) with
                    onJumpToTurn wiring into the transcript view
```

The generator is the agent that lived the session, not a post-hoc diff
reader: it knows which failure mattered and which retry was noise, and it
can quote the user verbatim because the words are in its context window.

## Schema rationale

Shape: `SessionNarration` (`apps/studio/src/routes/narration-types.ts`),
an extension of plannotator's `CodeTourOutput` (title / intent / before /
after / ordered stops with gist + detail + anchors). What we changed:

- **Provenance anchors, not just diff anchors.** Plannotator anchors only
  carry `file/line/hunk`. Narration stops anchor to six kinds:
  `file_hunk`, `turn`, `user_direction`, `correction`, `tool_failure`,
  `term`. A stop's anchors may span multiple files and multiple kinds -
  the hunk, the correction that caused it, and the failure on the way
  there hang off the same stop.
- **Hunks as old/new fragments, not unified diffs.** Tool calls carry
  verbatim text fragments without file offsets, so the schema stores
  `old_text`/`new_text` and the renderer synthesizes the patch via the
  existing `buildHunkPatch` (same path the review view uses with
  @pierre/diffs). No fake line numbers in the artifact.
- **Turn seqs as the join key.** Every conversational anchor carries a
  `turn_seq`, which is the session graph's native coordinate - rendering
  becomes "jump to turn", and ingest can later edge narration stops to
  `turn` records without re-parsing prose.
- **Header metadata** (`session_id`, `generated_at`, `generator:
  skill|hook`, `model`) so re-narrations and generator comparisons are
  distinguishable artifacts, not silent overwrites.
- **Validation is a plain type guard** (`isSessionNarration`, in the
  `isShareManifest` style): no schema deps, JSON in, narrowed type out.
  The guard enforces the editorial invariants too - non-empty stops,
  non-empty anchors per stop, corrections must carry an `outcome`,
  failures must carry a `recovery`, a `file_hunk` must have at least one
  non-empty side.

## What this captures that PRs miss

- **Corrections**: the user's actual words plus the concrete pivot they
  caused (`quote` + `outcome`). The diff shows the destination; the
  correction shows the steering.
- **Tool failures**: what broke, verbatim, and how the agent got past it
  (`error_excerpt` + `recovery`). The "tests pass" checkmark hides the
  blocked `bun test` hook and the wrapper script that dodged it.
- **Abandoned attempts**: stops or `turn` anchors for work that was
  rolled back - cost that never reaches the final tree.
- **Reading order**: stops are ordered by reading flow (entry point
  first, cause before effect), not by file path or commit order.

## Open questions

- **Hook vs skill timing.** A Stop hook is forbidden in ax (fires per
  turn, blocks the harness). Candidates: explicit skill invocation (now),
  a SessionEnd hook if/when the harness exposes one, or the weekly
  self-improve cron narrating yesterday's sessions cold (worse: no
  in-context memory, would have to reconstruct from the graph). The
  `generator` field already disambiguates.
- **Dedupe across re-narrations.** Same session narrated twice: keep
  latest per `(session_id, generator)`? Keep all and let studio pick?
  Leaning: content-address the file (`<session-id>.<hash>.json`) and let
  ingest tombstone superseded ones.
- **Graph linking.** Proposed tables: `narration` (one per artifact,
  fields = header + title/intent/before/after) and `narration_stop`
  (ordered, JSON-encoded anchors per the v3 nested-object rule), plus
  `narration_stop->anchors_turn->turn` edges derived from `turn_seq` so
  recall can answer "which narrations mention this turn". Remember to
  register new tables in `SCHEMA_TABLES` (insights.ts).
- **Turn seq fidelity.** Narrations written before ingest (the common
  case at stop time) guess seqs from conversation order; ingest could
  re-validate and flag anchors whose seq doesn't exist.
- **Cross-session stories.** A feature often spans sessions; v1 is
  strictly one session per narration, the branch-level story stays in
  `ax-extract-workflow` territory.
