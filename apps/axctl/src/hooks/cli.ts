import { Effect, Path } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { prettyPrint } from "@ax/lib/json";
import { HOME } from "@ax/lib/paths";
import { optionValue } from "../config-core/cli-util.ts";
import { HookProviderRegistryDefault, ALL_HOOK_PROVIDERS } from "./providers/registry.ts";
import {
    resolveSdkPath,
    scaffoldWorkspace,
    scaffoldFromEmbed,
    isCompiledBinary,
    COMPILED_BINARY_SDK_HOOK_HELP,
} from "./sdk-workspace.ts";
import { HOOKS_EMBED } from "./hooks-embed.gen.ts";
import {
    readAllHooks,
    addHook,
    removeHook,
    editHook,
    disableHook,
    enableHook,
    formatConfiguredHooks,
    type ConfiguredHookWithEvidence,
} from "./config.ts";
import type { HookScope } from "./providers/types.ts";
import { HookNotFoundError } from "./errors.ts";
import { installHookFile, stripAxMarker } from "./sdk-install.ts";
import { installDispatcher, resolveDispatcherPath, resolveShimPath } from "./dispatch-install.ts";
import { GitEnvLive } from "@ax/hooks-sdk/git-env";
import { fetchRows, replayRows, summarize, formatReport } from "./backtest.ts";
import { benchHook, renderLedger } from "./bench.ts";
import type { HookDefinition } from "@ax/hooks-sdk/define";
import { fetchHookLatencyRegression, renderHookLatency } from "../queries/hook-latency.ts";

/**
 * `ax hooks` config CRUD subcommands (provider-agnostic: claude/cursor/codex/
 * opencode). Spliced into the existing `hooksCommand` group in cli/index.ts.
 * Every handler provides `HookProviderRegistryDefault`; SurrealClient +
 * FileSystem + Path come from AppLayer.
 */

const json = Flag.boolean("json").pipe(Flag.withDefault(false));
const asScope = (s: string): HookScope => (s === "project" || s === "local" ? s : "global");

/** Resolve a hook id (or ax marker id) to the EXACT row to mutate. Fails on an
 *  ambiguous id (8-char ids + copyable markers can collide) rather than silently
 *  mutating the first match. */
const locate = (id: string) =>
    Effect.gen(function* () {
        const all = yield* readAllHooks({ withEvidence: false });
        const matches = all.filter((h) => h.id === id || h.axId === id);
        if (matches.length === 0) {
            return yield* new HookNotFoundError({ id, reason: "no configured hook with that id", candidates: all.slice(0, 8).map((h) => h.id) });
        }
        if (matches.length > 1) {
            return yield* new HookNotFoundError({ id, reason: "ambiguous - matches multiple hooks", candidates: matches.map((h) => `${h.provider}:${h.scope}:${h.file}`) });
        }
        return matches[0]!;
    });

/** Mutation target derived from a located row: exact provider/scope/file/id. */
const targetOf = (h: { provider: string; scope: HookScope; file: string; id: string }) =>
    ({ provider: h.provider, scope: h.scope, file: h.file, id: h.id });

const configCommand = Command.make(
    "config",
    {
        provider: Flag.string("provider").pipe(Flag.optional),
        scope: Flag.string("scope").pipe(Flag.optional),
        event: Flag.string("event").pipe(Flag.optional),
        noEvidence: Flag.boolean("no-evidence").pipe(Flag.withDefault(false)),
        json,
    },
    ({ provider, scope, event, noEvidence, json: asJson }) => {
        const sc = optionValue(scope);
        return readAllHooks({
            providerFilter: optionValue(provider),
            scopeFilter: sc !== undefined ? asScope(sc) : undefined,
            eventFilter: optionValue(event),
            withEvidence: !noEvidence,
        }).pipe(
            Effect.map((rows: ReadonlyArray<ConfiguredHookWithEvidence>) =>
                console.log(asJson ? prettyPrint(rows) : formatConfiguredHooks(rows)),
            ),
            Effect.provide(HookProviderRegistryDefault),
        );
    },
).pipe(Command.withDescription("List configured hooks across providers/scopes (+fired evidence)"));

