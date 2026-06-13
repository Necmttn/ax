# ax hooks bench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add `ax hooks bench <file>` - a hook latency ledger (per-fire p50/p95 via synthetic spawn, fires/day from history, installed-chain budget) - per spec `docs/superpowers/specs/2026-06-13-hooks-bench-design.md`.

**Architecture:** Pure cores (percentiles, representative-payload builder, ledger renderer) unit-tested; Effect glue (subprocess spawn timing, two graph queries, installed-hook chain) tested with fakes + live CLI smoke. New `bench` subcommand in the existing `hooks` family (runtime already `db`).

**Tech Stack:** bun ≥1.3, TS strict, Effect v4 beta (`effect/unstable/cli`), bun:test, SurrealDB via `SurrealClient`, `Bun.spawn` for subprocess timing, `performance.now()` for wall clock.

**Conventions:** Worktree `/Users/necmttn/Projects/ax/.claude/worktrees/dojo-hookbench`. Test = `bun test <path>` (tmp wrapper if a hook blocks bare `bun test`). Datetime cutoffs inline via `surrealDate()` from `@ax/lib/shared/surql` (`d"..."` literal - SurrealClient.query takes no bindings; see `apps/axctl/src/improve/report-queries.ts`). FileSystem via `import { Effect, FileSystem } from "effect"` + `FileSystem.FileSystem` (see `apps/axctl/src/dojo/briefs.ts`). Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

**Grounding facts (verified):**
- Hook meta: `loadHookMeta(file)` (`apps/axctl/src/hooks/sdk-install.ts:85`) → `InstallableHookMeta { name, events: string[], matcher?: { tools?: string[] } }`.
- Raw stdin payload `decodeHookInput` accepts (`packages/hooks-sdk/src/adapters/decode.ts`, confirmed in `define.test.ts:26`): `{ hook_event_name, tool_name, tool_input, cwd, session_id? }`.
- Fire command: `bun <absFile>` (`sdk-install.ts` planInstall).
- backtest command pattern + `fetchRows(days, toolNames, providerFilter)` / `replayRows` (`apps/axctl/src/hooks/cli.ts:236`, `backtest.ts:62,199`).
- Installed hooks: `readAllHooks` (`apps/axctl/src/hooks/config.ts:108`). Recorded durations: `buildHookSummaryQuery` (`apps/axctl/src/queries/hooks.ts:70`) over `hook_command_invocation` (fields: command, hook_name, event_name, duration_ms, ts, harness).
- tool_call fields: `name`, `ts`, `session` (`packages/schema/src/schema.surql:324`). backtest's `TOOL_CALL_Q_*` is the count template.
- hooks family registration: `hooksConfigSubcommands` array (`apps/axctl/src/hooks/cli.ts:307`); runtime manifest `hooks: "db"` (`apps/axctl/src/cli/commands/hooks.ts:268`).

---

### Task 1: bench pure cores + types

**Files:** Create `apps/axctl/src/hooks/bench.ts`, `apps/axctl/src/hooks/bench.test.ts`

- [ ] **Step 1: failing test**

