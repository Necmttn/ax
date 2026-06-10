// Extracted from cli/index.ts (Phase 2 CLI split)
import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { prettyPrint } from "@ax/lib/json";
import type { TelemetryHarness } from "@ax/lib/telemetry-base";
import {
    buildFileContextHookResponse,
    parseFileContextHookFlags,
    parseFileContextHookStdin,
    type FileContextHookInput,
} from "../../hooks/file-context-hook.ts";
import { recordHookFire } from "../../hooks/telemetry.ts";
import { hooksConfigSubcommands } from "../../hooks/cli.ts";
import { formatHookLogRowsTsv, queryHookLog } from "../../hooks/log.ts";
import {
    formatHookInvocationRows,
    formatHookSummaryRows,
    queryHookInvocations,
    queryHookSession,
    queryHookSummary,
} from "../../queries/hooks.ts";
import {
    backtestEnforceWorktreeCase,
    formatFeedbackBacktestSummary,
} from "../../queries/feedback-cases.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { jsonFlag, optionValue, parseFileHints } from "./shared.ts";

const readStdinAll = (): Promise<string> =>
    new Promise((resolve, reject) => {
        let data = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
            data += chunk;
        });
        process.stdin.on("end", () => resolve(data));
        process.stdin.on("error", reject);
    });

const mergeHookInputs = (
    base: FileContextHookInput,
    overrides: FileContextHookInput,
): FileContextHookInput => ({
    event: overrides.event !== "unknown" ? overrides.event : base.event,
    task: overrides.task ? overrides.task : base.task,
    files: overrides.files.length > 0 ? overrides.files : base.files,
    lookupPaths: overrides.files.length > 0 ? overrides.lookupPaths : base.lookupPaths,
    sessionId: overrides.sessionId ?? base.sessionId,
    format: overrides.format !== "plain" ? overrides.format : base.format,
});

const hookFileContextCommand = Command.make(
    "file-context",
    {
        event: Flag.string("event").pipe(Flag.optional),
        task: Flag.string("task").pipe(Flag.optional),
        file: Flag.string("file").pipe(Flag.optional),
        files: Flag.string("files").pipe(Flag.optional),
        sessionId: Flag.string("session-id").pipe(Flag.optional),
        format: Flag.string("format").pipe(Flag.optional),
        json: jsonFlag,
        stdin: Flag.boolean("stdin").pipe(Flag.withDefault(false)),
    },
    ({ event, task, file, files, sessionId, format, json, stdin }) =>
        Effect.gen(function* () {
            const flagFiles = [
                ...parseFileHints(file),
                ...parseFileHints(files),
            ];
            const flagInput = parseFileContextHookFlags({
                event: optionValue(event) ?? null,
                task: optionValue(task) ?? null,
                files: flagFiles,
                sessionId: optionValue(sessionId) ?? null,
                format: optionValue(format) ?? null,
            });
            const shouldReadStdin = stdin || !process.stdin.isTTY;
            const stdinInput = shouldReadStdin
                ? yield* Effect.promise(() => readStdinAll()).pipe(
                    Effect.map((text) =>
                        text.trim().length > 0 ? parseFileContextHookStdin(text) : null,
                    ),
                )
                : null;
            const merged = stdinInput ? mergeHookInputs(stdinInput, flagInput) : flagInput;
            const startMs = performance.now();
            const response = yield* buildFileContextHookResponse(merged);
            const latencyMs = Math.round(performance.now() - startMs);

            if (json || merged.format === "json") {
                console.log(prettyPrint(response));
            } else if (merged.format === "claude") {
                // Claude Code hook protocol: PreToolUse hook output is shown to
                // the user as plain stdout but is NOT injected into the model's
                // context unless wrapped as JSON with `hookSpecificOutput.
                // additionalContext`. Emit the envelope only when we have
                // something to inject; emit nothing otherwise so Claude Code
                // doesn't show an empty additionalContext block to the user.
                if (response.inject && response.context.length > 0) {
                    console.log(JSON.stringify({
                        hookSpecificOutput: {
                            hookEventName: "PreToolUse",
                            additionalContext: response.context,
                        },
                    }));
                }
            } else if (response.inject && response.context.length > 0) {
                // Default plain format for shell/manual use: emit the raw memory block.
                console.log(response.context);
            }

            const harness: TelemetryHarness = merged.format === "claude" ? "claude" : "unknown";
            yield* recordHookFire({
                input: merged,
                decision: { inject: response.inject, reason: response.reason },
                priorSessions: response.evidence.prior_file_sessions,
                corrections: response.evidence.corrections,
                commits: response.evidence.commits,
                harness,
                latencyMs,
            });
        }),
).pipe(Command.withDescription("Decide and emit file-context memory for an agent harness hook"));

