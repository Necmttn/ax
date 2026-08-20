# fleet run: bug-hunt-ax-2026-08-20 (machine mbp)

## mbp/audit-ingest (codex, gpt-5.6-sol medium)
signal: DONE 3 findings @ 2026-08-20T07:30:27Z

### Final pane read
    36 +
    37 +I did not read every derive module in full. I used write searches and contract tests for the remaining derive modules.

• Ran sed -n '1,240p' REPORT.md
  │ git status --short
  └ ## Content hash reuse drops copied Claude sessions
    - file: apps/axctl/src/ingest/jsonl-work-unit.ts:232
    … +35 lines (ctrl + t to view transcript)
    ?? BRIEF.md
    ?? REPORT.md

─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

• REPORT.md contains three confirmed findings. I will now send the required completion signal.

• Ran echo "$(date -u +%FT%TZ) mbp/audit-ingest DONE 3 findings" >> /tmp/fleet-bug-hunt-ax.signals
  └ (no output)

─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

• Audit complete. REPORT.md contains three confirmed findings.

  All 230 selected tests passed. The required completion signal was sent.

─ Worked for 4m 10s ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────


› Run /review on my current changes

  gpt-5.6-sol medium · Context 57% left · ~/Projects/ax/.claude/worktrees/audit-ingest · gpt-5.6-sol · audit-ingest · 258K window

### REPORT.md (verbatim)
## Content hash reuse drops copied Claude sessions
- file: apps/axctl/src/ingest/jsonl-work-unit.ts:232
- severity: major
- confirmed: yes
- failure scenario: Ingest `session-a.jsonl`. Then copy its bytes to `session-b.jsonl`. The next run skips the new file. Claude uses the file name as the session ID, so `session-b` is absent.
- evidence: A pinned `bun -e` database repro ran `runJsonlProviderFiles` for both paths. Its output was `{"second":{"files":0,"skippedUnchanged":0,"refreshedUnchanged":1},"ids":["session-a"]}`. `transcripts.ts:1272` derives the Claude session ID from the file name.
- suggested fix: Permit cross-path reuse only for import sentinel marks. For normal marks, compare the hash only with the mark for the same path.

## Incremental cache model keeps removed busts
- file: apps/axctl/src/ingest/models/cache-bust-event.sql:49
- severity: major
- confirmed: yes
- failure scenario: A usage row first has a cache miss reason. Reparse sets that reason to null. The model leaves the old bust row. Cost reports and proposal generation use false data.
- evidence: A pinned `bun -e` database repro inserted reason `cold`, ran the model, set the reason to null, and ran it again. The output was `{"before":1,"after":1}`.
- suggested fix: Delete target rows in the active time window before insertion. Execute deletion and insertion in one transaction.

## Window filter creates duplicate objectives
- file: apps/axctl/src/ingest/models/run-evidence-event.sql:140
- severity: minor
- confirmed: yes
- failure scenario: A session has an old task that is its objective. A new task enters a one-day window. The windowed rank selects the new task and keeps the old objective row.
- evidence: A pinned `bun -e` database repro ran a full model with `t-old`. It then added `t-new` and ran with one day. The result was `[{"source_id":"t-new","summary":"follow-up task"},{"source_id":"t-old","summary":"original objective"}]`.
- suggested fix: Rank all task turns for each affected session. Replace that session's objective row with the one selected row.

## Out-of-scope observations
- `apps/axctl/src/otel/correlate.ts` is outside the specified ingest path. I did not audit it.

## Coverage
I read the SQL model runner, all three SQL models, their cutover code, the JSONL work unit, parser paths, and write contracts.

I ran 35 model, watermark, spool, and write contract tests. All tests passed.

I ran 195 Claude, Codex, Pi, OMP, OpenCode, Cursor, parity, watermark, and golden corpus tests. All tests passed.

I ran three minimal DuckDB repro commands with all required environment pins. Each repro confirmed one finding.

I did not read every derive module in full. I used write searches and contract tests for the remaining derive modules.

## mbp/audit-cli-hooks (codex, medium)
signal: DONE 2 findings @ 2026-08-20T07:30:59Z

### Final pane read


─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

• The race reproduces with 20 spawn calls from 20 parallel readers. The normal sequential tests pass. I will now run the scoped hook and MCP test suites.

• Ran audit_data=$(mktemp -d)


• Explored
  └ Read dispatch.ts, merge-verdicts.ts, shim-core.ts, decode.ts, define.ts, encode.ts
    Read sessions.ts
    Read recall.ts
    Search listSessionsNear|repositoryKey in sessions-query.ts
    Read sessions-query.ts

• Ran audit_data=$(mktemp -d)
  │ AX_DUCKDB_DYLIB="$HOME/.cache/ax-duckdb/dist/libduckdb.dylib" AX_DUCKDB_REQUIRE_FTS=1 AX_DATA_DIR="$audit_data" AX_NO_AUTO_INGEST=1 bun test apps/axctl/src/dashboard/sessions-query.test.ts
  │ nav_data=$(mktemp -d)