```ts
// apps/axctl/src/hooks/bench.test.ts
import { describe, expect, test } from "bun:test";
import { buildRepresentativePayload, percentiles, renderLedger } from "./bench.ts";
import type { BenchLedger } from "./bench.ts";

describe("percentiles", () => {
    test("p50/p95/min/max/mean over samples", () => {
        const p = percentiles([10, 20, 30, 40, 100]);
        expect(p.min).toBe(10);
        expect(p.max).toBe(100);
        expect(p.p50).toBe(30); // median (nearest-rank)
        expect(p.p95).toBe(100);
        expect(p.mean).toBe(40);
    });
    test("single sample: all equal", () => {
        expect(percentiles([7])).toEqual({ min: 7, max: 7, p50: 7, p95: 7, mean: 7 });
    });
    test("empty -> zeros", () => {
        expect(percentiles([])).toEqual({ min: 0, max: 0, p50: 0, p95: 0, mean: 0 });
    });
});

describe("buildRepresentativePayload", () => {
    test("PreToolUse with a matched tool + sample input", () => {
        const json = buildRepresentativePayload(
            { name: "x", events: ["PreToolUse"], matcher: { tools: ["Bash", "Edit"] } },
            { command: "git status" },
            "/repo",
        );
        const parsed = JSON.parse(json);
        expect(parsed.hook_event_name).toBe("PreToolUse");
        expect(parsed.tool_name).toBe("Bash"); // first matched tool
        expect(parsed.tool_input).toEqual({ command: "git status" });
        expect(parsed.cwd).toBe("/repo");
    });
    test("non-tool event (no matcher) -> no tool_name/tool_input", () => {
        const json = buildRepresentativePayload(
            { name: "x", events: ["SessionStart"], matcher: undefined }, null, "/repo",
        );
        const parsed = JSON.parse(json);
        expect(parsed.hook_event_name).toBe("SessionStart");
        expect(parsed.tool_name).toBeUndefined();
    });
});

describe("renderLedger", () => {
    const ledger: BenchLedger = {
        name: "enforce-worktree",
        perFire: { p50: 72, p95: 84, min: 70, max: 140, mean: 78 },
        warmupMs: 140, spawns: 19,
        logicMs: 2,
        frequency: { perDay: 14, matched: ["Bash", "Edit"], basis: "tool_call/30d" },
        dailyCostMs: 1008,
        chain: { event: "PreToolUse", beforeMs: 198, withMs: 270, budgetMs: 250, overBudget: true,
                 hooks: ["enforce-worktree", "route-dispatch", "other"] },
    };
    test("renders headline + frequency + chain warning", () => {
        const out = renderLedger(ledger);
        expect(out).toContain("hook: enforce-worktree");
        expect(out).toContain("p50 72ms");
        expect(out).toContain("p95 84ms");
        expect(out).toContain("fires/day");
        expect(out).toContain("14");
        expect(out).toContain("chain (PreToolUse): 198ms -> 270ms");
        expect(out).toContain("over 250ms budget");
    });
    test("frequency n/a hides daily cost line", () => {
        const out = renderLedger({ ...ledger, frequency: { perDay: null, matched: [], basis: "n/a" }, dailyCostMs: null });
        expect(out).toContain("fires/day:     n/a");
        expect(out).not.toContain("daily cost:");
    });
});
```

- [ ] **Step 2: run -> FAIL**

- [ ] **Step 3: implement** - types + the three pure fns.

```ts
// apps/axctl/src/hooks/bench.ts  (pure portion; Effect glue lands in Tasks 2-3)
export interface PerFireStats {
    readonly p50: number; readonly p95: number;
    readonly min: number; readonly max: number; readonly mean: number;
}
export interface ChainSummary {
    readonly event: string;
    readonly beforeMs: number; readonly withMs: number;
    readonly budgetMs: number; readonly overBudget: boolean;
    readonly hooks: readonly string[];
}
export interface BenchLedger {
    readonly name: string;
    readonly perFire: PerFireStats;
    readonly warmupMs: number | null;
    readonly spawns: number;
    readonly logicMs: number | null;
    readonly frequency: { readonly perDay: number | null; readonly matched: readonly string[]; readonly basis: string };
    readonly dailyCostMs: number | null;
    readonly chain: ChainSummary | null;
}
export interface HookMetaLite {
    readonly name: string;
    readonly events: readonly string[];
    readonly matcher?: { readonly tools?: readonly string[] } | undefined;
}

const round = (n: number) => Math.round(n);

/** Nearest-rank percentiles over wall-time samples (ms). Empty -> zeros. */
export const percentiles = (samples: readonly number[]): PerFireStats => {
    if (samples.length === 0) return { p50: 0, p95: 0, min: 0, max: 0, mean: 0 };
    const s = [...samples].sort((a, b) => a - b);
    const at = (q: number) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] ?? 0;
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    return { min: round(s[0] ?? 0), max: round(s[s.length - 1] ?? 0), p50: round(at(0.5)), p95: round(at(0.95)), mean: round(mean) };
};

/** Raw harness stdin payload that decodeHookInput accepts. */
export const buildRepresentativePayload = (
    meta: HookMetaLite,
    sampleInput: Record<string, unknown> | null,
    cwd: string,
): string => {
    const event = meta.events[0] ?? "PreToolUse";
    const firstTool = meta.matcher?.tools?.[0];
    const payload: Record<string, unknown> = { hook_event_name: event, cwd };
    if (firstTool) {
        payload.tool_name = firstTool;
        payload.tool_input = sampleInput ?? {};
    }
    return JSON.stringify(payload);
};

export const renderLedger = (l: BenchLedger): string => {
    const lines: string[] = [`hook: ${l.name}`];
    const warm = l.warmupMs != null ? `, 1 warmup ${l.warmupMs}ms` : "";
    const logic = l.logicMs != null ? ` · logic ${l.logicMs}ms` : "";
    lines.push(`per-fire:      p50 ${l.perFire.p50}ms · p95 ${l.perFire.p95}ms · (${l.spawns} spawns${warm})${logic}`);
    if (l.frequency.perDay == null) {
        lines.push(`fires/day:     n/a  (${l.frequency.basis})`);
    } else {
        lines.push(`fires/day:     ~${l.frequency.perDay}  (${l.frequency.matched.join(",")} via ${l.frequency.basis})`);
        if (l.dailyCostMs != null) lines.push(`daily cost:    ~${(l.dailyCostMs / 1000).toFixed(1)} s/day`);
    }
    if (l.chain) {
        const warn = l.chain.overBudget ? `  ⚠ over ${l.chain.budgetMs}ms budget` : ` (under ${l.chain.budgetMs}ms budget)`;
        lines.push(`chain (${l.chain.event}): ${l.chain.beforeMs}ms -> ${l.chain.withMs}ms with this${warn}`);
    }
    return lines.join("\n");
};
```