const addCommand = Command.make(
    "add",
    {
        provider: Flag.string("provider"),
        event: Flag.string("event"),
        command: Flag.string("command"),
        matcher: Flag.string("matcher").pipe(Flag.optional),
        scope: Flag.string("scope").pipe(Flag.withDefault("global")),
        timeout: Flag.integer("timeout").pipe(Flag.optional),
    },
    ({ provider, event, command, matcher, scope, timeout }) =>
        addHook({
            provider,
            scope: asScope(scope),
            input: {
                event,
                command,
                matcher: optionValue(matcher) ?? null,
                ...(optionValue(timeout) !== undefined ? { timeout: optionValue(timeout)! } : {}),
            },
        }).pipe(
            Effect.map((path) => console.log(`added ${provider} ${event} hook -> ${path}`)),
            Effect.provide(HookProviderRegistryDefault),
        ),
).pipe(Command.withDescription("Add a hook (--provider --event --command [--matcher --scope --timeout])"));

const removeCommand = Command.make(
    "remove",
    { id: Argument.string("id") },
    ({ id }) =>
        locate(id).pipe(
            Effect.flatMap((h) => removeHook(targetOf(h))),
            Effect.map(() => console.log(`removed hook ${id}`)),
            Effect.provide(HookProviderRegistryDefault),
        ),
).pipe(Command.withDescription("Remove a hook by id"));

const editCommand = Command.make(
    "edit",
    {
        id: Argument.string("id"),
        command: Flag.string("command").pipe(Flag.optional),
        matcher: Flag.string("matcher").pipe(Flag.optional),
        timeout: Flag.integer("timeout").pipe(Flag.optional),
    },
    ({ id, command, matcher, timeout }) =>
        locate(id).pipe(
            Effect.flatMap((h) =>
                editHook({
                    ...targetOf(h),
                    patch: {
                        ...(optionValue(command) !== undefined ? { command: optionValue(command)! } : {}),
                        ...(optionValue(matcher) !== undefined ? { matcher: optionValue(matcher)! } : {}),
                        ...(optionValue(timeout) !== undefined ? { timeout: optionValue(timeout)! } : {}),
                    },
                }),
            ),
            Effect.map(() => console.log(`edited hook ${id}`)),
            Effect.provide(HookProviderRegistryDefault),
        ),
).pipe(Command.withDescription("Edit a hook by id (--command --matcher --timeout)"));

const disableCommand = Command.make(
    "disable",
    { id: Argument.string("id") },
    ({ id }) =>
        locate(id).pipe(
            Effect.flatMap((h) => disableHook(targetOf(h))),
            Effect.map(() => console.log(`disabled hook ${id} (parked)`)),
            Effect.provide(HookProviderRegistryDefault),
        ),
).pipe(Command.withDescription("Disable a hook by id (park aside, recoverable)"));

const enableCommand = Command.make(
    "enable",
    { id: Argument.string("id") },
    ({ id }) =>
        locate(id).pipe(
            Effect.flatMap((h) => enableHook(targetOf(h))),
            Effect.map(() => console.log(`enabled hook ${id}`)),
            Effect.provide(HookProviderRegistryDefault),
        ),
).pipe(Command.withDescription("Re-enable a parked hook by id"));

/** Expand a leading `~` to the user's home directory. */
const expandTilde = (p: string): string =>
    p === "~" ? HOME : p.startsWith("~/") ? `${HOME}/${p.slice(2)}` : p;

