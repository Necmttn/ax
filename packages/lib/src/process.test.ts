import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { ProcessService, ProcessServiceLive, ProcessServiceTest } from "./process.ts";

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
});
