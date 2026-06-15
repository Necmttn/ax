# ax hooks bench - hook latency ledger

Date: 2026-06-13
Status: approved design, pre-implementation
Follows: docs/superpowers/specs/2026-06-13-ax-dojo-design.md (dojo core, "new hooks" use case)

## Problem

The dojo's highest-value use case (user's words: "the greatest use case") is the
agent authoring a NEW hook, backtesting it, and shipping it as a proposal. But
every hook rides the harness hot path (`bun <file>.ts`, ~70ms cold spawn per
fire), and chains stack. A hook proposal must show BOTH sides of the ledger:
benefit (cases the hook catches - `ax hooks backtest` already does this) AND
cost (per-fire latency, fires/day, cumulative installed-chain budget). Today the
cost side doesn't exist. `ax hooks backtest` replays in-process - it measures
logic time but NOT the spawn tax the harness actually pays.

`ax hooks bench <file>` produces the cost ledger.

## Two sources of latency truth

1. **Synthetic spawn** (the headline): a just-authored hook has no production
   history, so we measure it directly - spawn `bun <absFile>` feeding a
   representative event on stdin, N times, take percentiles. This is the real
   fire path (validated: if the stdin shape is wrong the hook errors).
2. **Recorded production fires**: `hook_command_invocation.duration_ms` holds
   what already-installed hooks actually cost in real sessions
   (`buildHookSummaryQuery` aggregates mean/max per command). Feeds the
   installed-chain budget so the candidate's cost is shown in context.

## `ax hooks bench <file> [--days=N] [--runs=N] [--budget-ms=N] [--json]`

New subcommand in the `hooks` family (runtime `db` - needs `tool_call` +
`hook_command_invocation`). `<file>` = absolute path to a `@ax/hooks-sdk` hook.

Steps:

1. **Load meta**: `loadHookMeta(file)` (`apps/axctl/src/hooks/sdk-install.ts`) →
   `{ name, events[], matcher?.tools[] }`. Fail cleanly if not a valid hook.

2. **Per-fire latency (headline)**: build a representative raw stdin payload for
   the hook's first event + a matched tool (see "stdin shape" below), then
   `Bun.spawn(["bun", absFile], { stdin: payload })` `--runs` times (default 20),
   timing each with `performance.now()` around spawn→exit. Discard run 1 (compile
   -cache warmup, reported separately). Compute p50/p95/min/max/mean over the
   rest (pure `percentiles()`).
   - Secondary breakdown: reuse `replayRows`-style in-process `run()` timing for
     one fire → "logic" ms (the author-controllable part vs the fixed runtime
     tax = p50 − logic). Best-effort; omit if it complicates.

3. **Fire frequency**: count `tool_call WHERE name IN $tools AND ts > $since`
   over `--days` (default 30) ÷ days → est fires/day. If the hook has no tool
   matcher (fires on every event of its type, e.g. SessionStart), report
   "all <event> events" with a count of those events/day if derivable, else mark
   frequency `n/a` (and skip daily-overhead). Reuse backtest's `tool_call` query
   + `surrealDate` cutoff convention.

4. **Daily overhead** = p50 × fires/day (ms/day this hook adds).

5. **Installed-chain budget**: enumerate installed hooks (`readAllHooks`,
   `apps/axctl/src/hooks/config.ts`); for each event type the candidate fires on,
   sum the per-fire cost of every hook on that event. Per-hook cost = recorded
   mean `duration_ms` from `hook_command_invocation` when present, else a default
   spawn estimate (constant, ~70ms). Show the chain BEFORE and WITH the candidate
   vs `--budget-ms` (default 250). Warn when any event-type chain exceeds budget.
   - v1 may approximate: if precise per-event matcher decomposition is heavy,
     report installed-hook count + summed recorded cost + candidate contribution
     + the worst event-type chain, and `log()` what was approximated. No silent
     truncation.

