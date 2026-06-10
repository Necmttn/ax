// Extracted from cli/index.ts (Phase 2 CLI split)
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { cmdDaemon, cmdDoctor, cmdInstall, cmdSetup, cmdUninstall } from "../install.ts";
import { liveVersionDeps, printVersion, updateAxctl } from "../version.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { boolArg, jsonFlag, parseFileHints } from "./shared.ts";

const checkFlag = Flag.boolean("check").pipe(Flag.withDefault(false));
const bannerFlag = Flag.boolean("banner").pipe(Flag.withDefault(false));

export const versionCommand = Command.make(
    "version",
    {
        check: checkFlag,
        json: jsonFlag,
        banner: bannerFlag,
    },
    ({ check, json, banner }) =>
        Effect.promise(() =>
            printVersion(
                [...boolArg("check", check), ...boolArg("json", json), ...boolArg("banner", banner)],
                liveVersionDeps,
            ),
        ),
).pipe(Command.withDescription("Print the installed version and optionally check GitHub releases"));

export const updateCommand = Command.make(
    "update",
    {
        check: checkFlag,
        json: jsonFlag,
    },
    ({ check, json }) =>
        Effect.promise(() =>
            updateAxctl([...boolArg("check", check), ...boolArg("json", json)], liveVersionDeps),
        ),
).pipe(Command.withDescription("Update axctl from the latest GitHub release"));

export const installCommand = Command.make("install", {}, () =>
    cmdInstall(),
).pipe(Command.withDescription("One-shot setup: daemon, watcher, symlink (then runs `ax setup`)"));

export const setupCommand = Command.make(
    "setup",
    {
        agents: Flag.string("agents").pipe(Flag.optional),
        yes: Flag.boolean("yes").pipe(Flag.withDefault(false)),
        agentPrompt: Flag.boolean("agent-prompt").pipe(Flag.withDefault(false)),
    },
    ({ agents, yes, agentPrompt }) =>
        cmdSetup({
            ...(agents._tag === "Some" ? { agents: parseFileHints(agents) } : {}),
            yes,
            agentPromptOnly: agentPrompt,
        }),
).pipe(
    Command.withDescription(
        "Install the agent skills and verify; hands ingest to your agent via the onboarding brief. " +
        "--agents=claude-code,codex  --yes  --agent-prompt (print just the paste-to-agent block)",
    ),
);

const daemonStatusCommand = Command.make(
    "status",
    { json: jsonFlag },
    ({ json }) => cmdDaemon(["status", ...boolArg("json", json)]),
).pipe(Command.withDescription("Show daemon and watcher status"));

const daemonStartCommand = Command.make("start", {}, () =>
    cmdDaemon(["start"]),
).pipe(Command.withDescription("Start the daemon and watcher"));

const daemonStopCommand = Command.make("stop", {}, () =>
    cmdDaemon(["stop"]),
).pipe(Command.withDescription("Stop the daemon and watcher without deleting plists"));

const daemonRestartCommand = Command.make("restart", {}, () =>
    cmdDaemon(["restart"]),
).pipe(Command.withDescription("Restart the daemon and watcher"));

export const daemonCommand = Command.make("daemon").pipe(
    Command.withDescription("Manage local launchd services"),
    Command.withSubcommands([
        daemonStatusCommand,
        daemonStartCommand,
        daemonStopCommand,
        daemonRestartCommand,
    ]),
);

export const doctorCommand = Command.make(
    "doctor",
    { json: jsonFlag },
    ({ json }) => cmdDoctor(boolArg("json", json)),
).pipe(Command.withDescription("Check local installation health"));

export const uninstallCommand = Command.make(
    "uninstall",
    { purge: Flag.boolean("purge").pipe(Flag.withDefault(false)) },
    ({ purge }) => cmdUninstall(purge),
).pipe(
    Command.withDescription(
        "Remove launchd plists and the axctl symlink (--purge also deletes ~/.local/share/ax: binary + data)",
    ),
);

export const lifecycleRuntime: RuntimeManifest = {
    version: "none",
    update: "none",
    install: "none",
    setup: "none",
    daemon: "none",
    doctor: "none",
    uninstall: "none",
};
