# CI-FIX-REPORT - PR #798, run 31862147976

Branch: `feat/v2-w1-seam-design` · worktree `.claude/worktrees/w1-seam-design`
Status: fixed, committed, **not pushed, not merged**.

## Summary

36 tests failed in CI for one reason, and it was not the reason the brief assumed.
The brief said "CI has no DuckDB dylib/snapshot". CI *did* get a working
libduckdb - it just got the **wrong one**. All 36 failures are a single error:

```
error: IO Error: Extension "/home/runner/.duckdb/extensions/v1.5.5/linux_amd64/fts.duckdb_extension" not found.
Extension "fts" is an existing extension.
Install it first using "INSTALL fts".
  sql: "LOAD fts",
```

ax runs on its **own** DuckDB v1.5.5 build with the `fts` extension linked
statically. The upstream release artifact cannot `LOAD fts` at all. CI provisioned
no DuckDB, so `resolveTestDylib` fell through to its last resort - downloading the
upstream artifact - and every FTS-dependent suite died on an extension error while
looking like 36 unrelated product bugs.

## Root cause

Three facts compose into the failure.

**1. The design.** `scripts/build-duckdb.sh` builds DuckDB v1.5.5 with
`CORE_EXTENSIONS='json'` plus `scripts/duckdb/extension_config_local.cmake`, which
registers `fts` **without** `DONT_LINK` so it links statically. The script's own
air-gap smoke proves `LOAD fts` works with `autoinstall_known_extensions=false`,
`autoload_known_extensions=false` and every proxy pointed at a dead port. The
doctrine is written into `packages/lib/src/duckdb/fts.ts`: *"`LOAD fts`, never
`INSTALL fts`"*, because `INSTALL` reaches the extension repository over the
network on a load-bearing local path.

**2. The provisioning gap.** `.github/workflows/ci.yml` never built or downloaded
DuckDB. `.github/workflows/build-duckdb.yml` is `workflow_dispatch`-only and says
so in its own header: *"nothing consumes these artifacts yet"*. Wave 0's
acceptance for `w0-dylib-ci` was only "local script produces a dylib that passes
the air-gap smoke; workflow YAML lints" - CI wiring was never part of it. Wave 1
then added tests that require FTS. The seam between those two chunks is the bug.

**3. The resolver hid it.** `resolveTestDylib` answers "is there a libduckdb?" and
every suite treated that as sufficient. Its fallback chain is
`AX_DUCKDB_DYLIB` → custom build → vendor cache → **download the upstream release**.
That last step returns `{ ok: true }` for a library that cannot do the one thing
the cache depends on. Nothing skipped, nothing warned; 36 suites just ran against
the wrong library.

### Why it passed locally - the part that matters most

The suites were green on this machine. Not because provisioning was right, but
because the machine is polluted:

```
$ ls ~/.duckdb/extensions/v1.5.5/osx_arm64/
fts.duckdb_extension
fts.duckdb_extension.info
```

A box that has ever run `INSTALL fts` keeps the extension in `~/.duckdb`, where
**any** dylib picks it up. Proof, with the same upstream binary, varying only HOME:

```
$ HOME=$(mktemp -d) /tmp/duckdb -batch <<< 'LOAD fts; SELECT 1;'
IO Error: Extension ".../fts.duckdb_extension" not found.
Install it first using "INSTALL fts".        # ← exactly the CI error

$ /tmp/duckdb -batch <<< 'LOAD fts; SELECT 1;'
FTS-OK                                        # ← the developer's HOME
```

So the local green and the CI red were both artifacts of the environment, and
neither was about the code under test. `LOAD` alone never auto-installs (verified
on a clean HOME with defaults), so there is no hidden network path in production -
the gap is confined to test/CI provisioning.

### Why suites that never search text also failed

`publishCacheFixture` (`apps/axctl/src/testing/cache-fixture.ts:79`) calls
`buildFtsIndexes` for **every** fixture. So `resolveCacheRepository`, which only
does repository lookups, needs an FTS-capable dylib too. That is why the blast
radius was four files, not one.

