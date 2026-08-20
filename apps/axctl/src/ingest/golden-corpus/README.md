# Golden transcript corpus (#876, v3 plan Phase 0)

One real (sanitized) transcript per provider, committed as a fixture and
replayed through the pure `extract -> to*NormalizedBatch` seam.
`golden/<provider>.batch.json` is the full `NormalizedTranscriptBatch` the
parser produced - the parser CONTRACT. `golden-corpus.test.ts` replays every
fixture and compares row-for-row.

## Why

Parity-by-grep (count + `toMatchObject` shape assertions in the
`*.parity.test.ts` files) cannot see a changed value, a dropped field, or a
reordered id. The corpus can: ANY normalized-output change shows up as a
golden diff in the PR that caused it. The v3 plan gates every later parser
touch (batch writers, SQL models, event tables) on this corpus.

## Layout

- `fixtures/{claude,codex,pi,omp}.jsonl` - sanitized real JSONL transcripts.
- `fixtures/{opencode,cursor}.seed.json` - sanitized real rows from the
  SQLite stores, as diffable JSON. `materialize.ts` writes them into a
  temp SQLite db with the real store's table shapes before extraction
  (`extract*` takes a db path; there is no in-memory seam below it).
- `golden/<provider>.batch.json` - the replayed batch, key-sorted,
  Dates as ISO strings (`serialize.ts`).
- `replay.ts` - fixture content -> batch, one function per provider. The
  test and the harvester share it, so a golden can only come from the
  exact code path the test replays.

## Updating a golden after an INTENTIONAL parser change

```
bun apps/axctl/src/ingest/golden-corpus/harvest.ts regen
```

Commit the diff and explain it in the PR. The diff is the point - never
regenerate to make a red test green without reading what changed.

## Harvesting a new fixture

```
bun apps/axctl/src/ingest/golden-corpus/harvest.ts claude   <session.jsonl>
bun apps/axctl/src/ingest/golden-corpus/harvest.ts codex    <rollout.jsonl>
bun apps/axctl/src/ingest/golden-corpus/harvest.ts pi       <session.jsonl> [--head=N]
bun apps/axctl/src/ingest/golden-corpus/harvest.ts omp      <session.jsonl> [--head=N]
bun apps/axctl/src/ingest/golden-corpus/harvest.ts opencode <opencode.db> --session=<id>
bun apps/axctl/src/ingest/golden-corpus/harvest.ts cursor   <state.vscdb> --composer=<id>
```

Sanitization (`sanitizeText` in `harvest.ts`, applied to DECODED JSON string
values so it can never break a line's JSON-ness):

- your home dir -> `/Users/user`, its Claude-slug form -> `-Users-user`
- emails -> `user@example.invalid`
- `redactShareText` secret patterns (API keys, bearer tokens, `TOKEN=`
  assignments, ...)

The tool then prints a residual-risk scan. It reduces the leak surface; it
does not replace review. **Read the fixture before committing it** - tool
output, prompts, and skill bodies all end up public. A public handle or a
public repo name is fine; private-project internals are a judgment call for
the repo owner.

`--head=N` truncates a JSONL transcript to its first N lines - parsers
accept a prefix (sessions are observed mid-flight in the wild), and it keeps
a multi-MB session's fixture reviewable.
