/**
 * ax hooks bench - hook latency ledger.
 *
 * Pure cores (this file's top section) are unit-tested; Effect glue (subprocess
 * spawn timing, graph queries, installed-hook chain) is tested with fakes + a
 * live CLI smoke. Built incrementally across the hooks-bench plan tasks.
 */

import { Effect, FileSystem, Path } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { surrealDate, surrealString } from "@ax/lib/shared/surql";
import { HOME } from "@ax/lib/paths";
import { readAllHooks } from "./config.ts";
import type { ConfiguredHookWithEvidence } from "./config.ts";
import { HookProviderRegistry } from "./providers/registry.ts";
import { queryHookSummary } from "../queries/hooks.ts";
import type { HookSummaryRow } from "../queries/hooks.ts";
import { loadHookMeta } from "./sdk-install.ts";
import type { InstallableHookMeta } from "./sdk-install.ts";

const exitProcess = (code: number): never => {
    process.exit(code);
    throw new Error(`process.exit(${code}) returned`);
};

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

// ---------------------------------------------------------------------------
// Effect glue: fire-frequency query + subprocess spawn timing
// ---------------------------------------------------------------------------

export interface FireFrequency {
    readonly perDay: number | null;
    readonly matched: readonly string[];
    readonly basis: string;
}

/**
 * Estimate fires/day for a tool-matching hook: COUNT tool_call rows whose
 * `name` is in the hook's matched tools over the last `days`, divided by days.
 * Non-tool hooks (no matched tools) have no tool_call basis -> perDay null.
 *
 * Datetime cutoff inlined via `surrealDate` (SurrealClient.query takes no
 * bindings; same pattern as report-queries.ts). Count idiom: top-level
 * `count() AS total ... GROUP ALL` (mirrors wrapped.ts / recall.ts; the repo
 * memory note that count needs GROUP ALL).
 */
export const estFiresPerDay = (
    tools: readonly string[],
    days: number,
): Effect.Effect<FireFrequency, DbError, SurrealClient> =>
    Effect.gen(function* () {
        if (tools.length === 0) return { perDay: null, matched: [], basis: "n/a" };
        const db = yield* SurrealClient;
        // Guard days so days=0 can't divide to Infinity.
        const window = Math.max(1, days);
        const since = new Date(Date.now() - window * 86_400_000);
        const list = tools.map((t) => surrealString(t)).join(", ");
        const r = yield* db.query<[Array<{ total: number }>]>(
            `SELECT count() AS total FROM tool_call WHERE name IN [${list}] AND ts > ${surrealDate(since)} GROUP ALL;`,
        );
        const total = r?.[0]?.[0]?.total ?? 0;
        return { perDay: Math.round(total / window), matched: [...tools], basis: `tool_call/${window}d` };
    });

/**
 * Per-spawn deadline (ms). Hooks have a 10s harness limit, so 15s is a safe
 * ceiling: a hook that blows past it is misbehaving/hanging and we kill it
 * rather than stall the bench forever. The deadline value is recorded as the
 * sample so percentiles still reflect the timeout cost.
 */
const SPAWN_DEADLINE_MS = 15_000;

/**
 * Spawn `bun <absFile>` feeding `payload` on stdin, `runs` times (capped 1-100),
 * timing each invocation with `performance.now()`. Returns all wall-time samples
 * (ms). Each spawn is bounded by SPAWN_DEADLINE_MS: a hanging hook is killed and
 * the deadline recorded as its sample (no leaked process). Covered by the live
 * CLI smoke (Task 3), not a unit test - spawning bun in unit tests is slow/flaky.
 */