const initCommand = Command.make(
    "init",
    {
        dir: Flag.string("dir").pipe(Flag.withDefault("~/.ax/hooks")),
        noInstall: Flag.boolean("no-install").pipe(Flag.withDefault(false)),
    },
    ({ dir, noInstall }) =>
        Effect.gen(function* () {
            const workspaceDir = expandTilde(dir);

            // Compiled binary: no source tree to make a `file:` dep against, so
            // scaffold the pre-bundled standalone hooks baked into the binary.
            // They inline effect and fire as `bun <file>.js` - no package.json,
            // no `bun install`, fully offline. (issue #573, follow-up to #564)
            if (isCompiledBinary()) {
                if (Object.keys(HOOKS_EMBED).length === 0) {
                    // Defensive: a binary built without the embed manifest. Should
                    // not happen via `bun run build`, but don't dead-end opaquely.
                    process.stderr.write(`${COMPILED_BINARY_SDK_HOOK_HELP}\n`);
                    process.exit(1);
                }
                const written = yield* scaffoldFromEmbed(HOOKS_EMBED, workspaceDir);
                console.log(`hook workspace ready at ${workspaceDir} (bundled hooks for the compiled binary)`);
                if (written.length === 0) {
                    console.log("  (all hooks already present - nothing written)");
                } else {
                    for (const path of written) console.log(`  wrote ${path}`);
                }
                console.log("");
                console.log("requires `bun` on PATH (hooks fire as `bun <file>.js`).");
                console.log("next steps:");
                console.log(`  ax hooks install --all --providers=claude,codex   (install every guard at once)`);
                return;
            }

            const sdkPath = yield* resolveSdkPath();
            const written = yield* scaffoldWorkspace({
                dir: workspaceDir,
                sdkPath,
                install: !noInstall,
            });
            console.log(`hook workspace ready at ${workspaceDir}`);
            for (const path of written) console.log(`  wrote ${path}`);
            if (noInstall) console.log(`  (skipped bun install - run it in ${workspaceDir} before use)`);
            console.log("");
            console.log("next steps:");
            console.log(`  ax hooks backtest ${workspaceDir}/enforce-worktree.ts --days=14   (replay history through it first)`);
            console.log(`  ax hooks install --all --providers=claude,codex   (install every guard at once)`);
        }),
).pipe(Command.withDescription("Scaffold the ~/.ax/hooks workspace (package.json + starter guard hooks; bundled .js hooks on a compiled binary)"));

const KNOWN_PROVIDERS = ALL_HOOK_PROVIDERS.map((p) => p.name);

