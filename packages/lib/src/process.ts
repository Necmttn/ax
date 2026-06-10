import { Context, Effect, Layer, Schema, type Scope } from "effect";

export interface ProcessResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly code: number;
}

export interface ProcessRunOptions {
    readonly cwd?: string;
    readonly timeoutMs?: number;
    readonly env?: Record<string, string | undefined>;
}

/** Spawn options for the scoped helpers. Deadlines are applied by the caller
 *  via `Effect.timeout`/`Effect.timeoutOrElse` (interruption kills the child),
 *  so there is no `timeoutMs` here. */
export type SpawnOptions = Omit<ProcessRunOptions, "timeoutMs">;

export class ProcessError extends Schema.TaggedErrorClass<ProcessError>(
    "ProcessError",
)("ProcessError", {
    command: Schema.String,
    message: Schema.String,
    code: Schema.optional(Schema.Number),
}) {}

export interface ProcessServiceShape {
    /**
     * Spawn a command. Returns the full `ProcessResult` regardless of exit code.
     * Use `exec` for raw output; callers decide how to interpret non-zero exits.
     */
    readonly exec: (
        command: string,
        args: ReadonlyArray<string>,
        options?: ProcessRunOptions,
    ) => Effect.Effect<ProcessResult, ProcessError>;

    /**
     * Best-effort "is this on PATH". Returns false on any failure. Internally
     * uses `command -v` via `/bin/sh -lc` so shell aliases / shims resolve.
     */
    readonly commandExists: (name: string) => Effect.Effect<boolean>;
}

export class ProcessService extends Context.Service<
    ProcessService,
    ProcessServiceShape
>()("ax/ProcessService") {}

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

const spawnChild = (
    command: string,
    args: ReadonlyArray<string>,
    options: SpawnOptions,
) =>
    Bun.spawn([command, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.env !== undefined
            ? { env: options.env as Record<string, string> }
            : {}),
    });

export type SpawnedProcess = ReturnType<typeof spawnChild>;

/** Kill the child if it is still alive, then await its actual exit so the
 *  scope never closes while the process lingers. Never fails. */
const releaseChild = (proc: SpawnedProcess): Effect.Effect<void> =>
    Effect.promise(async () => {
        if (proc.exitCode === null && proc.signalCode === null) {
            try {
                proc.kill();
            } catch {
                /* already dead */
            }
        }
        await Promise.resolve(proc.exited).catch(() => undefined);
    });

/**
 * Canonical interruption-safe spawn: acquires a `Bun.Subprocess` as a scoped
 * resource. Acquisition is uninterruptible (`Effect.acquireRelease` default);
 * when the scope closes - success, failure, OR fiber interruption (including
 * an `Effect.timeout` racing the region) - the release finalizer kills the
 * child if it is still running and waits for it to be reaped.
 */
export const spawnScoped = (
    command: string,
    args: ReadonlyArray<string>,
    options: SpawnOptions = {},
): Effect.Effect<SpawnedProcess, ProcessError, Scope.Scope> =>
    Effect.acquireRelease(
        Effect.try({
            try: () => spawnChild(command, args, options),
            catch: (err) =>
                new ProcessError({
                    command: `${command} ${args.join(" ")}`,
                    message: err instanceof Error ? err.message : String(err),
                }),
        }),
        releaseChild,
    );

/**
 * Spawn a command and await its full output. Built on {@link spawnScoped}, so
 * interrupting the calling fiber (directly or via `Effect.timeout`) kills the
 * child before the effect settles. Resolves with the `ProcessResult` for any
 * exit code; fails with `ProcessError` only when the spawn itself fails.
 */
export const runCommand = Effect.fn("process.runCommand")(
    function* (
        command: string,
        args: ReadonlyArray<string>,
        options: SpawnOptions = {},
    ) {
        const proc = yield* spawnScoped(command, args, options);
        // Stream reads and the exit wait can reject (e.g. a torn-down stream);
        // wrap them so the failure stays a typed ProcessError instead of
        // escaping as a defect (same coverage as the old single-tryPromise
        // bunExec).
        return yield* Effect.tryPromise({
            try: async () => {
                const [stdout, stderr] = await Promise.all([
                    new Response(proc.stdout).text(),
                    new Response(proc.stderr).text(),
                ]);
                await proc.exited;
                return { stdout, stderr, code: proc.exitCode ?? 0 } satisfies ProcessResult;
            },
            catch: (err) =>
                new ProcessError({
                    command: `${command} ${args.join(" ")}`,
                    message: err instanceof Error ? err.message : String(err),
                }),
        });
    },
    (effect) => Effect.scoped(effect),
);

const liveExec = (
    command: string,
    args: ReadonlyArray<string>,
    options: ProcessRunOptions = {},
): Effect.Effect<ProcessResult, ProcessError> => {
    const { timeoutMs, ...spawnOptions } = options;
    const base = runCommand(command, args, spawnOptions);
    if (!timeoutMs) return base;
    return base.pipe(
        // On timeout the fiber running `base` is interrupted, which closes the
        // spawn scope and kills the child (see spawnScoped).
        Effect.timeout(timeoutMs),
        Effect.catchTag("TimeoutError", () =>
            Effect.fail(
                new ProcessError({
                    command: `${command} ${args.join(" ")}`,
                    message: `process timed out after ${timeoutMs}ms`,
                }),
            ),
        ),
    );
};

const liveShape: ProcessServiceShape = {
    exec: liveExec,
    commandExists: (name: string) =>
        liveExec("/bin/sh", ["-lc", `command -v ${shellQuote(name)}`], { timeoutMs: 1000 }).pipe(
            Effect.map((r) => r.code === 0),
            Effect.orElseSucceed(() => false),
        ),
};

export const ProcessServiceLive: Layer.Layer<ProcessService> = Layer.succeed(
    ProcessService,
)(liveShape);

/**
 * Build a mock layer from a routing function. Pass `(cmd, args, opts)` →
 * `ProcessResult | Error`. Anything else fails the effect.
 */
export interface ProcessMock {
    readonly route: (
        command: string,
        args: ReadonlyArray<string>,
        options: ProcessRunOptions,
    ) => ProcessResult | Error;
    readonly commandExists?: (name: string) => boolean;
}

export const ProcessServiceTest = (mock: ProcessMock): Layer.Layer<ProcessService> =>
    Layer.succeed(ProcessService)({
        exec: (command, args, options = {}) => {
            const out = mock.route(command, args, options);
            if (out instanceof Error) {
                return Effect.fail(
                    new ProcessError({
                        command: `${command} ${args.join(" ")}`,
                        message: out.message,
                    }),
                );
            }
            return Effect.succeed(out);
        },
        commandExists: (name) =>
            mock.commandExists ? Effect.succeed(mock.commandExists(name)) : Effect.succeed(false),
    });
