# Session Timeline - build plan

The "highlight" zoom level between the raw transcript (L0) and the one-line
summary. An ordered, **multi-resolution** view of *what happened* in a session,
derived entirely from already-ingested data - **no LLM**. Built as an Effect
service (`apps/axctl/src/timeline/`) that takes a session id and outputs a
`SessionTimeline`; UI comes later.

## Status

- ✅ v0 service shipped (`feat/session-timeline-service`): types + queries +
  pure `derive` + Effect service + 9 tests. Verified end-to-end on a real
  685-turn session; all 4 failures auto-paired to their fix.
- ✅ 10-session stress test (4 → 45,697 turns) - robust, no crashes, ~90%
  recovery rate. But it surfaced 4 findings (below) that this plan fixes.
- ✅ Provider-shape investigation across all 6 sources - evidence-backed
  mapping (below).

## Findings from the 10-session test (what this plan fixes)

1. **Event volume explodes** - a 45k-turn loop session yields **5,918 events**.
   Not a "highlight". Needs multi-resolution + importance ranking.
2. **Provider skew** - codex `tool_call` events = 0 (filter was Claude-shaped);
   codex tools leaked into `skill_invocation` and hit a 2000 cap.
3. **Correction events miss** - `reaction_event` source too narrow.
4. **Silent LIMIT caps + sparse cost** on the monsters / old sessions.

## Evidence: the 6 sources behave differently

- **6 sources**: claude (1501), claude-subagent (1213, behaves like claude),
  codex (731), pi (5), opencode (3), cursor (2).
- **`invoked` is a fake skill stream** for codex/pi/opencode/cursor - a
  `<provider>:toolName` shadow 1:1 with every tool call. Only claude /
  claude-subagent have real skill invocations. → consume `invoked` for claude
  sources only; drop `^<provider>:` names.
- **File edits live in 2 channels; 3/5 providers lose them**:
  - claude/pi → `edited` edge ✓
  - codex → NO edit tool; edits ride inside `exec_command` (`sed -i`, heredocs,
    `apply_patch` CLI) → classify inside the command.
  - opencode → ingest bug: edit input field is `filePath` (camelCase), not in
    `STRUCTURED_PATH_FIELDS` → no edge.
  - cursor → `_v2` tool names match no shared set → no file evidence.
  → derive `file_edit` per-provider at the `tool_call` layer, not the edge.
- **Segmentation signals** (matrix): time-gaps = only universal boundary;
  commits (claude+codex), compactions (claude+codex), plans (codex=
  `plan_snapshot`, claude=`TodoWrite` tool_call), user-turns (all, thin for
  subagent).
- **Query gotcha**: `produced.in` IS the session (not `.in.session`); use
  captured `<string>session` refs; `count(DISTINCT)` unsupported.

## The shape: 3 zoom levels

```
L0  raw transcript            (exists)            e.g. 45,697 turns
L1  events (important beats)   importance-ranked   ~top 15–30 per segment
L2  segments / phases          the loop's spine    ~N iterations / commits
```

`SessionTimeline` grows a `segments[]`; each `TimelineEvent` keeps `seq` so it
nests into a segment. Importance ranks *within* a segment, so totals stay
bounded regardless of 4 or 45k turns.

## Build steps

### Step 1 - ProviderEventMap (provider-aware classification)
- One provider-keyed classifier `(source, toolCallRow) -> { kind, importance }`.
- Per-provider tool/edit/skill/subagent/noise tables (from the investigation).
- codex: inspect `command_norm`/`command_text` of `exec_command` - `sed`/`tee`/
  `>`/heredoc/`apply_patch` = `file_edit`; else `tool`.
- `invoked` consumed only for claude/claude-subagent.
- **Checkpoint**: re-run the 10-session test - codex/pi tools must surface as
  `tool_call`; `skill_invocation` no longer inflated.

### Step 2 - Segmentation layer (L2)
- Derive segments bounded by, in priority: commit (`produced`) → user-turn →
  compaction → large time-gap (per-provider availability from the matrix;
  time-gap is the universal fallback).
- Each segment: `{ start_seq, end_seq, ts range, title, rollup, outcome }`.
  - title = the user ask (first user turn in span) or commit message.
  - rollup = counts {tools, edits, files, failures, skills} + duration.
  - outcome = did the span end in a commit / green check?
- **Checkpoint**: a 45k loop → ~its iterations, each with a readable headline.

### Step 3 - Importance ranking + caps (L1)
- Rank events within each segment: failures (+recovery) > decisions/plans >
  commits > file_edits (group consecutive edits to same file as "N×") >
  notable tools > skills. Cap to top-N per segment; bucket-summarize the long
  tail ("142 edits across 6 files").
- Replace the silent SQL `LIMIT`s with explicit, logged caps.
- **Checkpoint**: L2 ≤ ~30 segments, L1 ≤ ~30 events/segment, any size.

### Step 4 - Correction + cost robustness
- Correction events: add `intent_kind='correction'` fallback to `reaction_event`.
- Cost: tolerate missing `session_token_usage` (already nullable; just confirm).

### Step 5 - Re-verify
- Re-run the 10-session stress test; confirm bounded output + provider coverage.
- Extend `derive.test.ts` for the provider classifier + segmentation.

## Out of scope (separate)
- **UI** - fed by this service later (the mockup → real component).
- **2 ingest bugs found** (opencode `filePath`, cursor `_v2`) - file as issues;
  they affect the graph broadly, not just timeline.
- **Optional LLM** - a narrative `outcome`/`decision` gloss; the service leaves
  a seam (today: raw last-assistant text).

## Open questions

1. Multi-resolution: ship `segments[]` + `events[]` in one artifact, or expose
   L2 and L1 as separate service methods (lazy L1 per segment)?
2. Segment granularity for loops: one segment per user-turn, or per commit, or
   adaptive (collapse when too many)?
3. Importance cap N - fixed (e.g. 20/segment) or budget-based (total ≤ 300)?
4. File the 2 ingest bugs now, or fold the codex/opencode/cursor file-edit
   recovery into Step 1 and fix ingest separately?
5. Do we want a CLI (`ax timeline <id> --json`) to play with output before UI?
