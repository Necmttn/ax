import { expect, test } from "bun:test";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopIngestScheduler from "./DesktopIngestScheduler.ts";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** `ax ingest` is always built via `ChildProcess.make` (never piped), so this
 *  narrows the `Command` union for assertions without a cast at every call site. */
function asStandardCommand(command: ChildProcess.Command): ChildProcess.StandardCommand {
    if (command._tag !== "StandardCommand") {
        throw new Error(`expected a StandardCommand, got ${command._tag}`);
    }
    return command;
}

const testEnv: DesktopIngestScheduler.IngestEnv = {
    bunBinaryPath: "/opt/ax/bun",
    axSourceEntry: "/repo/apps/axctl/src/cli/index.ts",
    axSourceRoot: "/repo",
};

/**
 * A `ChildProcessSpawner` that records every command spawned and resolves
 * each spawn's exit code immediately with the given status - `ax ingest` is a
 * one-shot run, so the fake never needs a real process lifecycle.
 */
const recordingSpawner = (exitStatus = 0) => {
    const commands: Array<ChildProcess.Command> = [];
    const spawner = ChildProcessSpawner.make((command: ChildProcess.Command) => {
        commands.push(command);
        return Effect.succeed(
            ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(1000 + commands.length),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitStatus)),
                isRunning: Effect.succeed(false),
                kill: () => Effect.void,
                stdin: Sink.drain,
                stdout: Stream.empty,
                stderr: Stream.empty,
                all: Stream.empty,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
                unref: Effect.succeed(Effect.void),
            }),
        );
    });
    return { spawner, commands } as const;
};

// ---------------------------------------------------------------------------
// triggerIngest
// ---------------------------------------------------------------------------

test("triggerIngest spawns `bun <axSourceEntry> ingest --since=<sinceDays>`", async () => {
    const { spawner, commands } = recordingSpawner();

    await Effect.runPromise(
        DesktopIngestScheduler.triggerIngest(testEnv, 7).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
    );

    expect(commands.length).toBe(1);
    const command = asStandardCommand(commands[0]!);
    expect(command.command).toBe("/opt/ax/bun");
    expect(command.args).toEqual([
        "/repo/apps/axctl/src/cli/index.ts",
        "ingest",
        "--since=7",
    ]);
    expect(command.options.cwd).toBe("/repo");
    // Without extendEnv:true the child gets NO environment at all (not even
    // PATH/HOME) - see the comment in DesktopIngestScheduler.ts.
    expect(command.options.extendEnv).toBe(true);
});

test("triggerIngest does not throw on a non-zero exit (logs and swallows)", async () => {
    const { spawner, commands } = recordingSpawner(1);

    await Effect.runPromise(
        DesktopIngestScheduler.triggerIngest(testEnv, 1).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
    );

    expect(commands.length).toBe(1);
});

// ---------------------------------------------------------------------------
// run - the scheduling loop
// ---------------------------------------------------------------------------

test("run fires an initial ingest immediately, before any interval elapses", async () => {
    const { spawner, commands } = recordingSpawner();

    const program = Effect.scoped(
        Effect.gen(function* () {
            yield* Effect.forkScoped(
                DesktopIngestScheduler.run({
                    env: testEnv,
                    sinceDays: 7,
                    interval: Duration.minutes(5),
                }),
            );
            // No interval elapses; only the immediate first run should have fired.
            yield* TestClock.adjust(Duration.zero);
            return commands.length;
        }),
    ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(TestClock.layer()),
    );

    expect(await Effect.runPromise(program)).toBe(1);
});

test("run fires again after each configured interval", async () => {
    const { spawner, commands } = recordingSpawner();

    const counts = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                yield* Effect.forkScoped(
                    DesktopIngestScheduler.run({
                        env: testEnv,
                        sinceDays: 1,
                        interval: Duration.minutes(5),
                    }),
                );
                yield* TestClock.adjust(Duration.zero);
                const afterInitial = commands.length;
                yield* TestClock.adjust(Duration.minutes(5));
                const afterFirstTick = commands.length;
                yield* TestClock.adjust(Duration.minutes(5));
                const afterSecondTick = commands.length;
                return { afterInitial, afterFirstTick, afterSecondTick };
            }),
        ).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provide(TestClock.layer()),
        ),
    );

    expect(counts).toEqual({
        afterInitial: 1,
        afterFirstTick: 2,
        afterSecondTick: 3,
    });
});

test("a failed ingest run does not stop the loop - it recovers on the next tick", async () => {
    // The first spawn attempt fails outright (e.g. bun not found); later ticks
    // succeed. The scheduler must keep ticking rather than die on first failure.
    const calls = { count: 0 };
    const commands: Array<ChildProcess.Command> = [];
    const spawner = ChildProcessSpawner.make((command: ChildProcess.Command) => {
        commands.push(command);
        calls.count += 1;
        return calls.count === 1
            ? Effect.die(new Error("ENOENT: bun not found"))
            : Effect.succeed(
                  ChildProcessSpawner.makeHandle({
                      pid: ChildProcessSpawner.ProcessId(2000 + commands.length),
                      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                      isRunning: Effect.succeed(false),
                      kill: () => Effect.void,
                      stdin: Sink.drain,
                      stdout: Stream.empty,
                      stderr: Stream.empty,
                      all: Stream.empty,
                      getInputFd: () => Sink.drain,
                      getOutputFd: () => Stream.empty,
                      unref: Effect.succeed(Effect.void),
                  }),
              );
    });

    const counts = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                yield* Effect.forkScoped(
                    DesktopIngestScheduler.run({
                        env: testEnv,
                        sinceDays: 1,
                        interval: Duration.minutes(5),
                    }),
                );
                yield* TestClock.adjust(Duration.zero);
                const afterFailed = commands.length;
                yield* TestClock.adjust(Duration.minutes(5));
                const afterRecovery = commands.length;
                return { afterFailed, afterRecovery };
            }),
        ).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provide(TestClock.layer()),
        ),
    );

    expect(counts).toEqual({ afterFailed: 1, afterRecovery: 2 });
});