- [ ] **Step 4: run -> PASS** (8 tests)
- [ ] **Step 5: commit** `feat(hooks): bench pure cores - percentiles, payload, ledger render`

---

### Task 2: spawn timing + fire-frequency query

**Files:** Modify `apps/axctl/src/hooks/bench.ts`, `apps/axctl/src/hooks/bench.test.ts`

READ FIRST: `apps/axctl/src/hooks/backtest.ts` (TOOL_CALL_Q_ALL/FILTERED + fetchRows + surrealDate cutoff), `apps/axctl/src/improve/report-queries.ts` (query call shape + projection-strip), `apps/axctl/src/improve/show.test.ts` (fake client).

- [ ] **Step 1: failing test** - `estFiresPerDay`:

```ts
// add to bench.test.ts
import { Effect } from "effect";
import { estFiresPerDay } from "./bench.ts";
// fake-client harness from show.test.ts

describe("estFiresPerDay", () => {
    test("counts matched tool_calls / days", async () => {
        const client = fakeClient([[{ total: 420 }]]); // 420 matched over 30d
        const r = await Effect.runPromise(
            estFiresPerDay(["Bash", "Edit"], 30).pipe(Effect.provide(client.layer)),
        );
        expect(r.perDay).toBe(14);
        expect(r.matched).toEqual(["Bash", "Edit"]);
    });
    test("no tools (non-tool hook) -> perDay null, basis n/a", async () => {
        const r = await Effect.runPromise(estFiresPerDay([], 30).pipe(Effect.provide(fakeClient([[]]).layer)));
        expect(r.perDay).toBeNull();
    });
});
```

- [ ] **Step 2: run -> FAIL**

- [ ] **Step 3: implement** `estFiresPerDay` + `measureSpawn`.

```ts
// estFiresPerDay: COUNT tool_call WHERE name IN [tools] AND ts > since(days)
export const estFiresPerDay = (tools: readonly string[], days: number) =>
    Effect.gen(function* () {
        if (tools.length === 0) return { perDay: null as number | null, matched: [] as string[], basis: "n/a" };
        const db = yield* SurrealClient;
        const since = new Date(Date.now() - days * 86_400_000);
        const list = tools.map((t) => surrealString(t)).join(", "); // surrealString from @ax/lib/shared/surql
        const r = yield* db.query<[Array<{ total: number }>]>(
            `SELECT count() AS total FROM tool_call WHERE name IN [${list}] AND ts > ${surrealDate(since)} GROUP ALL;`,
        );
        const total = r?.[0]?.[0]?.total ?? 0;
        return { perDay: Math.round(total / days), matched: [...tools], basis: `tool_call/${days}d` };
    });
```

VERIFY: `count() ... GROUP ALL` is how the repo counts (see the weighted-query memory: count needs GROUP ALL). Check an existing COUNT query (`apps/axctl/src/queries/` or skill-stats) for the exact idiom and mirror it. `surrealString`/`surrealDate` live in `@ax/lib/shared/surql` - confirm import.