export const measureSpawn = (
    absFile: string,
    payload: string,
    runs: number,
): Effect.Effect<number[]> =>
    Effect.promise(async () => {
        const samples: number[] = [];
        const n = Math.min(100, Math.max(1, runs));
        for (let i = 0; i < n; i++) {
            const t0 = performance.now();
            const proc = Bun.spawn(["bun", absFile], {
                stdin: new TextEncoder().encode(payload),
                stdout: "ignore",
                stderr: "ignore",
            });
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timedOut = await Promise.race([
                proc.exited.then(() => false),
                new Promise<boolean>((resolve) => {
                    timer = setTimeout(() => resolve(true), SPAWN_DEADLINE_MS);
                }),
            ]);
            if (timer !== undefined) clearTimeout(timer);
            if (timedOut) {
                // Kill the hanging process and record the deadline as the cost.
                proc.kill();
                samples.push(SPAWN_DEADLINE_MS);
            } else {
                samples.push(performance.now() - t0);
            }
        }
        return samples;
    });

// ---------------------------------------------------------------------------
// Installed-chain composition + benchHook orchestration
// ---------------------------------------------------------------------------

/** Fallback per-hook cost (ms) when no recorded mean exists. The ~70ms is the
 *  measured `bun <file>.ts` cold-spawn floor noted in the hooks-sdk docs. */
export const DEFAULT_SPAWN_MS = 70;

/**
 * PURE: aggregate installed hook costs + the candidate's p50 into a budget
 * verdict for one event. `beforeMs` = sum of installed; `withMs` = before +
 * candidate p50; `overBudget` is STRICT (== budget is NOT over).
 */
export const composeChain = (
    event: string,
    installedCostsMs: readonly number[],
    candidateP50: number,
    budgetMs: number,
    hookNames: readonly string[],
): ChainSummary => {
    const before = round(installedCostsMs.reduce((a, b) => a + b, 0));
    const withC = before + round(candidateP50);
    return { event, beforeMs: before, withMs: withC, budgetMs, overBudget: withC > budgetMs, hooks: [...hookNames] };
};

/** Derive a short display name for an installed hook from its command string
 *  (`bun /abs/path/enforce-worktree.ts` -> `enforce-worktree`,
 *  `"/abs/hooks/block-bun-test.sh"` -> `block-bun-test`). Matches the last
 *  script-file token and strips its extension; falls back to the last
 *  whitespace token (quotes stripped) when no file-like token is present. */
