import { describe, expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import {
    ProcessService,
    ProcessServiceLive,
    ProcessServiceTest,
    runCommand,
    spawnScoped,
} from "./process.ts";

const pidAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

describe("ProcessService", () => {
    test("test layer routes commands to fixtures", async () => {
        const layer = ProcessServiceTest({
            route: (cmd, args) => {
                if (cmd === "echo" && args[0] === "hello") {
                    return { stdout: "hello\n", stderr: "", code: 0 };
                }
                return new Error(`unexpected ${cmd} ${args.join(" ")}`);
            },
        });

        const result = await Effect.runPromise(
            Effect.gen(function* () {
                const proc = yield* ProcessService;
                return yield* proc.exec("echo", ["hello"]);
            }).pipe(Effect.provide(layer)),
        );

        expect(result.stdout).toBe("hello\n");
        expect(result.code).toBe(0);
    });

    test("test layer surfaces error for unmocked routes", async () => {
        const layer = ProcessServiceTest({
            route: () => new Error("not mocked"),
        });
        const result = await Effect.runPromise(
            Effect.gen(function* () {
                const proc = yield* ProcessService;
                return yield* proc.exec("anything", []).pipe(
                    Effect.match({
                        onSuccess: () => "ok" as const,
                        onFailure: (err) => err._tag,
                    }),
                );
            }).pipe(Effect.provide(layer)),
        );
        expect(result).toBe("ProcessError");
    });

    test("commandExists in test layer respects mock", async () => {
        const layer = ProcessServiceTest({
            route: () => new Error("not used"),
            commandExists: (name) => name === "rg",
        });
        const program = Effect.gen(function* () {
            const proc = yield* ProcessService;
            return {
                rg: yield* proc.commandExists("rg"),
                nope: yield* proc.commandExists("nope"),
            };
        });
        const out = await Effect.runPromise(program.pipe(Effect.provide(layer)));
        expect(out.rg).toBe(true);
        expect(out.nope).toBe(false);
    });

    test("live layer captures exec stdout via /bin/echo", async () => {
        const result = await Effect.runPromise(
            Effect.gen(function* () {
                const proc = yield* ProcessService;
                return yield* proc.exec("/bin/echo", ["live-ok"]);
            }).pipe(Effect.provide(ProcessServiceLive)),
        );
        expect(result.stdout.trim()).toBe("live-ok");
        expect(result.code).toBe(0);
    });

    test("live exec timeout kills the child and fails with ProcessError", async () => {
        const outcome = await Effect.runPromise(
            Effect.gen(function* () {
                const proc = yield* ProcessService;
                return yield* proc.exec("/bin/sleep", ["30"], { timeoutMs: 50 }).pipe(
                    Effect.match({
                        onSuccess: () => "unexpected-success" as const,
                        onFailure: (err) => err.message,
                    }),
                );
            }).pipe(Effect.provide(ProcessServiceLive)),
        );
        expect(outcome).toBe("process timed out after 50ms");
    });
});

describe("spawnScoped / runCommand", () => {
    test("runCommand returns stdout, stderr, and exit code", async () => {
        const result = await Effect.runPromise(
            runCommand("/bin/sh", ["-c", "echo out; echo err >&2; exit 3"]),
        );
        expect(result.stdout.trim()).toBe("out");
        expect(result.stderr.trim()).toBe("err");
        expect(result.code).toBe(3);
    });

    test("runCommand fails with ProcessError when the spawn itself fails", async () => {
        const outcome = await Effect.runPromise(
            runCommand("/nonexistent-binary-xyz-12345", []).pipe(
                Effect.match({
                    onSuccess: () => "unexpected-success" as const,
                    onFailure: (err) => err._tag,
                }),
            ),
        );
        expect(outcome).toBe("ProcessError");
    });

    test("interrupting the fiber kills the spawned child", async () => {
        let pid = 0;
        const program = Effect.scoped(
            Effect.gen(function* () {
                const proc = yield* spawnScoped("/bin/sleep", ["30"]);
                pid = proc.pid;
                yield* Effect.promise(() => proc.exited);
            }),
        );
        const fiber = Effect.runFork(program);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(pid).toBeGreaterThan(0);
        expect(pidAlive(pid)).toBe(true);
        await Effect.runPromise(Fiber.interrupt(fiber));
        // Release awaits proc.exited, so by now the child must be gone.
        expect(pidAlive(pid)).toBe(false);
    });
});