`measureSpawn(absFile, payload, runs)`: spawn `bun <absFile>` feeding `payload` on stdin, `runs` times; time each with `performance.now()`; return all samples (ms). Use `Bun.spawn(["bun", absFile], { stdin: new TextEncoder().encode(payload), stdout: "ignore", stderr: "ignore" })` then `await proc.exited`. Wrap as `Effect.promise`. Cap runs at 100. Return `number[]`.

```ts
export const measureSpawn = (absFile: string, payload: string, runs: number): Effect.Effect<number[]> =>
    Effect.promise(async () => {
        const samples: number[] = [];
        const n = Math.min(100, Math.max(1, runs));
        for (let i = 0; i < n; i++) {
            const t0 = performance.now();
            const proc = Bun.spawn(["bun", absFile], { stdin: new TextEncoder().encode(payload), stdout: "ignore", stderr: "ignore" });
            await proc.exited;
            samples.push(performance.now() - t0);
        }
        return samples;
    });
```

(measureSpawn is covered by the live smoke in Task 3, not a unit test - spawning bun in unit tests is slow/flaky. State this.)

- [ ] **Step 4: run -> PASS** (estFiresPerDay tests); typecheck clean.
- [ ] **Step 5: commit** `feat(hooks): bench spawn timing + fire-frequency query`

---

### Task 3: installed-chain + benchHook orchestration + CLI command

**Files:** Modify `apps/axctl/src/hooks/bench.ts`, `apps/axctl/src/hooks/bench.test.ts`; modify `apps/axctl/src/hooks/cli.ts` (add benchCommand to `hooksConfigSubcommands`).

READ FIRST: `apps/axctl/src/hooks/config.ts` (readAllHooks → installed hooks per provider/event), `apps/axctl/src/queries/hooks.ts` (buildHookSummaryQuery → recorded mean duration per command), the `backtestCommand` in `cli.ts` (command shape, file resolution, DB-error handling, expandTilde, Path.Path).

- [ ] **Step 1: gatherChain** - for the candidate's first event, list installed hooks on that event; per-hook cost = recorded mean `duration_ms` (from a hook-summary query keyed by command/hook_name) when present, else `DEFAULT_SPAWN_MS = 70`. `beforeMs` = sum of installed; `withMs` = before + candidate p50; `overBudget` = withMs > budgetMs.

Write `gatherChain(meta, candidateP50, budgetMs)` returning `ChainSummary | null` (null when the candidate has no events). Keep the recorded-duration lookup best-effort: if the summary query is heavy or the matcher decomposition is unclear, fall back to counting installed hooks on the event × DEFAULT_SPAWN_MS and `log()` that it's an estimate (no silent approximation). Test the PURE aggregation by factoring a helper:

```ts
export const composeChain = (
    event: string, installedCostsMs: readonly number[], candidateP50: number, budgetMs: number, hookNames: readonly string[],
): ChainSummary => {
    const before = Math.round(installedCostsMs.reduce((a, b) => a + b, 0));
    const withC = before + Math.round(candidateP50);
    return { event, beforeMs: before, withMs: withC, budgetMs, overBudget: withC > budgetMs, hooks: [...hookNames] };
};
```

Test `composeChain` purely (sum, over/under budget boundary at exactly budgetMs → not over). `gatherChain` (the Effect that fetches installed costs) is covered by the live smoke.

- [ ] **Step 2: benchHook orchestration** - `benchHook({ file, days, runs, budgetMs })`:
  1. resolve absFile (expandTilde + Path.resolve, like backtest).
  2. `loadHookMeta(absFile)` → meta (handle the typed import/validation errors with a clean message + nonzero exit, mirroring backtest).
  3. pick a sample input: query one recent `tool_call.input_json` for `meta.matcher.tools[0]` if any (reuse fetchRows or a tiny SELECT ... LIMIT 1); parse to object; else null.
  4. payload = buildRepresentativePayload(meta, sampleInput, process.cwd()).
  5. samples = measureSpawn(absFile, payload, runs); warmup = samples[0]; rest = samples.slice(1); perFire = percentiles(rest.length ? rest : samples).
  6. freq = estFiresPerDay(meta.matcher?.tools ?? [], days).
  7. dailyCostMs = freq.perDay != null ? perFire.p50 * freq.perDay : null.
  8. chain = gatherChain(meta, perFire.p50, budgetMs).
  9. assemble BenchLedger. (logicMs: optional - skip in v1 unless cheap; set null.)
  Return type: `Effect<BenchLedger, never, SurrealClient | FileSystem | Path | HookProviderRegistry>` (whatever readAllHooks needs). Soft-isolate each source (a failed query → its empty/default), never abort.