export const chainHookName = (command: string): string => {
    const matches = [...command.matchAll(/([^/\s"']+)\.(?:ts|js|mjs|cjs|sh|py)\b/g)];
    const last = matches[matches.length - 1];
    if (last?.[1]) return last[1];
    const tokens = command.replace(/["']/g, "").replace(/\s+/g, " ").trim().split(" ");
    const token = tokens[tokens.length - 1] ?? command;
    return token.split("/").pop() || token;
};

/** One installed-hook row reduced to what the chain aggregation needs. */
export interface ChainHookRow {
    readonly command: string;
    readonly enabled: boolean;
}

export interface ChainCosts {
    readonly costs: number[];
    readonly names: string[];
    /** count of distinct commands that had no recorded duration (estimate path). */
    readonly estimated: number;
}

/**
 * PURE: reduce installed-hook rows to per-hook costs + display names for the
 * chain. Enabled-only; **deduped by exact command** so the same command counted
 * twice (e.g. a duplicate install on one provider) is added once. Caller is
 * responsible for scoping `rows` to a SINGLE harness first - a real
 * PreToolUse fire only runs one harness's chain, so summing across providers
 * would ~2x reality. Within a harness, multiple scopes (global+project) are
 * legitimately additive but still share the command dedup.
 *
 * Per-hook cost = recorded mean from `meanByCommand` when present, else
 * `defaultMs` (and counted in `estimated`).
 */
export const dedupeChainCosts = (
    rows: ReadonlyArray<ChainHookRow>,
    meanByCommand: ReadonlyMap<string, number>,
    defaultMs: number,
): ChainCosts => {
    const costs: number[] = [];
    const names: string[] = [];
    const seen = new Set<string>();
    let estimated = 0;
    for (const r of rows) {
        if (!r.enabled) continue;
        if (seen.has(r.command)) continue;
        seen.add(r.command);
        const recorded = meanByCommand.get(r.command);
        if (recorded === undefined) estimated += 1;
        costs.push(recorded ?? defaultMs);
        names.push(chainHookName(r.command));
    }
    return { costs, names, estimated };
};

/** The harness whose chain a single fire actually runs. A PreToolUse fire runs
 *  exactly ONE harness's hook chain; we scope to claude (the bench's home
 *  harness) so the budget reflects reality instead of summing every provider. */
const CHAIN_PROVIDER = "claude";

/**
 * For the candidate's first event, enumerate the hooks installed on that event
 * and compose the budget chain, INCLUDING the candidate itself (so the chain
 * the model actually runs is fully represented). Per-hook cost = recorded mean
 * `duration_ms` (from `queryHookSummary`, matched by exact command) when
 * present, else `DEFAULT_SPAWN_MS`. Returns null when the candidate has no
 * events.
 *
 * Single-harness scope: `readAllHooks` returns one row per (provider × scope),
 * so a hook installed under both claude and codex would be summed twice. A real
 * fire only runs one harness's chain, so we filter to `CHAIN_PROVIDER` and
 * dedupe by exact command (`dedupeChainCosts`). Global+project scopes within
 * the harness stay additive (both fire); only exact-command dupes collapse.
 *
 * Best-effort + soft-fail: a failed config read or summary query degrades to
 * the default-estimate path and writes a notice to STDERR (so `--json` stdout
 * stays clean) - never a silent approximation. Deps: HookProviderRegistry |
 * FileSystem | Path | SurrealClient.
 */
export const gatherChain = (
    meta: InstallableHookMeta,
    candidateP50: number,
    budgetMs: number,
): Effect.Effect<
    ChainSummary | null,
    never,
    HookProviderRegistry | FileSystem.FileSystem | Path.Path | SurrealClient
> =>
    Effect.gen(function* () {
        const event = meta.events[0];
        if (!event) return null;

        // Installed hooks on this event, scoped to the single harness that a
        // fire actually runs. Soft-fail to an empty chain (candidate only).
        const installed: ReadonlyArray<ConfiguredHookWithEvidence> = yield* readAllHooks({
            eventFilter: event,
            providerFilter: CHAIN_PROVIDER,
            withEvidence: false,
        }).pipe(
            Effect.catch((e) =>
                Effect.sync(() => {
                    // stderr, not Effect.log: the configured logger writes to stdout
                    // and would corrupt the `--json` ledger on the same stream.
                    process.stderr.write(`hooks bench: could not enumerate installed hooks on ${event} (${String(e)}); chain shows candidate only\n`);
                    return [] as ReadonlyArray<ConfiguredHookWithEvidence>;
                }),
            ),
        );

        // Recorded mean duration per command. Soft-fail to an empty map -> every
        // installed hook costs DEFAULT_SPAWN_MS (estimate path, logged below).
        const summary: ReadonlyArray<HookSummaryRow> = yield* queryHookSummary({ tail: 1000 }).pipe(
            Effect.catch(() => Effect.succeed([] as ReadonlyArray<HookSummaryRow>)),
        );
        const meanByCommand = new Map<string, number>();
        for (const row of summary) {
            if (typeof row.avg_duration_ms === "number" && Number.isFinite(row.avg_duration_ms)) {
                meanByCommand.set(row.command, row.avg_duration_ms);
            }
        }

        const { costs, names, estimated } = dedupeChainCosts(installed, meanByCommand, DEFAULT_SPAWN_MS);

        if (estimated > 0) {
            // stderr keeps stdout clean for the `--json` ledger (see note above).
            process.stderr.write(`hooks bench: ${estimated}/${costs.length} installed hook(s) on ${event} have no recorded duration; using ${DEFAULT_SPAWN_MS}ms estimate for those\n`);
        }

        // Include the candidate itself in the rendered chain (render says "with
        // this"); beforeMs stays the installed-only sum, withMs adds the
        // candidate p50 (composeChain). meta.name is already a clean hook name.
        const chainNames = [...names, meta.name];
        return composeChain(event, costs, candidateP50, budgetMs, chainNames);
    });

/** Fetch one recent `tool_call.input_json` for `tool`, parsed to an object, or
 *  null when none / unparseable. Soft-fails (a DB error -> null) so the bench
 *  always proceeds with an empty payload body. */
const sampleToolInput = (
    tool: string,
): Effect.Effect<Record<string, unknown> | null, never, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const rows = yield* db.query<[Array<{ input_json: string | null }>]>(
            `SELECT input_json FROM tool_call WHERE name = ${surrealString(tool)} AND input_json != NONE ORDER BY ts DESC LIMIT 1;`,
        ).pipe(Effect.catch(() => Effect.succeed([[]] as [Array<{ input_json: string | null }>])));
        const raw = rows?.[0]?.[0]?.input_json;
        if (typeof raw !== "string") return null;
        try {
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>)
                : null;
        } catch {
            return null;
        }
    });

export interface BenchOptions {
    readonly file: string;
    readonly days: number;
    readonly runs: number;
    readonly budgetMs: number;
}

/**
 * Orchestrate the full latency ledger for one SDK hook file:
 *   resolve -> load meta -> sample payload -> spawn-time -> fire-frequency ->
 *   installed-chain budget.
 *
 * loadHookMeta failures (import/validation) are surfaced with a clean stderr
 * line + nonzero exit (mirrors backtest); every graph source is soft-isolated
 * so a missing DB/config degrades a single field instead of aborting.
 */
export const benchHook = (
    opts: BenchOptions,
): Effect.Effect<
    BenchLedger,
    never,
    SurrealClient | FileSystem.FileSystem | Path.Path | HookProviderRegistry
> =>
    Effect.gen(function* () {
        const path = yield* Path.Path;
        const absFile = path.resolve(expandTilde(opts.file));

        // Import + validate. A typed failure -> clean message + nonzero exit.
        const meta = yield* loadHookMeta(absFile).pipe(
            Effect.catchTags({
                SdkHookImportError: (e) =>
                    Effect.promise(async () => {
                        process.stderr.write(`cannot import hook file ${absFile}: ${e.reason}\n`);
                        return exitProcess(1);
                    }),
                SdkHookValidationError: (e) =>
                    Effect.promise(async () => {
                        process.stderr.write(`${absFile}: ${e.reason}\n`);
                        return exitProcess(1);
                    }),
            }),
        );

        const lite: HookMetaLite = {
            name: meta.name,
            events: meta.events,
            matcher: meta.matcher?.tools ? { tools: meta.matcher.tools } : undefined,
        };
        const tools = meta.matcher?.tools ?? [];

        // Representative stdin payload (one real tool_call input when available).
        const firstTool = tools[0];
        const sampleInput = firstTool ? yield* sampleToolInput(firstTool) : null;
        const payload = buildRepresentativePayload(lite, sampleInput, process.cwd());

        // Spawn-time samples; first is the cold warm-up, kept separate. With
        // <2 runs there is no steady-state slice, so perFire falls back to the
        // single sample AND warmup is null (reporting the same value as both
        // warmup and perFire would be misleading).
        const samples = yield* measureSpawn(absFile, payload, opts.runs);
        const rest = samples.slice(1);
        const warmup = rest.length ? (samples[0] ?? null) : null;
        const perFire = percentiles(rest.length ? rest : samples);

        // Fire frequency + projected daily cost. Soft-fail to null.
        const freq = yield* estFiresPerDay(tools, opts.days).pipe(
            Effect.catch(() =>
                Effect.succeed<FireFrequency>({ perDay: null, matched: [...tools], basis: "n/a (db unavailable)" }),
            ),
        );
        const dailyCostMs = freq.perDay != null ? round(perFire.p50 * freq.perDay) : null;

        // Installed-chain budget on the candidate's first event.
        const chain = yield* gatherChain(meta, perFire.p50, opts.budgetMs);

        return {
            name: meta.name,
            perFire,
            warmupMs: warmup != null ? round(warmup) : null,
            spawns: rest.length ? rest.length : samples.length,
            logicMs: null,
            frequency: freq,
            dailyCostMs,
            chain,
        } satisfies BenchLedger;
    });

/** Expand a leading `~` to the user's home directory (mirrors hooks/cli.ts). */
const expandTilde = (p: string): string =>
    p === "~" ? HOME : p.startsWith("~/") ? `${HOME}/${p.slice(2)}` : p;
