# Spar analytics-exclusion tag

Date: 2026-06-15
Status: final design, pre-implementation
Follows: `docs/superpowers/specs/2026-06-13-ax-dojo-design.md` (dojo/spar), memory
`weighted-query-per-edge-deref-hang`.

## Problem

`ax dojo spar` runs a variant of a landed task in a pinned worktree to compare
against a frozen baseline. That variant session is real traffic and gets ingested
like any other - so it shows up in **behavioral usage analytics** (`ax skills
weighted`, `ax thinking`) and skews "what I actually do." Spar is synthetic
experimentation, not real work; it should be excludable from those signals.

It IS real spend, so it must remain in **cost** analytics (`ax cost
models/sessions/split`) - hiding it there would understate real money. And
`ax dojo spar-score` itself reads the variant via per-session-id metrics
(`fetchSessionMetrics`), which must NOT exclude spar or scoring breaks.

## Decisions (locked)

- **Behavioral-only exclusion.** Exclude spar from `ax skills weighted` + `ax
  thinking`. Keep it in cost. Leave per-session-id queries (`session_metrics`,
  used by spar scoring) untouched.
- **Stamp at spar-score.** `ax dojo spar-score` already resolves the variant
  session id (by worktree cwd, `discoverVariantSession`); it `UPDATE`s that
  session's `labels` to include a spar marker. Post-hoc, deterministic,
  idempotent (re-running spar-score re-stamps the same marker).
- **No `--include-spar` flag in v1.** Exclusion is unconditional on the two
  behavioral surfaces. A flag is a later add if wanted.

## Design

### 1. Schema: `session.labels`

Add to `packages/schema/src/schema.surql` (mirroring the existing `labels`
convention on `agent_session`/`tool`/etc.):

```surql
DEFINE FIELD labels ON session TYPE option<string>;  -- JSON-encoded string[] (e.g. ["spar"])
```

`session` is a normalized top-level table, not a new table, so no
`SCHEMA_TABLES` registration is needed (that guard is for new tables - memory
`schema-tables-mirror`). The field is `option<string>`, JSON-encoded like every
other `labels` field (schema rule of thumb: nested → JSON string in v3). Existing
rows read `NONE`.

### 2. Stamp at spar-score

In `apps/axctl/src/dojo/spar.ts` (the spar-score path), after the variant session
id is resolved, stamp it:

```surql
UPDATE $sessionId SET labels = <string>[ "spar" ];
```

Implementation notes:
- The marker is the JSON-encoded array `["spar"]` (a string field). Use the
  same JSON-encode helper the ingest path uses for other `labels` fields so the
  on-disk shape matches (a JSON string, not a native array).
- Merge-safe: if the session already has labels, union in `"spar"` rather than
  overwrite. v1 spar sessions have no prior labels, but the stamp should read →
  parse → add-if-absent → write to avoid clobbering future labels.
- Stamp only the **variant** session (the one discovered in the spar worktree),
  never the baseline (the baseline is real landed work).
- Idempotent: stamping an already-`["spar"]` session is a no-op.

### 3. Shared exclusion helper

New `apps/axctl/src/queries/spar-sessions.ts`:

```ts
/** Record-ids of sessions tagged as spar variants (behavioral-analytics exclusion). */
export const fetchSparSessionIds = (): Effect.Effect<readonly string[], DbError, SurrealClient> =>
  // SELECT id FROM session WHERE labels != NONE AND string::contains(labels, 'spar')
  // Flat id list - cheap, no graph traversal.
```

This returns a small array of session record-ids. Both behavioral surfaces use
it and exclude with a **flat `NOT IN`** - deliberately deref-free to respect
memory `weighted-query-per-edge-deref-hang` (no `in.session.labels` deref inside
the 87k-row `invoked` aggregate).

### 4. `ax skills weighted` exclusion

In the weighted aggregate (`apps/axctl/src/cli/commands/skills.ts`, the
`FROM invoked` aggregate, ~line 122), add a flat exclusion bound as a param:

```surql
... FROM invoked WHERE in.session NOT IN $sparSessions ...   -- $sparSessions = fetchSparSessionIds()
```

`NOT IN` against a flat array of record-ids is a primitive comparison, NOT a
per-edge deref - safe for the 87k-edge scan. When `fetchSparSessionIds()` is
empty, pass `[]` (NOT IN [] excludes nothing). Apply the same bound to any
sibling per-window invoked counts in that command that feed the ranking.

### 5. `ax thinking` exclusion

`apps/axctl/src/queries/thinking-analytics.ts` joins per-session turn aggregates
to `SESSION_MODELS_SQL` in JS. Exclude at the join: drop sessions whose id is in
`fetchSparSessionIds()` before aggregating totals. (Simplest: fetch the spar id
set, then `.filter()` the session-keyed rows in the existing JS join - no SQL
change to the turn scan needed.)

## Out of scope / later

- `ax dispatches` spar exclusion (subagent-focused; a spar variant's child
  dispatches are marginal - adopt the helper later if it matters).
- `--include-spar` flag.
- Excluding spar from `ax recall` / wrapped / profile.
- Ingest-time tagging (rejected: needs a marker-file convention + pipeline
  change; spar-score post-hoc stamp is simpler and sufficient).

## Verify

- Unit: `fetchSparSessionIds` query shape; the spar-score stamp UPDATE
  (merge-union, idempotent) via the existing spar test layer.
- `ax thinking` drops a spar-labeled session from totals (test layer with a
  spar + non-spar session).
- `ax skills weighted` excludes invocations from a spar session (test layer).
- `bun run typecheck`, touched-package `bun test`.
- Manual: tag a known session `["spar"]`, confirm it leaves `ax skills weighted`
  / `ax thinking` but stays in `ax cost sessions`.

## Module map

```
packages/schema/src/schema.surql                  + DEFINE FIELD labels ON session
apps/axctl/src/dojo/spar.ts                        spar-score stamps variant session labels (merge-union)
apps/axctl/src/queries/spar-sessions.ts            NEW fetchSparSessionIds (flat id list) + test
apps/axctl/src/cli/commands/skills.ts              weighted aggregate: NOT IN $sparSessions (deref-free)
apps/axctl/src/queries/thinking-analytics.ts       drop spar sessions at the JS session-join
```
