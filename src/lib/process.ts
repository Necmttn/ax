import { Context, Effect, Layer, Schema } from "effect";

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
>()("agentctl/ProcessService") {}

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

const bunExec = (
    command: string,
    args: ReadonlyArray<string>,
    options: ProcessRunOptions,
): Promise<ProcessResult> =>
    new Promise((resolve, reject) => {
        const proc = Bun.spawn([command, ...args], {
            stdout: "pipe",
            stderr: "pipe",
            ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
            ...(options.env !== undefined
                ? { env: options.env as Record<string, string> }
                : {}),
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        if (options.timeoutMs) {
            timer = setTimeout(() => {
                timedOut = true;
                try {
                    proc.kill();
                } catch {
                    /* best effort */
                }
            }, options.timeoutMs);
        }
        Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ])
            .then(([stdout, stderr]) => {
                if (timer) clearTimeout(timer);
                if (timedOut) {
                    reject(new Error(`process timed out after ${options.timeoutMs}ms`));
                    return;
                }
                resolve({ stdout, stderr, code: proc.exitCode ?? 0 });
            })
            .catch((err) => {
                if (timer) clearTimeout(timer);
                reject(err);
            });
    });

const liveExec = (
    command: string,
    args: ReadonlyArray<string>,
    options: ProcessRunOptions = {},
): Effect.Effect<ProcessResult, ProcessError> =>
    Effect.tryPromise({
        try: () => bunExec(command, args, options),
        catch: (err) =>
            new ProcessError({
                command: `${command} ${args.join(" ")}`,
                message: err instanceof Error ? err.message : String(err),
            }),
    });

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