## The fix

### 1. CI provisions the real artifact (`.github/workflows/ci.yml`)

A new `duckdb` job builds DuckDB v1.5.5 via `scripts/build-duckdb.sh` and hands it
to `verify`:

- **Cached** on `hashFiles('scripts/build-duckdb.sh', 'scripts/duckdb/extension_config_local.cmake', 'scripts/smoke-duckdb-dylib.ts')`. The pinned DuckDB commit and the fts pin both live in those files, so a version bump busts the key and nothing else does.
- **Air-gap smoked on every run, cache hit included.** `scripts/smoke-duckdb-dylib.ts` sets `autoinstall/autoload=false` and `custom_extension_repository=''`, so it proves *static linkage* rather than a populated `~/.duckdb`. A poisoned or truncated cache entry fails there with one clear error instead of downstream as N mystery failures.
- **Saved only after the smoke passes**, so a bad build never becomes the cached answer for every later run.
- `verify` gains `needs: duckdb`, downloads the artifact to `dist/duckdb`, `chmod +x`es the CLI binary (`upload-artifact` drops the executable bit, and `duckdbBinPath`'s `isExecutableFile()` would then silently fall through to PATH), and re-asserts the smoke before `bun test`.
- `verify` sets `DUCKDB_DIST_DIR` - one knob both resolvers honour (`resolveTestDylib` and `scripts/bench/duckdb-bin.ts`), so no test can silently reach the upstream download - and `AX_DUCKDB_REQUIRE_FTS=1`.

### 2. The resolver stops conflating availability with capability

`packages/lib/src/testing/duckdb-dylib.ts` gains a probed capability answer:

- `probeFtsCapable(path)` issues `LOAD fts` **exactly as `buildFtsIndexes` does**, no air-gap pragmas. Probing differently from the code under test is how you get a probe that disagrees with reality; whether the *shipped* artifact links fts statically is a different question, and the build script's smoke is what answers it.
- `decideFtsGate(capability, required)` is a pure policy: capable → `run`; incapable + required → `fail`; incapable + not required → `skip`. The message always carries the original DuckDB reason *and* how to fix it.
- `requireFtsFromEnv` reads `AX_DUCKDB_REQUIRE_FTS`, treating `""`/`0`/`false` as off so a workflow that sets the flag off cannot read as on.
- `duckdbTestSetup(name, { requireFts: true })` applies the gate. The four FTS-dependent suites declare it.

Under the CI flag a provisioning failure now produces **one** actionable failure per
suite instead of every case dying on the same extension error:

```
(fail) repository scope: an FTS-capable libduckdb is required
error: no FTS-capable libduckdb: IO Error: Extension ".../fts.duckdb_extension" not found.
ax links the fts extension STATICALLY into its own DuckDB v1.5.5 build.
The upstream release artifact CANNOT "LOAD fts" - it ships fts as a separate download.
Build the real one:  bash scripts/build-duckdb.sh   (lands in dist/duckdb/, picked up automatically)
Or point at an existing one:  DUCKDB_DIST_DIR=/path/to/dist/duckdb
```

**No test was skipped or weakened.** With a capable DuckDB every case runs; the
gate only fires when provisioning is broken, and then it fails red. Locally,
without the flag, a contributor gets a loud skip instead of being forced into an
hour-long build.

### 3. Regression coverage

`scripts/check-ci-duckdb.test.ts` (new, 12 cases) parses `ci.yml` and asserts the
wiring that no ordinary test can see: the build job exists and is smoked, the
cache is saved *after* the smoke, `verify` needs the job, the upload and download
artifact names match, `DUCKDB_DIST_DIR` and `AX_DUCKDB_REQUIRE_FTS` are set (the
flag checked through the same `requireFtsFromEnv` predicate the harness uses), and
`chmod +x` is present. It also globs every `*.test.ts` reaching `buildFtsIndexes`
or `publishCacheFixture` and requires each to declare `requireFts`, so a new suite
cannot quietly rejoin the 36 - plus a guard that the glob matched something, since
a glob that silently matches nothing would make the rest vacuously true.

`packages/lib/src/testing/duckdb-dylib.test.ts` gains 7 cases over the gate,
`requireFtsFromEnv` parsing, and the probe's error path.

**The guards were proven to bite** (mutate → observe failure → restore, one tool
call): dropping `AX_DUCKDB_REQUIRE_FTS`, dropping `needs: duckdb`, and dropping a
suite's `requireFts` each fail exactly one targeted case; restoring returns 12/12.

## Acceptance evidence

| Gate | Result |
|---|---|
| `bun run typecheck` | exit 0, 0 `error TS` lines |
| `bunx tsc --noEmit -p tsconfig.json` | exit 0 |
| `bun run check:no-node-fs` | exit 0 - clean (666 files, 0 banned imports) |
| `bun run check:cli-reference` / `check:site-cli-reference` / `check:record-select` / `check:table-coverage` | exit 0 |
| `bash -n install.sh` | exit 0 |
| `bun test` (repo-wide) | **6148 pass, 15 skip, 0 fail** (631 files) |
| The 4 formerly-failing files | **59 pass, 0 fail, 0 skip** |
| `bun scripts/bench/run.ts` (mini fixture) | all 8 targets **PASS** (re-derive 0.066s/15s, FTS 0.079s/30s, snapshot 0.057s/5s, BM25 7ms/150ms, aggregate 3ms/200ms, traversals 2ms+1ms/50ms, cache 6.76MB/1GB) |

Gate behaviour verified in all three modes, reproducing CI's condition locally with
a clean `HOME`:

| Condition | Result |
|---|---|
| incapable dylib + `AX_DUCKDB_REQUIRE_FTS=1` | 1 loud actionable failure (was 8 cryptic) |
| incapable dylib, no flag | loud skip, 0 fail |
| capable dylib | **12 pass, 0 skip** - everything runs |

**Bonus:** `packages/schema/src/duckdb-load.test.ts` - the test that loads the real
`schema.duckdb.sql` - has been silently skipping in CI all along (no duckdb binary,
none on PATH). `DUCKDB_DIST_DIR` makes it run there now.

## What I could not verify, and the honest costs

- **I did not run the CI build leg.** I cannot execute GitHub Actions from here, and I did not build DuckDB locally (~40–60 min). The workflow's YAML parses (the regression test parses it) and every step is either a standard action or a script this repo already runs, but the first real green is the PR run. Not pushed, per instruction.
- **First-run cost is real.** On a cache miss the `duckdb` job takes ~40–60 min (`build-duckdb.yml` budgets 60 min/leg). GitHub caches written on a PR branch are not readable by *other* PR branches - only caches on the base branch are. So until this lands on the base branch, each PR pays the build once. After it lands, PRs restore in ~1 min. If that is too slow to accept, the alternative is publishing the artifact once as a release asset and having CI download it; that needs a release step this branch does not own.
- **The no-backcompat policy is preserved.** Nothing dual-runs and no SurrealDB path was revived. The upstream-download fallback in `resolveTestDylib` is untouched *as a fallback* - it is still useful for the many DuckDB suites that never touch FTS - but it can no longer masquerade as FTS-capable.

## Concerns (not fixed, deliberately - noted rather than widening the chunk)

1. **`scripts/bench/run.ts:211` issues `INSTALL fts`** - a network call, and the exact thing `fts.ts` argues against. `bench.yml` downloads the *upstream* CLI, so bench measures FTS build on a dynamically-loaded extension rather than the shipped static one. It is not broken and the timings are probably comparable, but it is the same false-provenance pattern that caused this incident. Pointing `bench.yml` at the custom artifact would close it.
2. **`build-duckdb.yml` still builds a 3-platform matrix nothing consumes.** CI now builds its own linux-amd64 copy. Those two should converge on one artifact source once `c-binary-embed` wires a release step.
3. **The gate's fail-mode skips the suite's real cases** and registers one failing test in their place. That is deliberate - one actionable error beats 36 identical cryptic ones - but it does mean a provisioning failure reports as 1 failure, not 36.
