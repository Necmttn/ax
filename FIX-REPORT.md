# FIX-REPORT: w1-seam-design review findings

Branch `feat/v2-w1-seam-design`, 5 commits on top of `849b669a`. All five concrete
findings in `/tmp/w1-seam-codex-review.md` (4×P1, 1×P2) are fixed, each test-first.
Nothing was pushed or merged. Scope unchanged: no new capability, no widening.

## The findings, and what each fix actually is

### P1 - Reopen the snapshot after each publish (`seam.ts:363`)

**Confirmed.** The successful snapshot open was memoized for the layer's lifetime.
A publish `rename`s a NEW file over the path, so `ax serve` / `ax mcp` - one
`CacheRead` per process - kept reading the old inode and answered stale data until
restart. The suite even asserted the stale behaviour as intended
("a reader holding the old snapshot keeps reading it across a publish").

**Fix.** Each statement `stat`s the snapshot first and compares
`dev:ino:size:mtime` against the handle it holds; a change reopens under the
existing one-permit gate. The superseded connection is **retired, not closed**: a
statement borrows its handle for its whole duration (`readerOver` now takes a
borrow combinator, not an `Effect` of a connection), and the retired connection
closes when its last borrower lets go - so a read racing the publish never gets
"the connection is closed". A snapshot that cannot be `stat`ed keeps the current
handle rather than tearing a working reader down. A failed reopen leaves the old
handle in place (opened before retiring).

Tests: `a long-lived reader observes a republished snapshot` (three publishes, so a
one-shot reopen fails it too) and `many concurrent queries across a publish all
answer, none on a closed handle` (16 reads racing a republish). Both were **red**
before the fix.

Cost: one `stat` per statement. Bench gate unchanged - BM25 top-20 6ms/150ms,
aggregate join 3ms/200ms, traversals 2ms and 1ms /50ms, all PASS.

### P1 - Set UTC before checking the database clock (`seam.ts:255`)

**Confirmed, and the module's stated reasoning was wrong.** The seam asserted the
clock instead of pinning it, documenting that `SET TimeZone='UTC'` is "unnecessary
and actively broken". Measured against the **official v1.5.5 dylib** (what
`vendor/duckdb/` downloads and what the gates run) under `TZ=Asia/Makassar`:

| connection | `CAST(CURRENT_TIMESTAMP AS TIMESTAMP)` | DDL `DEFAULT CURRENT_TIMESTAMP` |
| --- | --- | --- |
| no `SET` | +480 min (local wall time) | +480 min |
| `SET TimeZone='UTC'` | 0 | 0 |

So on that build the statement succeeds and IS necessary; the icu-less claim held
only for ax's own `scripts/build-duckdb.sh` output. Asserting alone converted a
wrong timestamp into a **refusal of every write** on any non-UTC host - reproduced
exactly: `refusing to write: ... a gap of 480 minutes`.

**Fix.** `pinUtc` runs `SET TimeZone='UTC'` on every seam connection (read and
write), tolerating failure - the only build that rejects the statement has no
time-zone database and is already UTC - and `assertUtcClock` then measures the
property on every write connection, so a build that defeats the pin is still a
loud typed refusal. The old "the SET is broken" reasoning is retracted in place in
both the module header and plan D4.

**The old TZ test was vacuous.** Setting `process.env.TZ` inside a running test
changes nothing DuckDB sees - measured: `current_setting('TimeZone')` stays `UTC`
and the skew stays 0 - so it passed whatever the seam did. The contract now lives
in `packages/lib/src/duckdb/seam-utc.test.ts`, which **re-execs itself** with `TZ`
in the child's environment and asserts a stamped write, a DDL-default column, a
read connection's `CURRENT_TIMESTAMP`, and a write/read round trip. Pre-fix: 4 of
5 child cases failed with the 480-minute refusal.

### P1 - Route recall without the Surreal layer (`cli/index.ts:235`)

**Confirmed** on both counts named: the command still declared `recall: "db"`, and
default scope resolution still ended in `resolvePwdRepository`'s `SurrealClient`
lookup.

**Fix.**
- `"cache"` joins `CommandRuntime`. `withCache` provides `CacheRead` + `AxConfig` +
  platform + `ProcessService` + the throwing no-DB `SurrealClient` proxy (extracted
  and now shared with `withoutDb`). No `AppLayer`, so no connect; no
  `withIngestStalenessPreflight`, which is itself a Surreal query.
- `pwd.ts` splits: `resolvePwdIdentity` is git-only, `resolvePwdRepository` is that
  plus the Surreal existence check - unchanged for its other callers.
