# Compaction Signal - Design

**Date:** 2026-06-04
**Status:** Approved (design), pending implementation plan
**Scope:** v1 - make context compaction a first-class signal in the ax ingest pipeline.

## Problem

ax ingests transcripts from 5 harnesses (Claude Code, Codex, Pi, OpenCode, Cursor).
Every harness performs **context compaction** when it nears its context window -
summarizing or replacing prior history so the conversation can continue. This is a
high-value agent-experience signal ("how often did this session hit the wall, and
what survived"), yet **all 5 parsers currently drop it**:

- **Claude** - additionally *mis-ingests* the post-`/compact` continuation message
  (`isCompactSummary:true`) as a normal user turn, polluting turn/recall data.
- **Codex** - `type:"compacted"` + `event_msg/context_compacted` both fall through
  the parser's switch.
- **Pi** - `type:"compaction"` entry has no case in `pi.ts`.
- **Cursor** - per-bubble `summarizedComposers[]` marker never read.
- **OpenCode** - no explicit marker; only `step-finish.tokens` (also dropped).

### Evidence (verified against on-disk data, 2026-06-04)

| Harness | Marker | Real-data confirmation |
|---|---|---|
| Pi | `type:"compaction"` | docs (`pi.dev/docs/latest/compaction`) - `CompactionEntry{ summary, firstKeptEntryId, tokensBefore, details.{readFiles,modifiedFiles}, fromHook }`. Trigger: auto when `contextTokens > contextWindow - reserveTokens` (reserve 16384) or manual `/compact`. |
| Codex | `type:"compacted"` + `event_msg/context_compacted` | 55 sessions, 351 events in `~/.codex/sessions`. Paired records (same ts). `payload.{message, replacement_history[]}`. `message` empty on auto-compaction; `replacement_history` 80–186 msgs. |
| Claude | `isCompactSummary:true` user message | 14 sessions in `~/.claude/projects`. `type:"user"` msg carrying summary text in `message.content`. (NB: `type:"summary"` entries, dropped at `transcripts.ts:819`, are leaf conversation-title summaries - a *different* thing, correctly skipped.) |
| Cursor | non-empty `summarizedComposers[]` per bubble | `state.vscdb` - every bubble has `summarizedComposers` array (empty when no compaction). Composer flags `isContinuationInProgress`, `speculativeSummarizationEncryptionKey`. Summary content is **encrypted** (`blobEncryptionKey`). |
| OpenCode | none → `step-finish.tokens` | `opencode.db` - no structural compaction part-type; `step-finish` parts carry `tokens.{total,input,output,cache}`. Boundary only *derivable* by saturation. |

## Goal

Persist compaction as a queryable, typed event for the **4 explicit harnesses**
(Pi, Codex, Claude, Cursor). OpenCode gets the schema field but stays null until a
later derived-inference pass. Fix the Claude continuation-message pollution bug in
the same pass.

## The core abstraction: one event, two models

Compaction takes two fundamentally different shapes. The schema unifies them with a
`strategy` discriminant rather than forcing one model onto the other:

- **summarize-to-text** (Pi, Claude, Cursor) - produces a summary string. Cursor's is
  encrypted, so stored as null with `strategy:"encrypted"`.
- **history-replacement** (Codex) - swaps the whole prior history for a retained
  message set. No summary text; instead a `kept_count`.

## Schema

`packages/schema/src/schema.surql` - new normalized projection table, mirroring the
existing `plan_snapshot` pattern (FK to `session`/`agent_event`, option fields,
JSON-encoded nested data, indexes).

```surql
DEFINE TABLE compaction SCHEMAFULL;
DEFINE FIELD session           ON compaction TYPE record<session>;
DEFINE FIELD agent_event       ON compaction TYPE option<record<agent_event>>;
DEFINE FIELD harness           ON compaction TYPE string;          -- provider name
DEFINE FIELD ts                ON compaction TYPE datetime;
DEFINE FIELD trigger           ON compaction TYPE option<string>;  -- auto|manual|hook
DEFINE FIELD strategy          ON compaction TYPE string;          -- summarize|history_replacement|encrypted
DEFINE FIELD source_confidence ON compaction TYPE string;          -- explicit|derived
DEFINE FIELD summary           ON compaction TYPE option<string>;  -- Pi/Claude; null Codex/Cursor
DEFINE FIELD tokens_before     ON compaction TYPE option<int>;     -- Pi explicit; others derivable
DEFINE FIELD boundary_ref      ON compaction TYPE option<string>;  -- where post-compaction resumes
DEFINE FIELD kept_count        ON compaction TYPE option<int>;     -- Codex replacement_history length
DEFINE FIELD read_files        ON compaction TYPE option<string>;  -- JSON-encoded; Pi details
DEFINE FIELD modified_files    ON compaction TYPE option<string>;  -- JSON-encoded; Pi details
DEFINE FIELD raw               ON compaction TYPE option<string>;  -- JSON-encoded
DEFINE INDEX compaction_session_ts  ON compaction FIELDS session, ts;
DEFINE INDEX compaction_agent_event ON compaction FIELDS agent_event;
```

Each parser also emits a provider event via the existing dual-write substrate:
`AgentEventWrite{ type: "compaction", ts, role: null, text: <summary|null>, metrics: <structured>, raw: <raw> }`.
The `compaction` projection row links back via `agent_event`.

## Per-harness mapping (v1)

All v1 rows: `source_confidence = "explicit"`.

| Harness | Detect | strategy | summary | tokens_before | boundary_ref | kept_count | trigger |
|---|---|---|---|---|---|---|---|
| **Pi** | `type:"compaction"` | summarize | `summary` | `tokensBefore` | `firstKeptEntryId` | - | `fromHook ? hook : (message ? manual : auto)` |
| **Codex** | `type:"compacted"` (+`context_compacted` as corroborating signal) | history_replacement | null | derive from preceding `token_count` event | compacted-entry seq/id | `replacement_history.length` | `payload.message ? manual : auto` |
| **Claude** | `isCompactSummary:true` user msg | summarize | `message.content` | - | msg `uuid` | - | auto (manual `/compact` indistinguishable in transcript) |
| **Cursor** | non-empty `summarizedComposers[]` | encrypted | null (encrypted) | - | bubble id | - | auto |
| OpenCode | *(deferred)* | - | - | - | - | - | - |

Pi's `details.{readFiles,modifiedFiles}` → `read_files`/`modified_files` (JSON-encoded).

## Claude continuation bug fix (in scope)

The `isCompactSummary:true` message is currently ingested as a normal user `turn`.
Change the Claude parser to:
1. Detect `isCompactSummary === true` on a user entry.
2. Route it into a `compaction` event (summary = `message.content`).
3. Exclude it from normal turn ingestion (do not create a user `turn` for it), OR tag
   the turn `message_kind: "compaction_summary"` and skip it from recall/turn-text
   surfaces. **Decision: skip the turn entirely** - it is a synthetic system artifact,
   not a user utterance, and `isVisibleInTranscriptOnly` confirms it is not a real turn.

This removes the recall/turn pollution and is naturally in scope since the Claude
parser is already being modified for compaction.

## Consuming surface (v1)

One CLI read surface to prove the data end-to-end: `ax sessions show <id>` annotates
compaction boundaries inline - where the session compacted, the strategy, and a
summary excerpt (or "history replaced, N kept" for Codex) - plus a per-session
compaction count line. No dashboard timeline or recall integration in v1.

## Parser shape (modular, typed)

Per the project's typed/modular/Effect default, each parser gets a small pure
extractor:

```
extractCompaction(entry, ctx) => CompactionWrite | null
```

`CompactionWrite` is a shared typed shape (in `@ax/lib` or alongside
`provider-events.ts`). Keeps the parser switch-arms thin and each harness's mapping
independently unit-testable.

## Testing

- **Per-harness extractor unit tests** with fixtures captured from real on-disk data
  (Pi/Codex/Claude have live samples; Cursor needs a synthetic fixture with a populated
  `summarizedComposers`). Fixtures committed under each parser's test dir.
- **Integration test**: ingest a multi-compaction Codex session → assert N `compaction`
  rows with correct `kept_count` and `strategy:"history_replacement"`.
- **Claude regression**: assert the `isCompactSummary` message produces a `compaction`
  row and **no** corresponding user `turn`.

## Out of scope (v1)

- OpenCode derived (saturation-inference) boundaries - `source_confidence:"derived"`,
  separate follow-up.
- Reading Cursor's encrypted summary content.
- Dashboard compaction timeline; `ax recall` integration.

## Open questions

None - all design decisions resolved during brainstorming (scope, storage shape,
Claude bug inclusion, v1 surface).
