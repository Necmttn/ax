# Dogfood Report — studio transcript tool rendering (v0.17.0)

**Target:** http://localhost:1739 (@ax/studio from main, daemon :1745) · 2026-06-09

## Summary
| Severity | Count |
|----------|-------|
| 🔴 Critical | 1 |

The headline v0.17.0 feature does NOT render on `main`: a producer-path
divergence means `tool_calls` is never produced for the sessions the server
serves. Verified on two sessions via the live API.

### ISSUE-001 🔴 Critical — transcript tool cards / skill+image fold / spawn metrics do not render

**Expected:** transcript view shows unified tool cards, folded skill/image turns,
spawn metrics (verified in the pre-merge worktree).
**Actual:** only plain text turns; legend reads `tool use 0.0% · tool result 0.0%`.

**Evidence (live API on released daemon):**
- `/api/sessions/3155cf27-…/inspect` → total_turns 28, 6 returned, 0 with tool_calls, seqs [4,16,20,21,22,25].
- `/api/sessions/fb1be39a-…/inspect` → total_turns 86, 17 returned, 0 with tool_calls, seqs [4,8,11,…].
- 30 min earlier (pre-merge worktree daemon) same sessions returned JSONL seqs [0,1,2,…] WITH tool_calls and rendered cards.

**Root cause (`apps/axctl/src/dashboard/session-inspect.ts`):**
`fetchSessionInspect` now starts with:
    const graphPayload = yield* fetchGraphSessionInspect(...);
    if (graphPayload) return graphPayload;   // short-circuits
    // ...JSONL path (parseClaudeLine → tool_calls) only runs as fallback
`fetchGraphSessionInspect` (DB/graph path, `transcripts:` source) was added on
main AFTER this branch forked and takes precedence. The tool_calls extraction +
skill/image/spawn pairing were wired into the now-secondary JSONL path. The
graph path does not populate turn-level tool_calls, so the feature is dark for
every session it handles (all ingested sessions).

**Why CI was green:** tests unit-test parseClaudeLine (JSONL) + the React
renderers in isolation; nothing exercises fetchGraphSessionInspect end-to-end.

**Fix (→ v0.17.1):** populate turn-level tool_calls in fetchGraphSessionInspect
(join DB tool_call rows to turns in the ToolCallDto shape, preserving the
skill_context/image adjacency the renderer pairs on) — OR make the JSONL path
take precedence where it carries richer data. The renderer + pairing are correct;
this is purely a producer-data gap on the graph path.
