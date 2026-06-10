import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { prettyPrint } from "@ax/lib/json";
import { HOME } from "@ax/lib/paths";
import { optionValue } from "../config-core/cli-util.ts";
import { HookProviderRegistryDefault } from "./providers/registry.ts";
import { resolveSdkPath, scaffoldWorkspace } from "./sdk-workspace.ts";
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
            console.log(`  ax hooks install ${workspaceDir}/enforce-worktree.ts --providers=claude,codex`);
        }),
).pipe(Command.withDescription("Scaffold the ~/.ax/hooks workspace (package.json + starter guard hooks)"));

/** Spliced into `hooksCommand`'s subcommand list in cli/index.ts. */
export const hooksConfigSubcommands = [
    configCommand,
    addCommand,
    removeCommand,
    editCommand,
    disableCommand,
    enableCommand,
    initCommand,
];