const hookLogCommand = Command.make(
    "log",
    {
        tail: Flag.integer("tail").pipe(Flag.withDefault(20)),
        since: Flag.integer("since").pipe(Flag.optional),
        reason: Flag.string("reason").pipe(Flag.optional),
        file: Flag.string("file").pipe(Flag.optional),
        inject: Flag.string("inject").pipe(Flag.optional),
        harness: Flag.string("harness").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ tail, since, reason, file, inject, harness, json }) =>
        Effect.gen(function* () {
            const injectStr = optionValue(inject);
            const rows = yield* queryHookLog({
                tail,
                sinceHours: optionValue(since),
                reason: optionValue(reason),
                file: optionValue(file),
                inject: injectStr === undefined ? undefined : injectStr === "true",
                harness: optionValue(harness),
            });
            if (json) {
                console.log(prettyPrint(rows));
                return;
            }
            console.log(formatHookLogRowsTsv(rows));
        }),
).pipe(Command.withDescription("Tail and filter hook_fire telemetry rows"));

export const hookCommand = Command.make("hook").pipe(
    Command.withDescription("Generic agent harness hooks (file-context, log, ...)"),
    Command.withSubcommands([hookFileContextCommand, hookLogCommand]),
);

const hooksSummaryCommand = Command.make(
    "summary",
    {
        since: Flag.integer("since").pipe(Flag.optional),
        tail: Flag.integer("tail").pipe(Flag.withDefault(20)),
        command: Flag.string("command").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ since, tail, command, json }) =>
        Effect.gen(function* () {
            const rows = yield* queryHookSummary({
                sinceDays: optionValue(since),
                tail,
                command: optionValue(command),
            });
            if (json) {
                console.log(prettyPrint(rows));
                return;
            }
            console.log(formatHookSummaryRows(rows));
        }),
).pipe(Command.withDescription("Summarize native harness hook command invocations"));

const hooksInvocationsCommand = Command.make(
    "invocations",
    {
        since: Flag.integer("since").pipe(Flag.optional),
        tail: Flag.integer("tail").pipe(Flag.withDefault(50)),
        command: Flag.string("command").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ since, tail, command, json }) =>
        Effect.gen(function* () {
            const rows = yield* queryHookInvocations({
                sinceDays: optionValue(since),
                tail,
                command: optionValue(command),
            });
            if (json) {
                console.log(prettyPrint(rows));
                return;
            }
            console.log(formatHookInvocationRows(rows));
        }),
).pipe(Command.withDescription("List native harness hook command invocations"));

const hooksSessionCommand = Command.make(
    "session",
    {
        sessionId: Argument.string("session-id"),
        json: jsonFlag,
    },
    ({ sessionId, json }) =>
        Effect.gen(function* () {
            const rows = yield* queryHookSession(sessionId);
            if (json) {
                console.log(prettyPrint(rows));
                return;
            }
            console.log(formatHookInvocationRows(rows));
        }),
).pipe(Command.withDescription("List native harness hook command invocations for one session"));

const hooksBacktestCase = Argument.choice("case", ["enforce-worktree"] as const).pipe(
    Argument.withDefault("enforce-worktree"),
);

const hooksBacktestCommand = Command.make(
    "backtest",
    {
        caseName: hooksBacktestCase,
        since: Flag.integer("since").pipe(Flag.optional),
        tail: Flag.integer("tail").pipe(Flag.withDefault(100)),
        window: Flag.integer("window").pipe(Flag.withDefault(3)),
        noPersist: Flag.boolean("no-persist"),
        json: jsonFlag,
    },
    ({ since, tail, window, noPersist, json }) =>
        Effect.gen(function* () {
            const summary = yield* backtestEnforceWorktreeCase({
                sinceDays: optionValue(since),
                tail,
                window,
                persist: !noPersist,
            });
            if (json) {
                console.log(prettyPrint(summary));
                return;
            }
            console.log(formatFeedbackBacktestSummary(summary));
        }),
).pipe(Command.withDescription("Run deterministic feedback-case backtests for hook evidence"));

export const hooksCommand = Command.make("hooks").pipe(
    Command.withDescription("Hook config CRUD (config/add/remove/edit/disable/enable) + evidence (summary/invocations/session/backtest)"),
    Command.withSubcommands([
        ...hooksConfigSubcommands,
        hooksSummaryCommand,
        hooksInvocationsCommand,
        hooksSessionCommand,
        hooksBacktestCommand,
    ]),
);

export const hooksRuntime: RuntimeManifest = {
    hook: "db",
    hooks: "db",
};