- `apps/axctl/src/queries/repository-scope.ts` is the cache-side lookup. It finds
  the row by the DDL's identity columns in `chooseIdentity`'s own ranking
  (`remote_url` → `initial_commit` → `root_path`) instead of constructing an id:
  DuckDB row ids are content-hashed by a git writer wave 2 has not written yet, so
  a constructed id would be a guess. It returns the **row** id, which is what
  `session.repository` holds - the git-derived Surreal key does not. Unknown
  repository falls back to `--scope=all`; an explicit `--scope=here` is honoured
  with a stderr note saying why it will be empty.

Proof is out of process, because an in-process test is handed the layers either
way: `apps/axctl/src/cli/recall-no-surreal.test.ts` spawns the real CLI entrypoint
with `AX_DUCKDB_SNAPSHOT` on a published fixture and `AX_DB_URL` on a dead port, so
it cannot pass by finding a running local daemon. Verified to bite: with the
manifest reverted to `"db"`, all three cases fail on 5.5s connect timeouts
(reverted and restored in one call).

### P1 - Verify the lock file before granting write access (`ingest-lock.ts:269`)

**Confirmed.** `ingestLockHeldHere` answered from the process-wide holder `Map`
alone, which answers a different question ("did this process take a lock here and
not release it"). A lock taken over by another process (invariant 5), removed, or
corrupted still read as held, because the `Map` holds the token *we* minted - and
the seam then opened the live database while someone else owned it.

**Fix.** It reads the lock file and requires the on-disk token to still be the
registered one; missing, corrupt, or foreign-token is `false`. Still a re-check at
write time, not a guarantee for the write's duration - the two flock-class
residuals (#789) are untouched and still documented.

Tests: four cases in `ingest-lock.test.ts` (takeover / removed / corrupt revoke it;
a byte-identical rewrite does not) plus a seam-level
`refuses when another process has taken the lock over mid-run`. All red before.

### P2 - Add recipes for the recall fixture tables (`stable-id.ts:219`)

**Confirmed.** The fixture writes six tables; only `session` and `turn` had
recipes.

| table | recipe |
| --- | --- |
| `commit` | `repo` + `sha` (the `commit_sha_uq` index); never the commit `ts` |
| `skill` | the name alone (`skill_name_uq`); never `dir_path` (absolute path) |
| `invoked` | `edgeRowId(turn, skill, JSON args)` - args discriminates two invocations of one skill in one turn, matching what the Surreal writer keyed on |
| `has_content` | `edgeRowId(tool_call, content_type)` - one classification per pair, so no discriminator |

`commitRowId` / `skillRowId` ship with them; the edges use the existing
`edgeRowId` rule. The derived todo set shrinks by four, and a new coverage test
asserts no table with a wired writer remains in it.

## Gates (this worktree, on the committed tree)

```
bun run typecheck                                   -> exit 0
bunx tsc --noEmit -p tsconfig.json                  -> exit 0
TZ=UTC AX_DUCKDB_DYLIB=vendor/.../libduckdb.dylib AX_DUCKDB_BIN=/tmp/duckdb \
  bun test packages/lib packages/schema apps/axctl/src/queries
                                                    -> 1355 pass, 0 fail, 0 skip
bun run check:no-node-fs                            -> clean (666 files, 0 banned)
```

Beyond the required set:

```
bun test apps/axctl                                 -> 4337 pass, 9 skip, 0 fail
bun test <the 6 suites touched by these fixes>      -> 96 pass, 0 fail
bun scripts/bench/run.ts (mini fixture)             -> every metric PASS
```

No suite is loudly skipped: the dylib resolves, so `seam-utc`, `repository-scope`
and `recall-no-surreal` all run. (The 9 skips in `apps/axctl` are the pre-existing
`AX_E2E_DB=1` live-SurrealDB suites.)

## Notes and residuals

- **Test-helper placement.** `apps/axctl/src/testing/cache-fixture.ts` is new: two
  suites need a real published snapshot, and `check:no-node-fs` scans non-test
  files, so it is Effect-native (`Path.Path`, caller-supplied temp dir). The
  pre-existing inline fixture in `dashboard/recall.test.ts` was left alone rather
  than churned into it.
- **`ax serve` / `ax mcp` still route through `AppLayer`.** They already merge
  `CacheReadLive`, so the reopen fix reaches them, but flipping them off Surreal is
  wave-2/3 work, not this fix round.
- **The `repository` table has no natural-key recipe yet**, deliberately: this
  chunk wires no writer for it, and the lookup above is written so it does not need
  one. The wave-2 git-ingest chunk adds it.
- **Two flock-class lock residuals (#789) remain**, unchanged: the takeover removes
  by path, and `staleMs` is a heuristic, not proof.