6. **Ledger output** (table by default, `--json` for the dojo agent to embed
   verbatim in a hook proposal):

```
hook: enforce-worktree
per-fire:      p50 72ms · p95 84ms · (19 spawns, 1 warmup 140ms) · logic 2ms
fires/day:     ~14  (Bash,Edit,Write matched over 30d)
daily cost:    ~1.0 s/day
chain (PreToolUse): 3 hooks 198ms -> 270ms with this  ⚠ over 250ms budget
verdict:       SHIP only if the benefit ledger (ax hooks backtest) justifies +72ms/fire
```

The `--json` shape is a typed `BenchLedger` (per-fire stats, frequency, daily
cost, per-event chain rows, budget + over-budget flag).

## stdin shape (key integration risk)

The subprocess reads the HARNESS raw payload via `decodeHookInput(stdinText, env)`
(`packages/hooks-sdk/src/event.ts`) - NOT the decoded `HookEvent`. The bench must
emit a payload `decodeHookInput` accepts (Claude Code PreToolUse JSON:
`hook_event_name`, `tool_name`, `tool_input`, `cwd`, `session_id`, ...). The
implementer reads `decodeHookInput` + `event.ts` to match it exactly, and
**smoke-validates by benching a real installed hook** (e.g. `~/.ax/hooks/
enforce-worktree.ts`): a correct payload yields a normal verdict exit, a wrong
one errors - so the smoke proves the format.

## Module shape

```
apps/axctl/src/hooks/bench.ts
  - percentiles(samples: number[]): { p50, p95, min, max, mean }      (pure)
  - buildRepresentativePayload(meta, sampleInput): string             (pure: raw stdin JSON)
  - renderLedger(ledger: BenchLedger): string                         (pure)
  - measureSpawn(absFile, payload, runs): Effect<number[], ...>        (Bun.spawn timing)
  - estFiresPerDay(tools, days): Effect<{perDay, matched}, DbError, SurrealClient>
  - gatherChain(meta, candidateP50, budgetMs): Effect<ChainRow[], DbError, SurrealClient | FileSystem | HookProviderRegistry>
  - benchHook(input): Effect<BenchLedger, ...>                         (orchestration)
apps/axctl/src/hooks/bench.test.ts
apps/axctl/src/cli/commands/hooks.ts   # add benchCommand to the family (runtime already db)
```

Pure cores (`percentiles`, `buildRepresentativePayload`, `renderLedger`) unit-
tested in isolation. `estFiresPerDay`/`gatherChain` tested with the fake-
SurrealClient harness + fixtures. `measureSpawn`/`benchHook` covered by the live
CLI smoke (spawning is inherently integration).

## Dojo wiring

`skills/dojo/SKILL.md` "new hooks" playbook updates: after authoring + `ax hooks
backtest`, run `ax hooks bench <file>` and embed BOTH ledgers (benefit from
backtest, cost from bench) in the proposal; reject the hook when the daily cost
or chain-budget overrun outweighs the benefit. No dojo CLI code change - this is
skill-prose + the new command.

## Safety / scope

- Read-only against the graph; spawns the hook in a child process (the hook
  itself may have side effects - bench notes that hooks should be pure; running
  a real hook's `run()` once is what `backtest` already does, so no new risk).
- `--runs` capped (e.g. ≤100) to bound wall time.
- No new SurrealDB table.

## Out of scope (later)

- Continuous latency tracking / regression alerts on installed hooks.
- p50/p95 from recorded `duration_ms` percentiles (v1 uses mean/max the existing
  query provides; true percentiles need a histogram query - deferred).
- Auto-reject in the CLI - the SHIP/skip judgment stays with the agent.

## Open questions

- Non-tool-event hooks (SessionStart/Stop): fires/day has no `tool_call` proxy.
  v1 marks frequency `n/a`; a per-event-type count from `hook_command_invocation`
  history could fill it if the hook is already installed.