• Working1:29.928] INFO (#4): fts:

    … +71 lines (ctrl + t to view t

    Ran 42 tests across 2 files58[95.00ms]

### REPORT.md (verbatim)

## mbp/audit-queries (codex, medium)
signal: DONE 6 findings @ 2026-08-20T07:35:01Z - gate: 4/6 orchestrator-confirmed in code, 6/6 repro-pinned

### Final pane read
    - file: apps/axctl/src/dashboard/cost-query.ts:266
    … +56 lines (ctrl + t to view transcript)
    ?? BRIEF.md
    ?? REPORT.md

• Ran echo "$(date -u +%FT%TZ) mbp/audit-queries DONE 6 findings" >> /tmp/fleet-bug-hunt-ax.signals
  └ (no output)

─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

• Audit complete. REPORT.md contains six confirmed findings.

  Four findings have major severity. Two findings have minor severity. No source files changed. The required completion signal is present.

─ Worked for 8m 47s ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────


› Summarize recent commits

  gpt-5.6-sol medium · Context 32% left · ~/Projects/ax/.claude/worktrees/audit-queries · gpt-5.6-sol · audit-queries · 258K window

### REPORT.md (verbatim)
## Cost text search selects an arbitrary session
- file: apps/axctl/src/dashboard/cost-query.ts:266
- severity: major
- confirmed: yes
- failure scenario: Two sessions match the text. A limit of one can return the older session instead of the newest session.
- evidence: The pinned `bun test /tmp/audit-query-limit.test.ts` run expected `["new"]`. It received `["old"]`.
- suggested fix: Rank matching session IDs by session start time before the inner limit. Apply the limit only after all filters.

## LOC text search selects an arbitrary session
- file: apps/axctl/src/dashboard/loc-query.ts:244
- severity: major
- confirmed: yes
- failure scenario: Two edited sessions match the text. A limit of one can include the older session and omit the newest session.
- evidence: The pinned temporary test expected `["new"]`. It received `["old"]` from `fetchLocSummary`.
- suggested fix: Rank matching session IDs before the inner limit. Use the same selected session order as the result surface.

## OTEL coverage includes Codex subagents
- file: apps/axctl/src/queries/otel-rollup.ts:197
- severity: major
- confirmed: yes
- failure scenario: A recent Codex subagent has a UUID session ID. It increases the top-level coverage denominator.
- evidence: The pinned temporary test inserted one `codex-subagent` UUID session. `window_sessions` was `1`, but the correct value was `0`.
- suggested fix: Exclude `claude-subagent` and `codex-subagent` sources in the session window query.

## Recovery median counts one session more than once
- file: apps/axctl/src/dashboard/skills-weighted.ts:294
- severity: minor
- confirmed: yes
- failure scenario: One skill has two recovery edges in one session and one edge in another session. The first session gets double weight.
- evidence: The pinned temporary test used session durations `100` and `1000`. The result was `100`, but the session median was `550`.
- suggested fix: Store a set of session IDs for each skill. Calculate the median from unique skill and session pairs.

## Late inspector pages lose tool calls
- file: apps/axctl/src/dashboard/session-inspect.ts:710
- severity: minor
- confirmed: yes
- failure scenario: A session has more than 4,000 tool calls. A later page shows its turn without the related tool call.
- evidence: The pinned temporary test requested turn 4,001. The returned turn had no `tool_calls` field.
- suggested fix: Query tool calls for the requested turn range. Do not apply a whole-session limit before page selection.

## Inspector totals contain only the current page
- file: apps/axctl/src/dashboard/session-inspect.ts:1073
- severity: major
- confirmed: yes
- failure scenario: A graph session has two five-character turns. A one-turn page reports five total characters instead of ten.
- evidence: The pinned temporary test expected `total_chars` of `10`. It received `5`.
- suggested fix: Calculate full-session totals in a separate aggregate query. Keep page totals separate from full-session totals.

## Out-of-scope observations
The three freshness test failures occur because `AX_NO_AUTO_INGEST=1` disables the behavior that those tests expect.

## Coverage
I scanned all query files and the specified dashboard readers for store, clock, parameter, limit, and null risks.
I ran 617 existing tests across 68 in-scope test files with the required environment pins.
The run had 614 passes. The three failures were the expected freshness conflict described above.
I ran six real DuckDB fixture reproducers in `/tmp/audit-query-limit.test.ts`.
I also ran `check:timestamp-cast`, `check:raw-numeric-cast`, query input tests, and snapshot reader tests.
I did not inspect dashboard writers or ingest code beyond the code flow needed to verify reader inputs.

## mbp/audit-cost (claude opus)
signal: DONE 12 findings @ 2026-08-20T07:40:08Z - gate: 11 confirmed (live-store evidence), 1 argued (Bun.hash); 2 fold into #932/#928; orchestrator verified the critical + catalog findings in code

### REPORT.md (verbatim)
# audit-cost - bug audit report (fleet bug-hunt-ax-2026-08-20, machine mbp)

Repo at v0.40.0, branch `audit/audit-cost-2026-08-20`. All evidence below was
produced READ-ONLY: unit tests under the pinned env, pure-function repro scripts
in `/tmp/axaudit/`, and `duckdb -readonly` queries against
`~/.local/share/ax/ax-live.duckdb`. No source file was edited.

12 findings: 6 major, 6 minor. 11 confirmed, 1 unreproducible-but-argued.

---

## Session cost is priced at the session's LAST model, not per model

- file: apps/axctl/src/ingest/transcripts.ts:1600-1617 (call), apps/axctl/src/ingest/model-pricing.ts:523 (`estimateCost`)
- severity: critical
- confirmed: yes
- failure scenario: a session runs 2M tokens on `claude-sonnet-5` ($3/$15) and
  then 100k tokens on `claude-fable-5` ($10/$50). `writeClaudeTokenUsageRows`
  builds ONE `session_token_usage` row whose `model` is `session.model` - the
  LAST non-synthetic model seen while scanning the transcript
  (transcripts.ts:1025-1027) - and prices the WHOLE summed token pool at that
  one model's rates. The entire sonnet pool bills at fable rates. Every
  session-grain surface then reads that number: `ax cost models`,
  `ax cost sessions`, `ax cost split`, `ax otel`'s transcript cross-check,
  `ax routing impact`, `ax profile`. Model switching is routine (`/model`, the
  documented model-drop on SendMessage/compact continuations, Opus->Sonnet
  fallback), so this is not a corner case.
- evidence: token sums are identical between the two grains, so the comparison
  isolates PRICING, and single-model sessions agree to 0.0% - proving the method
  before applying it to the multi-model group.

  ```
  $ duckdb -readonly ~/.local/share/ax/ax-live.duckdb   # 14d window, source='claude'
  # tokens: sess_tokens 6945975901 == turn_tokens 6945975901, mismatched sessions = 0
  ┌────────────────────────────┬──────────┬────────────────────┬─────────────────┬─────────┐
  │ distinct_models_in_session │ sessions │ session_priced_usd │ turn_priced_usd │ pct_err │
  ├────────────────────────────┼──────────┼────────────────────┼─────────────────┼─────────┤
  │                          1 │       59 │            4175.83 │         4175.83 │    -0.0 │
  │                          2 │        4 │            2714.04 │         2072.74 │    30.9 │
  └────────────────────────────┴──────────┴────────────────────┴─────────────────┴─────────┘
  ```

  4 multi-model sessions are overstated by **30.9% (+$641)**, which is ~9% of the
  whole 14-day claude window. Same tokens, different price: the only variable is
  the model the session pool was priced at.
- suggested fix: price `session_token_usage` by SUMMING the already-correct
  per-model `turn_token_usage` costs (or GROUP the session pool by model before
  calling `estimateCost`), and keep `session_token_usage.model` as a display
  label only.

---

## Ingest prices from the built-in catalog only - the merged catalog never reaches a stored cost

- file: apps/axctl/src/ingest/transcripts.ts:1600, :1641; apps/axctl/src/ingest/codex.ts:1240, :1287
- severity: major
- confirmed: yes
- failure scenario: all four ingest-time `estimateCost({...})` calls omit
  `pricingCatalog`, so `pricingForModel` falls back to
  `builtInPricingCatalog()` (model-pricing.ts:508). The `pricing` stage's whole
  job - fetch litellm + models.dev, merge, UPSERT ~4,900 `agent_model` rows - is
  therefore dead weight for every stored cost. Three consequences:
  (a) a model known ONLY upstream stores `estimated_cost_usd = NULL` forever on
      `turn_token_usage`; `derive-cost-backfill.ts:74` heals only
      `session_token_usage`, so the turn-grain lenses (`ax cost attribution`,
      `ax cost cache`) silently report $0 for it while `ax cost models` reports
      real dollars for the same session;
  (b) upstream >200k long-context tier rates can never apply - the built-in
      catalog carries `*Above200k*` rates for exactly THREE models
      (`gpt-5.6-sol/terra/luna`) and ZERO Anthropic models;
  (c) it is what makes the dated-opus finding below unrescuable at ingest.
- evidence:
  ```
  $ bun /tmp/axaudit/p3.ts
  gemini-3-pro-preview   ingest_total= null  merged_total= 1.56
  grok-4                 ingest_total= null  merged_total= 1.2
  deepseek-chat          ingest_total= null  merged_total= 0.09240000000000002
  claude-sonnet-4-5      ingest_total= 1.2   merged_total= 2.25
  sonnet-4-5 300k ctx: merged(tiered)= 2.25  builtin-only(ingest)= 1.2
  ```
  `claude-sonnet-4-5` at 300k input context: litellm carries the documented
  above-200k tier (`input_cost_per_token_above_200k_tokens: 0.000006`,
  output `0.0000225`), so the merged catalog prices it at $2.25 and the ingest
  path stores $1.20 - a 47% undercount. On this corpus 73,437 turns in 45 days
  carry `prompt_tokens > 200000` (65,607 of them Anthropic; ~$20.9k of spend),
  and no Anthropic tier rate exists anywhere the ingest path can see.
- suggested fix: thread the merged catalog (already loaded by the `pricing`
  stage / available via `loadPricingCatalogForModels`) into the four ingest
  `estimateCost` call sites, and extend `derive-cost-backfill` to
  `turn_token_usage`.

---

## `pricingForModel` prefix chain routes dated opus-4-5/4-6/4-7/4-8 ids to opus-4 rates (3x)

- file: apps/axctl/src/ingest/model-pricing.ts:511
- severity: major
- confirmed: yes
- failure scenario: the fallback chain tests `claude-opus-5` then
  `claude-opus-4`. `claude-opus-4-5-20251101` (the real dated id for Opus 4.5;
  the harness already stamps dated ids - `claude-haiku-4-5-20251001` is 1,246
  rows in this corpus) is not an exact catalog key, falls into
  `startsWith("claude-opus-4")`, and prices at `claude-opus-4` = $15/$75/$18.75
  instead of Opus 4.5's $5/$25/$6.25. A 3x cost overstatement for every turn and
  session on that model. Same for any suffixed/dated `claude-opus-4-6/-4-7/-4-8`
  variant, and for `claude-opus-4-5-thinking`.
- evidence:
  ```
  $ bun /tmp/axaudit/p1.ts        # built-in catalog (== the ingest catalog)
  claude-opus-4-5-20251101       in=15 out=75 cw=18.75
  claude-opus-4-5                in=5  out=25 cw=6.25
  cost opus-4-5 dated: 2.25      cost opus-4-5 exact: 0.75      # 100k in / 10k out

  $ bun /tmp/axaudit/p2.ts        # LIVE merged catalog from ~/.local/share/ax/pricing
  LIVE claude-opus-4-6-20260401     in=15 out=75 src=built_in_catalog_2026-08-06
  LIVE claude-opus-4-7-20260601     in=15 out=75 src=built_in_catalog_2026-08-06
  LIVE claude-opus-4-8-20260801     in=15 out=75 src=built_in_catalog_2026-08-06
  LIVE claude-opus-4-5-thinking     in=15 out=75 src=built_in_catalog_2026-08-06
  ```
  litellm happens to carry `claude-opus-4-5-20251101` verbatim so THAT one key
  resolves correctly in the merged catalog - but the merged catalog is not what
  ingest uses (previous finding), and 4-6/4-7/4-8 are built-in-only entries with
  no upstream row, so no dated form of them can ever be rescued.
  Latent on this corpus today: the harness currently stamps bare
  `claude-opus-4-8`, not a dated form. It bites the day it stamps a date.
- suggested fix: order the prefix rules most-specific-first - add
  `claude-opus-4-5` / `-4-6` / `-4-7` / `-4-8` / `claude-opus-4.1` checks ABOVE
  the `claude-opus-4` catch-all (the gpt-5.6 block already does exactly this).

---

## cache_bust_event's two "independent" prices are bit-identical - the corroboration mint guard is a tautology

- file: apps/axctl/src/ingest/models/cache-bust-event.sql:40-46; guard at apps/axctl/src/ingest/derive-proposals.ts:500-504
- severity: major
- confirmed: yes
- failure scenario: `bust_cost_usd` is `ttu.estimated_cache_creation_cost_usd`,
  which `estimateCost` computes as
  `cacheCreationTokens * pricing.cacheCreationPerMillionUsd / 1e6`.
  `corroborated_cost_usd` is
  `ttu.cache_creation_input_tokens * am.cache_creation_per_million_usd / 1e6`.
  For every model whose rate comes from the built-in catalog - i.e. every model
  in this corpus, because the built-in entries WIN the merge and ingest uses
  only the built-in catalog - `am.cache_creation_per_million_usd` IS
  `pricing.cacheCreationPerMillionUsd`, the token count is the same column, and
  neither the 200k tier nor the fast multiplier is ever active (no Anthropic
  above-200k rates exist; `fastTier` is never passed `true` anywhere in the
  repo). The two expressions reduce to the same float. So guard 1 of the four
  operator-approved minting guards - "the two independent prices must agree
  within +/-25%" - can never fail, and `ax cost cache`'s "corroboration: flat-rate
  recompute agrees within 0.0%" line is the pricer agreeing with itself. The
  guard the spec calls the anti-circularity guard IS the circular one.
- evidence:
  ```
  $ duckdb -readonly ~/.local/share/ax/ax-live.duckdb -c "SELECT count(*) rows_n,
      count(*) FILTER (WHERE bust_cost_usd IS NOT NULL AND corroborated_cost_usd IS NOT NULL) comparable,
      count(*) FILTER (WHERE bust_cost_usd = corroborated_cost_usd) identical,
      ... differing FROM cache_bust_event;"
  ┌────────┬────────────┬───────────┬───────────┐
  │ rows_n │ comparable │ identical │ differing │
  ├────────┼────────────┼───────────┼───────────┤
  │   3103 │       3103 │      3103 │         0 │
  └────────┴────────────┴───────────┴───────────┘
  ```
  3,103 of 3,103 rows equal to the last bit. Zero divergence is not agreement -
  it is the same computation run twice.
- suggested fix: make the corroborating price genuinely independent of the
  pricing catalog - e.g. recompute from the harness-reported OTLP
  `claude_code.cost.usage` for the same session/window, or from a rate frozen at
  ingest time and stored on the row - and treat an exact-equality result as
  "not corroborated" rather than "perfectly corroborated".

---

## `ax routing impact` sums SESSION-grain cost inside an hours-long block window

- file: apps/axctl/src/routing-impact/io.ts:70
- severity: major
- confirmed: yes
- failure scenario: `fetchWindowMetrics` sums
  `session_token_usage.estimated_cost_usd WHERE ts > ? AND ts <= ?`. But
  `session_token_usage.ts` is the SESSION's `ended_at` (transcripts.ts:1244:
  `ts: session.ended_at ?? session.started_at ?? new Date(0)`), so a session's
  entire lifetime cost is stamped at one instant. A 2-hour routing-impact block
  therefore captures 100% of the cost of every session that happened to END
  inside it - including hours of spend from before the block - and $0 from any
  session still running. The `turns` half of the same function counts
  `turn.ts`, which IS event-grain, so the two halves of `workPerWindowPp` are
  measured on different clocks. `costRatio` - the fallback the report prints
  whenever the 5h quota window reset mid-block - is built directly on this.
  Worse, `ended_at` advances as a session grows, so a previously-closed block's
  measured cost changes on the next ingest.
- evidence:
  ```
  $ duckdb -readonly ... # block = 2026-08-18 15:00 -> 17:00 UTC
  ┌───────────────────┬────────────────┬───────────┐
  │ session_grain_usd │ turn_grain_usd │ sess_rows │
  ├───────────────────┼────────────────┼───────────┤
  │           2101.17 │         234.44 │         4 │
  └───────────────────┴────────────────┴───────────┘
  ```
  $2,101 reported for a 2-hour block whose actual turn-grain spend was $234 - a
  **9.0x overstatement**, produced by 4 sessions that merely ended in the window.
- suggested fix: sum `turn_token_usage.estimated_cost_usd` over the block window
  (per-turn `ts`), matching the grain the `turns` count already uses.

---

## `ax otel` coverage counts subagent sessions in the denominator it documents as top-level-only

- file: apps/axctl/src/queries/otel-rollup.ts:199
- severity: major
- confirmed: yes
- failure scenario: the module docstring and the `OtelCoverage.window_sessions`
  field both state "windowed TOP-LEVEL sessions (uuid id); subagents excluded -
  OTLP is emitted at the top-level session, never per-subagent". The query is
  `SELECT id FROM session WHERE started_at > <cutoff>` with NO source filter, so
  every `claude-subagent` / `codex-subagent` row lands in the denominator. Since
  subagents structurally CANNOT have OTLP telemetry, they can only ever depress
  the ratio. On a subagent-heavy corpus the operator reads "2% correlated" and
  concludes the receiver is broken when correlation is actually fine.
- evidence:
  ```
  $ duckdb -readonly ...   # 14d window
  ┌──────────────┬───────────┬────────────┬────────────┐
  │ all_sessions │ top_level │ linked_all │ linked_top │
  ├──────────────┼───────────┼────────────┼────────────┤
  │          507 │       121 │         10 │         10 │
  └──────────────┴───────────┴────────────┴────────────┘
  ```
  `ax otel` reports 10/507 = **2.0%**; the documented metric is 10/121 =
  **8.3%**. 386 of the 507 sessions are subagents (383 claude-subagent,
  3 codex-subagent). A 4.2x understatement of the headline health number.
- suggested fix: add `AND source NOT LIKE '%subagent'` to the coverage session
  query (or reuse `originOfSource` at the read seam), matching the documented
  definition.

---

## `estimateCost` silently drops a component whose rate is null instead of reporting the price as unknown

- file: apps/axctl/src/ingest/model-pricing.ts:586-588
- severity: major
- confirmed: yes
- failure scenario: `totalUsd` is built by `.filter(v => v !== null)` over the
  four components, so a model that is IN the catalog but carries a null rate for
  one component returns a confident number that omits that component entirely.
  `gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `gpt-4.1*` all carry
  `cacheCreationPerMillionUsd: null` in the built-in catalog
  (model-pricing.ts:88, :208, :217, ...) because `withCacheDefaults` (the
  `input * 1.25` fallback) is applied to the litellm/models.dev parsers but NOT
  to the built-in constants. `ax cost routability` reprices Codex routable runs
  down to exactly `gpt-5-nano` / `gpt-5-mini`, so the repriced side is missing
  all of its cache-creation cost and the advertised "est savings" is inflated.
- evidence:
  ```
  $ bun /tmp/axaudit/p4.ts   # 1M prompt / 100k out / 400k cache-read / 500k cache-CREATE
  gpt-5-nano   total= 0.0470  cacheCreationUsd= null  (500k cache-creation tokens billed at NOTHING)
  gpt-5-mini   total= 0.2350  cacheCreationUsd= null  (500k cache-creation tokens billed at NOTHING)
  gpt-5        total= 1.1750  cacheCreationUsd= null  (500k cache-creation tokens billed at NOTHING)
  gpt-5.5      total= 6.2000  cacheCreationUsd= 2.5   (500k cache-creation tokens billed at a rate)
  ```
  500k cache-creation tokens priced at $0.00. At OpenAI's actual gpt-5-nano
  input rate that component alone is $0.025 against a reported total of $0.047 -
  the repriced figure is ~35% low, and the savings delta correspondingly high.
- suggested fix: apply `withCacheDefaults` to `BUILTIN_MODEL_PRICING_CATALOG`
  too, and/or return `totalUsd: null` when a component has real tokens but no
  rate, so an unknown price cannot masquerade as a cheap one.

---

## cache_bust_event never deletes a bust whose source usage row lost its cache_miss_reason

- file: apps/axctl/src/ingest/models/cache-bust-event.sql:48; apps/axctl/src/ingest/models/cache-bust-models.ts:55
- severity: minor
- confirmed: yes
- failure scenario: the model is `INSERT ... WHERE ttu.cache_miss_reason_type IS
  NOT NULL ... ON CONFLICT (id) DO UPDATE`. It has no delete arm. If a
  `turn_token_usage` row is re-parsed (`ax ingest --reparse=claude`, a parser
  fix, a segment import) and its `cache_miss_reason_type` becomes NULL, the row
  simply falls out of the SELECT and the stale `cache_bust_event` row survives
  forever. The only DELETE is the version cutover in cache-bust-models.ts:55,
  which fires on a change to the MODEL SQL - not on a change to the PARSER that
  produces its input. Result: permanently inflated bust counts and bust cost,
  feeding both `ax cost cache` and the mint pipeline's materiality guard.
- evidence: code flow. `cache-bust-event.sql` contains exactly one statement
  (enforced by `runner.ts`'s one-statement contract) and that statement is an
  INSERT; `runCacheBustModels` issues `DELETE FROM cache_bust_event` only inside
  `if (rebuild)`, where `rebuild = stored !== cacheBustModelVersion()` and
  `cacheBustModelVersion()` digests `CACHE_BUST_EVENT_SQL` alone.
- suggested fix: include the parser/reparse generation in the version digest, or
  delete the window's rows whose `id` no longer appears in the source SELECT
  (a `DELETE ... WHERE id IN (SELECT id FROM turn_token_usage WHERE ts >= cutoff
  AND cache_miss_reason_type IS NULL)` companion statement).

---

## Proposal dedupe_sig is derived from `Bun.hash`, which is not stable across Bun versions

- file: apps/axctl/src/ingest/derive-proposals.ts:665-666
- severity: major
- confirmed: no (cannot reproduce without upgrading Bun)
- failure scenario: `dedupeSig` is
  `${form}__${Bun.hash(...).toString(16).slice(0,16)}`. That value is PERSISTED
  in the SQLite judgment sidecar (`proposal.dedupe_sig`) and is also embedded in
  the proposal primary key (`proposalKeyFor` appends `sig.slice(-12)`). `Bun.hash`
  is wyhash with no documented cross-version stability guarantee - the same
  concern CLAUDE.md already records for watermarks ("SHA-256 and never
  `stableDigest`/`Bun.hash` - a bun upgrade would invalidate every mark"). If a
  Bun upgrade changes the hash, every stored `dedupe_sig` stops matching its
  re-derived counterpart: `existingSigs` and `existingCacheLensOpenSigs` both go
  empty, the cache-lens cap (`cap - existingOpenSigs.size`) sees 0 open
  proposals and mints duplicates, and previously REJECTED proposals reappear as
  `open` under new ids (the `existingBySig` status-preservation branch at
  derive-proposals.ts:952 is keyed on the same sig). Unlike a watermark, this
  corrupts the judgment sidecar - the store a cache rebuild is explicitly not
  allowed to lose.
- evidence: code-flow argument. `dedupeSig` -> persisted `proposal.dedupe_sig`
  (`proposalWrite`, line 110/113) -> read back by the `SELECT id, dedupe_sig,
  status, baseline, created_at FROM proposal` at line 808 and by the cache-lens
  cap query at line 921. Every consumer compares a freshly computed sig against
  a stored one. The sibling watermark code in `packages/lib/src/duckdb/watermark.ts`
  uses SHA-256 for exactly this reason.
- suggested fix: switch `dedupeSig` to SHA-256 (as the watermark path already
  did) with a one-time sig-migration pass, so the sidecar's identity does not
  depend on a runtime implementation detail.

---

## `ax cost cache`'s printed deviation uses a different denominator from the guard it cites

- file: apps/axctl/src/cli/commands/ax-cost.ts:647
- severity: minor
- confirmed: yes
- failure scenario: the CLI computes
  `100 * |corroboratedUsd - costUsd| / costUsd` (denominator = the INGEST price)
  and prints "... agrees within X% (+/-25% is the proposal guard)". The actual
  mint guard computes
  `|comparableBustCostUsd - comparableCorroboratedCostUsd| / comparableCorroboratedCostUsd`
  (denominator = the CORROBORATED price, derive-proposals.ts:501-503). The two
  percentages differ whenever the prices differ, and asymmetrically: with
  ingest=$100 and corroborated=$78, the CLI prints 22.0% ("agrees within") while
  the guard computes 28.2% and REJECTS. The line explicitly claims to be
  reporting the guard's number.
- evidence: the two expressions, read side by side (ax-cost.ts:647 vs
  derive-proposals.ts:501-503). Today both read 0.0% because the prices are
  identical (see the corroboration finding), which is why the divergence has
  never been visible.
- suggested fix: export one comparison helper and call it from both sites.

---

## Recurrence guard counts UTC calendar days, which do not line up with any non-UTC operator's workday

- file: apps/axctl/src/queries/cache-bust.ts:265; guard at apps/axctl/src/ingest/derive-proposals.ts:507
- severity: minor
- confirmed: yes
- failure scenario: guard 2 requires `count(DISTINCT CAST(ts AS DATE)) >= 2`,
  documented as a proxy for ">= 2 ingest windows". `ts` is stored in UTC
  (verified: `max(ts)` on `turn_token_usage` = `2026-08-20 02:17` against
  `date -u` = `07:35` and local WITA = `15:35`). For an operator at UTC+8 the
  UTC day boundary falls at 08:00 local, mid-morning - so one continuous local
  workday routinely straddles two UTC dates (false PASS) and two separate local
  workdays routinely share one UTC date (false FAIL). The guard admits and
  rejects on an axis unrelated to recurrence.
- evidence:
  ```
  $ duckdb -readonly ...   # cache_bust_event offenders, 14d
  ┌─────────────────────────────────────────┬───────┬──────────┬────────────┬────────────┐
  │                  name                   │ busts │ utc_days │ local_days │ span_hours │
  ├─────────────────────────────────────────┼───────┼──────────┼────────────┼────────────┤
  │ superpowers:writing-plans               │     5 │        1 │          2 │      14.12 │
  │ superpowers:subagent-driven-development │     3 │        2 │          2 │      27.75 │
  │ grilling                                │     3 │        1 │          1 │        0.0 │
  └─────────────────────────────────────────┴───────┴──────────┴────────────┴────────────┘
  ```
  `superpowers:writing-plans` spans 14.1 hours across two local workdays and is
  REJECTED by the guard (1 UTC day). A false negative on live data.
- suggested fix: count distinct days in the operator's local zone, or replace
  the calendar proxy with a real recurrence signal (distinct sessions already in
  the rollup, or a gap-based burst count).

---

## `ax otel` compares claude-only OTLP cost against all-source transcript cost

- file: apps/axctl/src/queries/otel-rollup.ts:239
- severity: minor
- confirmed: yes
- failure scenario: `otlp_usd` sums only `claude_code.cost.usage` (the docstring
  correctly notes "Claude only - Codex emits no cost metric"), but
  `transcript_usd` comes from `fetchCostModels({ sinceDays })`, which rolls up
  `session_token_usage` across EVERY source - codex, pi, opencode, cursor. The
  two sides of a stated cross-check do not cover the same population, so the gap
  can never be read as a correlation/receiver problem.
- evidence:
  ```
  $ duckdb -readonly ...   # 14d
  transcript_all_sources = 10419.52   claude_only = 10177.53   otlp = 1001.09
  ```
  $242 (2.3%) of the transcript side is non-claude spend that no OTLP number can
  ever account for. Small here only because this corpus is claude-dominated; a
  codex-heavy user sees a much larger unexplained gap.
  (Checked and CLEARED while here: `claude_code.cost.usage` is DELTA temporality
  on this corpus - consecutive points for one session are non-monotonic - so
  `sum(value)` is correct and does NOT double-count a cumulative counter.)
- suggested fix: filter the transcript side to claude sources, or label the row
  as an all-harness total and show the claude subtotal next to the OTLP figure.

---

## `resolveRowCost` never re-prices a partially-priced rollup group

- file: apps/axctl/src/queries/cost-analytics.ts:127-130
- severity: minor
- confirmed: yes
- failure scenario: the read-time self-heal only fires when the AGGREGATE
  `costUsd` is exactly 0 (`if (input.costUsd > 0) return { cost_usd, unpriced:
  false }`). But `resolveRowCost` runs on a GROUP BY model / (origin x model)
  cell summed over many sessions. If ten sessions of a model are priced and one
  is null, the group total is > 0, the recompute is skipped, and the unpriced
  session contributes $0 with `unpriced: false` - a silent partial undercount
  rendered as a complete figure. The all-or-nothing shape the guard assumes is
  exactly what a mid-window catalog change breaks.
- evidence: code flow at cost-analytics.ts:127-130 combined with the
  cell-grain call sites (`fetchCostModels` line 210, `fetchCostSplit` line 424),
  both of which pass a summed cell, not a single row. Not currently observable
  on this corpus (0 unpriced rows in either usage table), which is why it has
  not surfaced.
- suggested fix: carry a `priced_rows` / `unpriced_rows` count out of the SQL
  and recompute (or flag) any cell whose two counts disagree.

---

## Out-of-scope observations

- `apps/axctl/src/ingest/pi.ts` writes `session_token_usage` but no
  `turn_token_usage` rows at all: `pi` sessions read $30.51 at session grain and
  $0.00 at turn grain over 14d, so every turn-grain lens is blind to pi.
- Codex `turn_token_usage` sums to 3.3x its own `session_token_usage`
  ($633.19 vs $193.55 over 14d, per-session join) - the documented per-event
  fragmentation, but the two grains disagree by more than 3x and nothing
  reconciles them; worth its own audit of `codex.ts` usage extraction.
- `MODEL_ALIASES.sonnet` in `queries/reprice.ts:14` points at
  `claude-sonnet-4-6`, which has no catalog entry and resolves via the
  `claude-sonnet-4` prefix rule - it works today only by coincidence of equal
  rates.
- OTLP stamps the 1M-context beta as a distinct model id (`claude-opus-5[1m]`
  appears in `otel_metric_point`), but `normalizeModelName` keeps the `[1m]`
  suffix and `pricingForModel` prefix-matches it to plain `claude-opus-5`, so
  the beta's premium (if any) would be invisible.
- `queries/routability.ts`, `queries/dispatch-analytics.ts` and
  `queries/routing-backtest.ts` all build `ModelPricing` literals with
  `fastMultiplier: 1`; `fastTier` is never passed `true` anywhere in the repo,
  so `pricing.fastMultiplier` and the whole `fast_multiplier` column are dead.
  Not audited further (out of scope).
- `buildOtelSessionIdsQuery(table, days)` ignores its `days` argument (the value
  travels as a bound param instead) - harmless, but the signature lies.

## Coverage

Read in full: `ingest/model-pricing.ts`, `ingest/derive-cost.ts`,
`ingest/derive-cost-backfill.ts`, `ingest/derive-proposals.ts` (cache-lens
block + the `deriveProposals` body), `ingest/models/cache-bust-event.sql`,
`ingest/models/cache-bust-models.ts`, `ingest/models/runner.ts`,
`queries/cache-bust.ts`, `queries/attribution-cost.ts`, `queries/otel-rollup.ts`,
`queries/cost-analytics.ts`, `queries/reprice.ts`, `quota/{schema,cache,quota,format}.ts`,
`routing-impact/{compute,io}.ts`, plus the `cmdCostCache` renderer in
`cli/commands/ax-cost.ts` and the token-usage write sites in
`ingest/transcripts.ts` (1580-1690) and `ingest/codex.ts` (1240-1320).

Ran: `bun test apps/axctl/src/ingest/model-pricing.test.ts
apps/axctl/src/queries/otel-rollup.test.ts
apps/axctl/src/ingest/derive-proposals.test.ts` under the pinned env
(`AX_DUCKDB_DYLIB`, `AX_DUCKDB_REQUIRE_FTS=1`, `AX_DATA_DIR=$(mktemp -d)`,
`AX_NO_AUTO_INGEST=1`) - 101 pass / 0 fail, so every finding above is a gap the
suite does not cover. Four pure repro scripts in `/tmp/axaudit/p{1,2,3,4}.ts`.
Eleven `duckdb -readonly` queries against `~/.local/share/ax/ax-live.duckdb`
(read-only handle; no ingest was running - only `axctl otlpd`).

NOT reached: `queries/routability.ts` (the routability classifier + its Codex
span folding), `queries/dispatch-analytics.ts`, `queries/routing-backtest.ts`,
`queries/image-context.ts`, `metrics/cost-estimate.ts` beyond its call
signature, `quota/quota-env.ts` (keychain/token path), `routing-impact/state.ts`
and `format.ts`, and the DuckDB `.duckdb.test.ts` fixture suites for cache-bust
and attribution - all either outside the scope pin or not required to settle a
finding.

## mbp/audit-cli-hooks (codex, respawn)
signal: DONE 2 findings @ 2026-08-20T07:43:36Z - gate: 2/2 confirmed (dispatcher one orchestrator-verified in code)

### REPORT.md (verbatim)
## Parallel stale readers bypass the spawn debounce
- file: apps/axctl/src/queries/ingest-staleness.ts:197
- severity: major
- confirmed: yes
- failure scenario: Twenty stale readers start together. All readers see no state. Each reader starts an ingest process.
- evidence: `AX_DUCKDB_DYLIB=$HOME/.cache/ax-duckdb/dist/libduckdb.dylib AX_DUCKDB_REQUIRE_FTS=1 AX_DATA_DIR=$(mktemp -d) AX_NO_AUTO_INGEST=0 bun /tmp/freshness-race.ts` prints `spawn calls: 20`. Lines 197-215 perform read, check, spawn, and write without a cross-process lock.
- suggested fix: Use a cross-process lock. Write an atomic claim before the spawn. Expire the claim after a spawn failure.

## A direct guard throw stops later enforcement guards
- file: packages/hooks-sdk/src/dispatch.ts:47
- severity: major
- confirmed: yes
- failure scenario: One matching guard throws before it returns an Effect. A later guard must block the same tool call. The dispatcher rejects first.
- evidence: `AX_DUCKDB_DYLIB=$HOME/.cache/ax-duckdb/dist/libduckdb.dylib AX_DUCKDB_REQUIRE_FTS=1 AX_DATA_DIR=$(mktemp -d) AX_NO_AUTO_INGEST=1 bun /tmp/guard-sync-throw-repro.ts` prints `rejected before blocker: Error: sync boom`. The call to `guard.run(event)` occurs before `Effect.catchDefect`. Claude treats this process failure as non-blocking, so the later block does not run.
- suggested fix: Wrap each `guard.run(event)` call in `Effect.suspend`. Catch the full cause before the next guard runs.

## Out-of-scope observations
- `apps/axctl/src/hooks/dispatch-install.ts:47` does not quote a dispatcher path. A path with spaces produces `Module not found "/tmp/ax"`.

## Coverage
- Read `CLAUDE.md`, `BRIEF.md`, and its addendum.
- Read the CLI manifest, CLI dispatch, freshness drive, MCP roster, MCP runtimes, and hook SDK core files.
- Checked session link construction. Scoped source files use the shared session link functions.
- Ran all hook SDK tests: 206 passed.
- Ran all MCP tests: 32 passed.
- Ran all CLI tests: 697 passed and 2 skipped.
- Ran hook install tests: 33 passed and 4 compiled-binary tests skipped.
- Ran freshness tests with auto-ingest enabled: 13 passed.
- The required `AX_NO_AUTO_INGEST=1` pin disables three positive spawn tests. Those tests passed with `AX_NO_AUTO_INGEST=0`.
- Ran `bun run typecheck`: passed.
- Did not run the skipped live or compiled-binary tests. Did not inspect each CLI formatter line by line.

## mbp/audit-storage (claude opus)
signal: DONE 7 findings @ 2026-08-20T07:46:49Z - gate: 5 repro-confirmed, 2 argued; finding 2 folds into #927 (same root cause, second consequence)

### REPORT.md (verbatim)
# audit-storage - bug audit REPORT

Scope: `packages/lib/src/duckdb/` (seam.ts, spool.ts, watermark.ts, fts.ts,
clone-file.ts, the snapshot publish path in client.ts, binding.ts, query.ts,
clause.ts). Repo at v0.40.0, branch `audit/audit-storage-2026-08-20`.

7 findings: 3 major, 4 minor. 5 confirmed with a real DuckDB / real filesystem,
2 argued from code flow only.

---

## The FTS content digest cannot see a permutation of text across rows

- file: `packages/lib/src/duckdb/fts.ts:83`
- severity: major
- confirmed: yes

### failure scenario

`ftsDigestSql` is

```sql
SELECT 'v2:' || count(*) || ':' || COALESCE(bit_xor(hash(id, COALESCE(text,'')))::VARCHAR,'0') FROM "turn"
```

DuckDB's two-argument `hash(a,b)` combines its arguments so that
`hash(x,y) # hash(z,w) == hash(x,w) # hash(z,y)`. The outer `bit_xor` therefore
does not digest the SET OF ROWS - it digests the multiset of id-contributions
and the multiset of text-contributions independently. Any state change that
permutes `text` values among the same `id` values leaves the digest bit-identical.

Concretely: a session is re-parsed and two turns exchange their text (a parser
ordering fix for interleaved assistant/tool events; a seq-assignment change that
shuffles which text lands on which `turn.id`). `count(*)` is unchanged, the id
set is unchanged, so the digest is unchanged. `buildFtsIndexes` sees
`digestMatches && schemaExists`, logs `fts: turn unchanged, skip rebuild`, and
the FTS index keeps mapping the OLD text to each id. `ax recall` then returns
turn A for a phrase that now lives in turn B - a wrong answer, exit code 0, and
`fts_index_state.built_at` says the index is current. Nothing ever repairs it
except an unrelated write that happens to move the digest, or a
`FTS_DIGEST_VERSION` bump.

### evidence

```
AX_DUCKDB_DYLIB=$HOME/.cache/ax-duckdb/dist/libduckdb.dylib AX_DUCKDB_REQUIRE_FTS=1 \
AX_DATA_DIR=$(mktemp -d) AX_NO_AUTO_INGEST=1 bun test /tmp/axaudit/fts-digest.test.ts
```

The test inserts `('t1','alpha content'),('t2','beta content')`, takes the real
`ftsDigestSql(TURN_FTS_TARGET)`, swaps the two texts with two UPDATEs, and takes
it again:

```
HASH PROBE: [{"ab":"1954589102184931588","ba":"4869898919718446152",
             "x":"7623490177371936092","a":"6631103331519010776","b":"3876045343673451140"}]
digest before swap: [{"digest":"v2:2:7677322021377040942"}]
digest after swap:  [{"digest":"v2:2:7677322021377040942"}]
SAME DIGEST? true
digest after real edit: [{"digest":"v2:2:2605940342432588978"}]
```

`ab != ba` and `x != ab`, so `hash(a,b)` is not a naive XOR of the two argument
hashes - yet the row-level swap is still invisible. The control (a genuine
single-row edit) does move the digest, so the formula is not simply broken; it
has exactly this blind spot.

### suggested fix

Hash ONE value per row, not two columns: `bit_xor(hash(id || '\x1f' ||
COALESCE(text,'')))`, and bump `FTS_DIGEST_VERSION` to `v3` to force the
one-time fleet rebuild the module already documents as the escape hatch.

---

## A byte-identical transcript at a new project path is never parsed, so path-derived columns go permanently stale

- file: `packages/lib/src/duckdb/watermark.ts:305`
- severity: major
- confirmed: yes

### failure scenario

`knownContentSha(sha)` answers "bytes with this hash were already fully ingested
under this source kind", and the jsonl work-unit uses it as a licence to SKIP
THE PARSE for a file at a path that has never been parsed
(`apps/axctl/src/ingest/jsonl-work-unit.ts:232-245`):

```ts
const stored = wm.storedSha(candidate.path);
const known = contentSha !== null &&
    (stored === contentSha || (stored === null && wm.knownContentSha(contentSha)));
if (known) { refreshedUnchanged += 1; yield* wm.commit(...); return; }
```

That is only sound if a parse is a pure function of the file's bytes. It is not.
`apps/axctl/src/ingest/transcripts.ts:1000` writes

```ts
project: deriveProject(path, projectDir),
```

and `deriveProject` (transcripts.ts:167-171) returns `path.basename(transcriptDir)` -
the `~/.claude/projects/<slug>` directory name, a pure PATH-derived value with no
representation in the file's bytes.

So: a Claude project directory is renamed / restored / resynced (exactly the
mtime-churn and resync cases #900 was built for), or a transcript arrives under
a second slug with identical bytes. The fast (mtime,size) tier misses because the
path is new; the durable tier hashes, finds the sha already known from the OLD
path's mark, refreshes the mark and returns. The session row keeps the OLD
`project` forever. `ax sessions here`, `ax ingest here`, and every
project-scoped query answer against a slug that no longer exists on disk, with
no error and no re-derive path short of `AX_REDERIVE_CLAUDE=1`.

Same mechanism, worse variant (not reproduced here): if anything ever deletes
graph rows while leaving `ingest_file_state` intact, `knownContentSha` keeps
returning true and the rows are never rebuilt at all.

### evidence

```
AX_DUCKDB_DYLIB=$HOME/.cache/ax-duckdb/dist/libduckdb.dylib AX_DUCKDB_REQUIRE_FTS=1 \
AX_DATA_DIR=$(mktemp -d) AX_NO_AUTO_INGEST=1 bun test /tmp/axaudit/wm-crosspath.test.ts
```

Two byte-identical files at `<dir>/-Users-x-projA/s1.jsonl` and
`<dir>/-Users-x-projB/s1.jsonl`; only projA has a mark. Fresh `fileWatermark`
with `contentHash: true`, then the work-unit's exact predicate:

```
unchanged(newPath)? false
storedSha(newPath) = null
knownContentSha(sha) = true
=> work-unit would REFRESH-SKIP the parse: true
```

`deriveProject` being path-derived is read directly off
`apps/axctl/src/ingest/transcripts.ts:167-171` and `:1000`.

### suggested fix

Either make the cross-path skip conditional on the path-derived projection being
unchanged (pass the derived project/slug into the mark and compare it alongside
the sha), or restrict `knownContentSha` to `__imported__/` sentinel marks (the
#902 case it was actually built for) and drop the same-machine any-path branch.

---

## `putMany` silently DROPS rows when one batch carries a duplicate id - and which row survives depends on the batch boundary

- file: `packages/lib/src/duckdb/seam.ts:908`
- severity: major
- confirmed: yes

### failure scenario

`insertStatement` emits ONE multi-row `INSERT ... VALUES (...),(...),(...) ON
CONFLICT ("id") DO UPDATE SET ...` per chunk of `PUT_BATCH_ROWS = 500`
(seam.ts:950-955). When two rows in the same chunk share an `id`, DuckDB does
NOT reject the statement - it keeps the FIRST occurrence and discards the rest,
reporting a `rowsChanged` that counts only what landed. No error, no counter, no
log line.

That is the OPPOSITE of the semantics the seam documents ("a re-ingest REPLACES
the row with the same content-hashed id", seam.ts:866-870) and the opposite of
what the spool implements for the same tables ("LAST WRITE WINS PER id",
spool.ts:25-29). It is also position-dependent: two rows with the same id land
in one statement (FIRST wins) or straddle the 500-row chunk boundary (two
statements, LAST wins). Identical input, different stored row, decided purely by
where in the array the duplicate sits.

Reachable path: `writeToolCalls` (`apps/axctl/src/ingest/evidence-writers.ts:222`)
builds `rows.calls` with no dedup, keyed by
`toolCallRecordKey({sessionId, seq, callId})`. With `callId` null that key
degrades to `<session>__seq_NNNNNN` (`packages/lib/src/ids.ts:139-144`) - and
`stable-id.ts:127-133` states outright that "some providers assign the same seq
to more than one parallel tool call in a turn". Two parallel tool calls at one
seq with no provider call id therefore collide inside one `putMany`, and the
second call's `status` / `output_json` (e.g. the one that errored) is silently
discarded. The `edited` / `read_file` / `searched_file` edge batches at
evidence-writers.ts:211-212 are built the same way, also without dedup.

Because `tool_call` IS spooled for claude/codex/pi but NOT for the other stages,
the same duplicate resolves last-wins on one provider and first-wins on another.

### evidence

```
AX_DUCKDB_DYLIB=$HOME/.cache/ax-duckdb/dist/libduckdb.dylib \
AX_DATA_DIR=$(mktemp -d) AX_NO_AUTO_INGEST=1 bun test /tmp/axaudit/dup-id.test.ts
```

Statement shape copied from `insertStatement`:

```
INSERT INTO t (id, v) VALUES (?,?),(?,?),(?,?) ON CONFLICT ("id") DO UPDATE SET v = excluded.v
params: ["a","1", "b","2", "a","3"]

VALUES dup => Success rowsChanged=2
table after: [{"id":"a","v":"1"},{"id":"b","v":"2"}]
```

Three rows in, two stored, `v="1"` (the FIRST `a`) survives, `v="3"` is gone,
and the call reports success. The chunk-boundary half is code flow: seam.ts:950
slices at `PUT_BATCH_ROWS`, and two statements resolve the same conflict
last-wins.

### suggested fix

Dedup by `id` inside `putMany` before chunking, keeping the LAST occurrence
(matching the spool and the documented upsert semantics), and count what was
collapsed the way `nulStripped` counts scrubs so the collapse is never silent.

---

## `walIsQuiescent` fails OPEN on any stat error, so an unreadable WAL licenses the clone fast path

- file: `packages/lib/src/duckdb/clone-file.ts:97`
- severity: minor
- confirmed: yes

### failure scenario

```ts
fs.stat(`${livePath}.wal`).pipe(Effect.map((info) => Number(info.size) === 0), orAbsent(true));
```

`orAbsent` (`packages/lib/src/shared/fs-error.ts:45-50`) catches EVERY
`PlatformError`, not just NotFound - its own docstring says so and warns it is
"NOT for reads whose failure would silently drop real data". This is exactly
such a read: guard (b) of `attemptClone` exists to prove that no committed data
is sitting outside the base file the clone is about to copy. Any stat failure on
`<livePath>.wal` (EIO on that inode, ELOOP, a `BadArgument` reason) is reported
as "quiescent", the clone is taken, and every byte the WAL still held is missing
from the published snapshot - silently, since the clone's sanity check (guard d)
only asks whether the staged file has at least one table.

The directory-level permission case is incidentally covered, because guard (c)'s
`statSnapshot(livePath)` fails too and rejects the clone. A stat failure scoped
to the `.wal` path alone is not covered by anything.

### evidence

```
AX_DUCKDB_DYLIB=$HOME/.cache/ax-duckdb/dist/libduckdb.dylib \
AX_DATA_DIR=$(mktemp -d) AX_NO_AUTO_INGEST=1 bun test /tmp/axaudit/wal-loop.test.ts
```

A NON-EMPTY `live.duckdb.wal` made unstattable (symlink loop) while
`live.duckdb` stats fine:

```
guard(b) walIsQuiescent => true | guard(c) pre-clone statSnapshot(live) => Success
```

Both guards pass; the clone would be taken. A second case
(`/tmp/axaudit/wal-guard.test.ts`) shows the directory-EACCES variant:
`walIsQuiescent ... => true | statSnapshot(live) => Failure`.

### suggested fix

`skipNotFound(true)` for the absent-WAL case and `Effect.orElseSucceed(() => false)`
for everything else - only "the file is not there" may mean quiescent; every
other stat error must fall back to the logical copy.

---

## The spool's dedup key is the raw id while the emitted id is scrubbed, so one flush can carry two rows under one conflict key

- file: `packages/lib/src/duckdb/spool.ts:278`
- severity: minor
- confirmed: yes

### failure scenario

`append` keys the dedup map on the RAW id (`buffer.lines.set(id, ...)`), but the
id actually written to the NDJSON line goes through `encodeValue`, which
rewrites lone UTF-16 surrogates to U+FFFD (#907, spool.ts:143-153) and strips
U+0000 (spool.ts:154-157). Two distinct raw ids that scrub to the same value
survive as two separate map entries and are emitted as two lines carrying ONE
conflict key.

The module header asserts this cannot hurt because "DuckDB REJECTS a statement
whose source carries two rows with the same conflict key" (spool.ts:26-29). That
premise is false for a `read_ndjson` source: DuckDB accepts the statement and
silently keeps one row, while `flush` returns `rows: <both>` and `totals().rows`
counts both as landed. The spool's per-id dedup is therefore the ONLY thing
standing between this path and unreported row loss, and it is keyed on the wrong
string.

Reachability today is low, not zero: every spooled table's `id` currently comes
from `stableId`/`stableDigest` (hex), so no live id can carry a surrogate or a
NUL. The defect is that nothing enforces that, and the header's stated backstop
does not exist.

### evidence

```
AX_DUCKDB_DYLIB=$HOME/.cache/ax-duckdb/dist/libduckdb.dylib AX_DUCKDB_REQUIRE_FTS=1 \
AX_DATA_DIR=$(mktemp -d) AX_NO_AUTO_INGEST=1 bun test /tmp/axaudit/spool-probe.test.ts
```

Appending ids `"k\uD800"` and `"k\uDC00"` (two lone surrogates) to one buffer:

```
pending: 2
SURROGATE flush: Success {"rows":2,"statements":1}
rows: [{"id":"k<U+FFFD>","text":"one"}]
totals: {"rows":2,"statements":1,"nulValues":0,"illFormedValues":2}
```

Two rows reported landed, one row in the table, no failure. (The same suite also
confirms the two invariants that DO hold: a `bigint` above 2^53 round-trips
exactly through the decimal-string encoding, and a 20 MB text value loads fine -
`read_ndjson`'s object-size limit is not a regression here.)

### suggested fix

Encode the id first and key `buffer.lines` on the ENCODED id, so the map's
last-write-wins dedup operates on the same string DuckDB will conflict on. Then
correct the header's claim about DuckDB rejecting duplicate conflict keys.

---

## The torn-copy tripwire is blind to WAL-only writes and to same-millisecond in-place page updates

- file: `packages/lib/src/duckdb/client.ts:796`
- severity: minor
- confirmed: no

### failure scenario

Guard (c) claims to detect "something else wrote to `livePath` while the clone
ran" by comparing `{size, mtimeMs}` before and after the clone. Two structural
holes:

1. A concurrent commit on another handle goes to `<livePath>.wal`, not to
   `livePath`. Neither the size nor the mtime of `livePath` moves, so the
   tripwire cannot fire. Guard (b) checked the WAL once, BEFORE the pre-clone
   stat, and is never re-checked after the clone - so the whole window between
   the WAL check and the clone is unguarded by construction.
2. `statSnapshot` reads `mtime` through `Date.getTime()`, i.e. WHOLE
   milliseconds. A DuckDB page rewritten in place keeps the file size identical,
   so an overwrite landing inside the same millisecond as the `before` stat is
   invisible to both halves of the comparison.

Not reproduced: reaching either hole needs a second writer on `livePath` while a
publish runs, and the ingest path holds `withIngestLock` and publishes with
`options.from` after the body has finished. The no-`options.from` entry point is
publicly callable and its docstring only warns about stale reads (RULING R14),
not about this.

### evidence

Code flow: `client.ts:790-825` runs (b) WAL -> (c) stat -> clone -> (c) stat,
with no post-clone WAL re-check. Grain measured with the real primitive
(`/tmp/axaudit/wal-guard.test.ts`):

```
statSnapshot.mtimeMs = 1787211707201 | Bun stat mtimeMs = 1787211707201.2239 | integer-ms? true
```

`clone-file.ts:83` truncates the fractional millisecond that the underlying stat
does carry.

### suggested fix

Re-run `walIsQuiescent` AFTER the clone as part of the same tripwire, and carry
the fractional `mtimeMs` (`Bun.file().stat().mtimeMs`, or `ctime`/inode
generation) into `FileStatSnapshot` instead of a millisecond-truncated `Date`.

---

## The failed-clonefile branch is the one post-clone rejection that does not clear the temp path

- file: `packages/lib/src/duckdb/client.ts:805`
- severity: minor
- confirmed: no

### failure scenario

Every rejection in `attemptClone` that happens after `cloneFile` has touched
`tmp` calls `clearPartialClone(tmp)` first - post-clone stat failure (:813),
tripwire mismatch (:820), sanity-open failure (:843), no-tables (:850) - because
the logical fallback then runs `ATTACH '<tmp>'` on that same path and must not
attach a half-trusted file. The `!clone.cloneable` branch (:805-808) is the
exception: it returns `{mode:"copy"}` with no clear. `clearPartialClone`'s own
comment asserts the branch is safe because a failed `cloneFile` wrote nothing,
but `copyfile(3)` does not promise that - it promises only that
`COPYFILE_CLONE_FORCE` will not silently degrade to a byte copy. A failure after
the destination has been created (e.g. ENOSPC part-way through an APFS-to-APFS
clone) would leave a truncated file that the fallback then ATTACHes.

### evidence

Could not produce a failing `cloneFile` that leaves a destination behind on this
machine. `/tmp/axaudit/clone-partial.test.ts` drove five failure modes through
the real primitive:

```
char-dev src (/dev/null): cloneable=false reason=EINVAL ... | dst exists=false
char-dev src (/dev/zero): cloneable=false reason=EINVAL ... | dst exists=false
dir src:                  cloneable=false reason=EINVAL ... | dst exists=false
missing src:              cloneable=false reason=ENOENT ... | dst exists=false
dst parent missing:       cloneable=false reason=ENOENT ... | dst exists=false
control ok:               cloneable=true  reason=-      | dst exists=true size=4096
```

No `EXDEV`/`ENOTSUP`/`ENOSPC` case was constructible without a second
filesystem, so the finding rests on the contract, not on a repro.

### suggested fix

Call `clearPartialClone(tmp)` on the `!clone.cloneable` branch too - it is
already best-effort and costs one syscall on a path that is about to do a full
logical copy anyway.

---

## Out-of-scope observations

- `apps/axctl/src/ingest/{transcripts,codex,pi}.ts` create the spool scratch dir with the UNSCOPED `fs.makeTempDirectory` and remove it only on the success path (transcripts.ts:1998, codex.ts:1782, pi.ts:823) - a failed stage leaks the dir, and if the failure was the flush itself the leaked NDJSON holds raw turn text.
- `apps/axctl/src/ingest/run.ts:492` calls `buildFtsIndexes(write)` unguarded while the adjacent comment calls FTS "best-effort" and its neighbours use `Effect.ignore` - comment and code disagree about whether an FTS failure should fail the run.
- Derive stages read spooled tables (`derive-signals.ts:40`, `derive-spawned.ts:21`, `outcomes.ts:223`, `derive-run-evidence.ts:524`, ...). They use the direct write service, so they are only exposed if the pipeline ever schedules them concurrently with an unflushed provider stage; the spool widens that pre-existing window by up to `SPOOL_FLUSH_PENDING_ROWS` (25k) rows.
- `apps/axctl/src/ingest/evidence-writers.ts:211-212` builds the `edited`/`read_file`/`searched_file` edge batches with no dedup, so they share finding 3's first-wins collapse.
- `packages/lib/src/duckdb/seam.ts:820` - `writerOver` reports `snapshotPath = target` while its `rows`/`first`/`raw` read the LIVE database; a caller trusting `write.snapshotPath` gets a path it did not read from.
- `packages/lib/src/duckdb/seam.ts:780` - a failed `DETACH ax_publish_guard` is `Effect.ignore`d, and the fixed alias means every later publish's guard ATTACH then collides and degrades to a silent no-op via `orElseSucceed(0)`.

## Coverage

Read in full: `clone-file.ts`, `spool.ts`, `watermark.ts`, `fts.ts`, `seam.ts`,
`query.ts`, `clause.ts`, `binding.ts`, `row.ts`, `row-decode.ts`,
`nul-strip.ts`, `self-time.ts`, `bigint-column.ts`, `canonical-path.ts`,
`schema-comments.ts`, and `client.ts` (the publish path at :560-975 line by
line, the rest skimmed). Read as supporting evidence, not audited:
`staged-rename.ts`, `shared/fs-error.ts`, `stable-id.ts`, `ids.ts`, and the
consumer sites in `apps/axctl/src/ingest/` (`jsonl-work-unit.ts`,
`transcripts.ts`, `codex.ts`, `pi.ts`, `evidence-writers.ts`, `run.ts`,
`git.ts`).

Ran: the full in-scope suite, green -
`bun test packages/lib/src/duckdb/` -> 246 pass / 1 skip / 0 fail (13.7s).
Both repo guards the brief names, clean - `bun run check:raw-numeric-cast`
(1408 files, 78 integer columns, 0 bare projections) and
`bun run check:timestamp-cast` (1490 files, 0 uncast). Six scratch suites under
`/tmp/axaudit/` (not in this worktree): `fts-publish`, `fts-digest`,
`spool-probe`, `wm-crosspath`, `wal-guard`, `wal-loop`, `clone-partial`,
`dup-id`.

Hypotheses tested and DISPROVEN (recorded so nobody re-runs them):
- The logical `COPY FROM DATABASE` publish path does NOT lose the FTS index: the
  `fts_main_turn` schema, all six of its tables, and a working `match_bm25`
  survive into the snapshot (`fts-publish.test.ts`).
- `read_ndjson` does NOT trip an object-size limit on a 20 MB spooled text value.
- The spool's bigint-as-decimal-string encoding round-trips `9007199254740993`
  exactly through a BIGINT column.
- `cacheRow` keeps every key, so a `sha`-null / `sha`-present mix in one deferred
  watermark batch is not a ragged `putMany`.
- `CacheReadLayer`'s claim/retire/close accounting has no handle leak across
  repeated publishes (traced by hand; not stress-tested).

NOT reached: `dylib.ts`, `columns.ts`, `errors.ts`, `types.ts`, `internal.ts`,
`index.ts` beyond a skim; no concurrency stress test of `CacheReadLayer` under
real republishing; no test of the clone path on a non-APFS filesystem (none
available on this machine, so every clone-fallback branch is code-flow only);
`binding.ts` reviewed but not exercised in compiled-binary mode.