- [ ] **Step 3: benchCommand** - mirror backtestCommand:

```ts
const benchCommand = Command.make("bench", {
    file: Argument.string("file"),
    days: Flag.integer("days").pipe(Flag.withDefault(30)),
    runs: Flag.integer("runs").pipe(Flag.withDefault(20)),
    budgetMs: Flag.integer("budget-ms").pipe(Flag.withDefault(250)),
    json: Flag.boolean("json").pipe(Flag.withDefault(false)),
}, ({ file, days, runs, budgetMs, json }) => Effect.gen(function* () {
    const ledger = yield* benchHook({ file, days, runs, budgetMs });
    console.log(json ? prettyPrint(ledger) : renderLedger(ledger));
})).pipe(Command.withDescription("Latency ledger for an SDK hook: per-fire p50/p95 (spawn) + fires/day + installed-chain budget (--days=30 --runs=20 --budget-ms=250 --json)"));
```
Add `benchCommand` to the `hooksConfigSubcommands` array. Runtime: `hooks` is already `"db"` - no manifest change (the db-conditional check: confirm `hooks: "db"` covers subcommands, which it does since it's a flat "db").

- [ ] **Step 4: tests + smoke**
  - `bun test apps/axctl/src/hooks/bench.test.ts` → pure tests pass (percentiles, payload, render, estFiresPerDay, composeChain).
  - `bun test apps/axctl/src/cli/effect-cli.test.ts` → pass.
  - Live smoke (DB up; `~/.ax/hooks/` has installed hooks like enforce-worktree.ts): `bun apps/axctl/src/cli/index.ts hooks bench ~/.ax/hooks/enforce-worktree.ts --runs=5 --json` → a BenchLedger with real perFire numbers (p50 ~50-120ms proves the spawn + stdin format is correct), a frequency, and a chain. Then non-json for the table. PASTE output. If `~/.ax/hooks` is empty, run `ax hooks init` first or point at any SDK hook file in the repo.
- [ ] **Step 5: commit** `feat(hooks): ax hooks bench - latency ledger command`

---

### Task 4: docs + SKILL.md

**Files:** Modify `docs/cli.md`, `apps/site/public/llms.txt`, `CLAUDE.md`, `skills/dojo/SKILL.md`

- [ ] **Step 1** docs/cli.md: add under the hooks commands -
```
axctl hooks bench <file> [--days=N|--runs=N|--budget-ms=N|--json]   # hook latency ledger: per-fire p50/p95 + fires/day + installed-chain budget
```
- [ ] **Step 2** llms.txt: add a bullet near the hooks entries describing `ax hooks bench`.
- [ ] **Step 3** CLAUDE.md "## Hooks SDK" section: add a bullet - `ax hooks bench <file> [--days --runs --budget-ms --json]` - latency ledger (per-fire p50/p95 from real `bun <file>` spawns, est fires/day from tool_call history, installed-chain budget vs --budget-ms default 250). Pairs with `ax hooks backtest` (benefit) for dojo hook proposals.
- [ ] **Step 4** skills/dojo/SKILL.md "new hooks" playbook: after `ax hooks backtest`, add: run `ax hooks bench <file> --json` and embed BOTH ledgers in the proposal - backtest = cases caught (benefit), bench = per-fire/day cost + chain budget (cost). Reject the hook when daily cost or a chain-budget overrun outweighs the benefit.
- [ ] **Step 5** `bun run check:cli-reference` → exit 0 (hooks parent already covered; just keep docs accurate). Commit `docs(hooks): bench command reference + dojo new-hook ledger usage`.

---

### Task 5: verify + PR

- [ ] **Step 1** `bun test` (repo-wide) → 0 fail.
- [ ] **Step 2** `bun run typecheck` → clean.
- [ ] **Step 3** `bun run check:cli-reference` + `bun scripts/check-no-node-fs.ts` → clean.
- [ ] **Step 4** push + PR:
```bash
git push -u origin feat/dojo-hookbench
gh pr create --title "feat: ax hooks bench - hook latency ledger" --body "..."
```
PR body: summary (per-fire p50/p95 via real spawn, fires/day from history, installed-chain budget); the dojo "new hooks" use case it completes; test plan (incl. live smoke proving the stdin format); deferred (continuous regression tracking, true recorded percentiles, auto-reject).