const installCommand = Command.make(
    "install",
    {
        file: Argument.string("file").pipe(Argument.optional),
        providers: Flag.string("providers").pipe(Flag.withDefault("claude,codex")),
        scope: Flag.string("scope").pipe(Flag.withDefault("global")),
        all: Flag.boolean("all").pipe(Flag.withDefault(false)),
        daemon: Flag.boolean("daemon").pipe(Flag.withDefault(false)),
        dir: Flag.string("dir").pipe(Flag.withDefault("~/.ax/hooks")),
    },
    ({ file, providers, scope, all, daemon, dir }) =>
        Effect.gen(function* () {
            // Works on both source (.ts against the @ax/hooks-sdk workspace) and a
            // compiled binary (the standalone .js bundles `ax hooks init` wrote
            // from the embed - self-contained, so the binary can dynamically
            // import them to read meta). A missing file is caught by
            // installHookFile (SdkHookFileNotFoundError). (issue #573)
            const path = yield* Path.Path;
            const providerList = providers.split(",").map((p) => p.trim()).filter(Boolean);

            // Validate provider names against the registry
            const unknown = providerList.filter((p) => !KNOWN_PROVIDERS.includes(p));
            if (unknown.length > 0) {
                console.error(`Unknown providers: ${unknown.join(", ")}. Known: ${KNOWN_PROVIDERS.join(", ")}`);
                process.exit(1);
            }

            // --all installs the SINGLE dispatcher (one spawn multiplexes every
            // guard) and migrates off any legacy per-guard entries; otherwise
            // install the single positional file.
            if (all) {
                const workspaceDir = expandTilde(dir);
                // --daemon installs the shim (POST to `ax serve`, fall back to the
                // bundle); default installs the dispatcher directly.
                const commandPath = daemon
                    ? yield* resolveShimPath(workspaceDir)
                    : yield* resolveDispatcherPath(workspaceDir);
                if (commandPath === null) {
                    const missing = daemon ? "dispatch-shim.ts/.js" : "dispatch.ts/.js";
                    console.error(
                        `no ${daemon ? "shim" : "dispatcher"} found in ${workspaceDir} (${missing}). Run 'ax hooks init' first to scaffold it.`,
                    );
                    process.exit(1);
                }
                const { entries, removed } = yield* installDispatcher(
                    commandPath,
                    workspaceDir,
                    providerList,
                    asScope(scope),
                );
                const installedEntries = entries.filter((e) => !e.skipped);
                const skippedEntries = entries.filter((e) => e.skipped);
                console.log(
                    daemon
                        ? `daemon shim: ${path.basename(commandPath)} (POST /hooks/eval, falls back to the bundle)`
                        : `dispatcher: ${path.basename(commandPath)} (one spawn multiplexes all guards)`,
                );
                for (const e of installedEntries) {
                    const m = e.input.matcher ? ` [matcher: ${e.input.matcher}]` : "";
                    console.log(`  installed ${e.provider} ${e.input.event}${m} -> ${e.writtenPath}`);
                }
                for (const e of skippedEntries) {
                    const m = e.input.matcher ? ` [matcher: ${e.input.matcher}]` : "";
                    console.log(`  already installed - skipped ${e.provider} ${e.input.event}${m}`);
                }
                for (const r of removed) {
                    console.log(`  migrated off legacy ${r.provider} ${r.event} (${stripAxMarker(r.command)})`);
                }
                console.log("");
                const parts = [`${installedEntries.length} dispatcher hook(s) installed`];
                if (skippedEntries.length > 0) parts.push(`${skippedEntries.length} skipped (already installed)`);
                if (removed.length > 0) parts.push(`${removed.length} legacy per-guard entr${removed.length === 1 ? "y" : "ies"} migrated`);
                console.log(`${parts.join(", ")}.`);
                if (installedEntries.length > 0 && providerList.includes("codex")) {
                    console.log("note (codex): approve the new hook(s) when prompted (trust review).");
                }
                return;
            }

            const filePathArg = optionValue(file);
            if (filePathArg === undefined) {
                console.error("pass a hook file path, or --all to install the dispatcher (all guards).");
                process.exit(1);
            }
            const absFile = path.resolve(expandTilde(filePathArg));
            const results = yield* installHookFile(absFile, providerList, asScope(scope));
            for (const entry of results) {
                const matcherStr = entry.input.matcher ? ` [matcher: ${entry.input.matcher}]` : "";
                if (entry.skipped) {
                    console.log(`already installed - skipped ${entry.provider} ${entry.input.event}${matcherStr}`);
                    continue;
                }
                console.log(`installed ${entry.provider} ${entry.input.event}${matcherStr} -> ${entry.writtenPath}`);
                console.log(`  command: ${entry.input.command}`);
            }
            const installed = results.filter((r) => !r.skipped).length;
            const skipped = results.filter((r) => r.skipped).length;
            console.log("");
            console.log(`${installed} hook(s) installed${skipped > 0 ? `, ${skipped} skipped (already installed)` : ""}.`);
            if (installed > 0 && providerList.includes("codex")) {
                console.log("note (codex): approve the new hook(s) when prompted (trust review).");
            }
        }).pipe(Effect.provide(HookProviderRegistryDefault)),
).pipe(Command.withDescription("Install a SDK hook file into provider configs, or --all to install the dispatcher (multiplexes all guards) + migrate off legacy per-guard entries; add --daemon to install the warm daemon shim instead (--providers=claude,codex --scope=global --dir=~/.ax/hooks)"));

