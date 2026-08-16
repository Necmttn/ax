// Extracted from cli/index.ts (Phase 2 CLI split)
import { Command, Flag } from "effect/unstable/cli";
import { Effect } from "effect";
import { CacheRead } from "@ax/lib/duckdb/seam";
import { Judgment, checkSidecarRefs, collectSidecarRefs, fetchCacheIds } from "@ax/lib/sqlite";
import {
    collectDoctorReport,
    formatDoctorReport,
    cmdInstall,
    cmdSetup,
    cmdUninstall,
    resolveTelemetryConsent,
    telemetryConsentConflict,
} from "../install.ts";
import { liveVersionDeps, printVersion, updateAxctl } from "../version.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { boolArg, fail, jsonFlag, parseFileHints } from "./shared.ts";

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

export const installCommand = Command.make("install", {
    telemetry: Flag.boolean("telemetry").pipe(Flag.withDefault(false)),
    noTelemetry: Flag.boolean("no-telemetry").pipe(Flag.withDefault(false)),
}, ({ telemetry, noTelemetry }) => {
    // Pure flag validation BEFORE any Effect/install work. fail() calls
    // process.exit(2) synchronously with a clean one-line message - no
    // thrown plain Error, no stack trace (matches ingest.ts/quota.ts/dojo.ts).
    const conflict = telemetryConsentConflict(telemetry, noTelemetry);
    if (conflict !== null) fail(conflict);
    return cmdInstall({ telemetry: resolveTelemetryConsent(telemetry, noTelemetry) });
}).pipe(Command.withDescription("One-shot setup: symlink, optional OTLP receiver (then runs `ax setup`)"));

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

export const collectSidecarDoctorCheck = Effect.gen(function* () {
    const judgment = yield* Judgment;
    const cache = yield* CacheRead;
    const refs = yield* collectSidecarRefs(judgment);
    const ids = yield* fetchCacheIds(cache);
    const result = checkSidecarRefs(refs, ids);
    return {
        name: "sidecar-refs",
        ok: result.ok,
        detail: result.ok
            ? `${result.checked} cache reference(s) valid`
            : `${result.dangling} of ${result.checked} cache reference(s) dangling`,
    };
});

export const doctorCommand = Command.make(
    "doctor",
    { json: jsonFlag },
    ({ json }) => Effect.gen(function* () {
        const report = yield* collectDoctorReport();
        const integrity = yield* collectSidecarDoctorCheck.pipe(Effect.catch((error) => Effect.succeed({
            name: "sidecar-refs",
            ok: false,
            detail: `integrity check unavailable: ${String(error)}`,
        })));
        console.log(formatDoctorReport({ ...report, checks: [...report.checks, integrity] }, json));
    }),
).pipe(Command.withDescription("Check local installation health"));

export const uninstallCommand = Command.make(
    "uninstall",
    { purge: Flag.boolean("purge").pipe(Flag.withDefault(false)) },
    ({ purge }) => cmdUninstall(purge),
).pipe(
    Command.withDescription(
        "Remove the otlpd LaunchAgent and the axctl symlink (--purge also deletes ~/.local/share/ax: binary + data)",
    ),
);

export const lifecycleRuntime: RuntimeManifest = {
    version: { runtime: "none", hidden: true },
    update: { runtime: "none", hidden: true },
    install: "none",
    setup: "none",
    doctor: { runtime: "cache", hidden: true },
    uninstall: { runtime: "none", hidden: true },
};