const backtestCommand = Command.make(
    "backtest",
    {
        file: Argument.string("file"),
        days: Flag.integer("days").pipe(Flag.withDefault(30)),
        provider: Flag.string("provider").pipe(Flag.optional),
        json: Flag.boolean("json").pipe(Flag.withDefault(false)),
    },
    ({ file, days, provider, json: asJson }) =>
        Effect.gen(function* () {
            const path = yield* Path.Path;
            const absFile = path.resolve(expandTilde(file));

            // Import the hook module. A failed import exits non-zero immediately.
            const modResult = yield* Effect.promise(
                () =>
                    import(absFile).catch((e: unknown) => {
                        process.stderr.write(
                            `cannot import hook file ${absFile}: ${e instanceof Error ? e.message : String(e)}\n`,
                        );
                        process.exit(1);
                    }) as Promise<{ default?: unknown }>,
            );

            const def = modResult?.default as HookDefinition | undefined;
            if (
                !def ||
                typeof def !== "object" ||
                typeof (def as HookDefinition).run !== "function"
            ) {
                process.stderr.write(
                    `${absFile}: default export must be a defineHook() result with a 'run' function\n`,
                );
                process.exit(1);
            }

            const hookDef = def as HookDefinition;
            const providerFilter = optionValue(provider) ?? null;
            const toolNames = hookDef.matcher?.tools ? [...hookDef.matcher.tools] : [];

            // Fetch rows from DB (read-only SELECTs). DB unavailable -> friendly error + exit.
            const fetched = yield* fetchRows(days, toolNames, providerFilter).pipe(
                Effect.catchTag("DbError", (e) =>
                    Effect.promise(async () => {
                        process.stderr.write(
                            `DB unreachable or query failed: ${e.message}\n` +
                            "Start the DB with 'axctl daemon start' and retry.\n",
                        );
                        process.exit(1);
                    }),
                ),
            );

            // Replay through the hook with GitEnvLive (state-dependent checks
            // use the CURRENT repo state - see caveat in report).
            const results = yield* replayRows(hookDef, fetched.rows).pipe(
                Effect.provide(GitEnvLive),
            );

            const summary = summarize(results, fetched.skipped);

            if (asJson) {
                console.log(prettyPrint(summary));
                return;
            }

            console.log(formatReport(hookDef.name, days, summary));
        }),
).pipe(Command.withDescription("Replay historical tool_call rows through an SDK hook in-process (--days=30 --provider=claude --json)"));

const benchCommand = Command.make(
    "bench",
    {
        file: Argument.string("file"),
        days: Flag.integer("days").pipe(Flag.withDefault(30)),
        runs: Flag.integer("runs").pipe(Flag.withDefault(20)),
        budgetMs: Flag.integer("budget-ms").pipe(Flag.withDefault(250)),
        json: Flag.boolean("json").pipe(Flag.withDefault(false)),
    },
    ({ file, days, runs, budgetMs, json: asJson }) =>
        Effect.gen(function* () {
            const ledger = yield* benchHook({ file, days, runs, budgetMs });
            console.log(asJson ? prettyPrint(ledger) : renderLedger(ledger));
        }).pipe(Effect.provide(HookProviderRegistryDefault)),
).pipe(Command.withDescription("Latency ledger for an SDK hook: per-fire p50/p95 (spawn) + fires/day + installed-chain budget (--days=30 --runs=20 --budget-ms=250 --json)"));

const latencyCommand = Command.make(
    "latency",
    {
        days: Flag.integer("days").pipe(Flag.withDefault(7)),
        baseline: Flag.integer("baseline").pipe(Flag.withDefault(21)),
        json: Flag.boolean("json").pipe(Flag.withDefault(false)),
    },
    ({ days, baseline, json: asJson }) =>
        fetchHookLatencyRegression({ recentDays: days, baselineDays: baseline }).pipe(
            Effect.flatMap((report) =>
                Effect.sync(() => {
                    console.log(asJson ? prettyPrint(report) : renderHookLatency(report));
                }),
            ),
            Effect.catchTag("DbError", (e) =>
                Effect.promise(async () => {
                    process.stderr.write(
                        `DB unreachable or query failed: ${e.message}\n` +
                        "Start the DB with 'axctl daemon start' and retry.\n",
                    );
                    process.exit(1);
                }),
            ),
        ),
).pipe(Command.withDescription("Regression lens over hook_command_invocation.duration_ms: compare recent (--days, default 7) vs baseline (--baseline, default 21) p95 per hook; flags regressions (factor 1.5, min 15ms delta, min 20 samples). Empty-state when duration_ms is absent. (--json)"));

/** Spliced into `hooksCommand`'s subcommand list in cli/index.ts. */
export const hooksConfigSubcommands = [
    configCommand,
    addCommand,
    removeCommand,
    editCommand,
    disableCommand,
    enableCommand,
    initCommand,
    installCommand,
    backtestCommand,
    benchCommand,
    latencyCommand,
];
