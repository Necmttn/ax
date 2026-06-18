import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { makeServeRuntime, type RuntimeLike } from "./serve-runtime.ts";

class HandlerBoom extends Schema.TaggedErrorClass<HandlerBoom>("HandlerBoom")(
    "HandlerBoom",
    { message: Schema.String },
) {}

/**
 * Fake RuntimeLike factory: `built: false` simulates a runtime whose layer
 * build failed (cachedContext stays undefined, every run rejects with the
 * build error); `built: true` runs the effect for real (so handler-level
 * Effect failures still reject) with a defined cachedContext.
 */
function fakeRuntime(opts: { readonly built: boolean; readonly buildError?: unknown }) {
    const self = {
        disposed: false,
        cachedContext: opts.built ? {} : undefined,
        runPromise: <A>(effect: Effect.Effect<A, unknown, never>): Promise<A> =>
            opts.built
                ? Effect.runPromise(effect)
                : Promise.reject(opts.buildError ?? new Error("layer build failed")),
        dispose: (): Promise<void> => {
            self.disposed = true;
            return Promise.resolve();
        },
    };
    return self;
}

type Fake = ReturnType<typeof fakeRuntime>;

function handleWith(...runtimes: Fake[]) {
    let i = 0;
    const made: Fake[] = [];
    const make = (): RuntimeLike => {
        const rt = runtimes[i] ?? fakeRuntime({ built: true });
        i = Math.min(i + 1, runtimes.length);
        made.push(rt as Fake);
        return rt as unknown as RuntimeLike;
    };
    return { handle: makeServeRuntime(make), made };
}

describe("makeServeRuntime", () => {
    test("runs effects on the shared runtime without rebuilding", async () => {
        const { handle, made } = handleWith(fakeRuntime({ built: true }));
        expect(await handle.runner(Effect.succeed(1))).toBe(1);
        expect(await handle.runner(Effect.succeed(2))).toBe(2);
        expect(made.length).toBe(1);
    });

    test("a failed layer build swaps in a fresh runtime for the next run", async () => {
        const broken = fakeRuntime({ built: false, buildError: new Error("db down") });
        const healthy = fakeRuntime({ built: true });
        const { handle, made } = handleWith(broken, healthy);

        await expect(handle.runner(Effect.succeed("x"))).rejects.toThrow("db down");
        expect(broken.disposed).toBe(true);

        expect(await handle.runner(Effect.succeed("x"))).toBe("x");
        expect(made.length).toBe(2);
    });

	    test("a handler error on a healthy runtime does NOT swap", async () => {
	        const healthy = fakeRuntime({ built: true });
	        const { handle, made } = handleWith(healthy);

	        await expect(handle.runner(Effect.fail(new HandlerBoom({ message: "handler boom" })))).rejects.toThrow();
        expect(healthy.disposed).toBe(false);
        expect(await handle.runner(Effect.succeed("ok"))).toBe("ok");
        expect(made.length).toBe(1);
    });

    test("concurrent build failures swap exactly once", async () => {
        const broken = fakeRuntime({ built: false });
        const healthy = fakeRuntime({ built: true });
        const { handle, made } = handleWith(broken, healthy);

        const [a, b] = await Promise.allSettled([
            handle.runner(Effect.succeed(1)),
            handle.runner(Effect.succeed(2)),
        ]);
        expect(a.status).toBe("rejected");
        expect(b.status).toBe("rejected");
        expect(made.length).toBe(2); // initial + ONE replacement, not two
        expect(await handle.runner(Effect.succeed(3))).toBe(3);
    });

    test("warmup reports build failure without throwing and heals", async () => {
        const broken = fakeRuntime({ built: false, buildError: new Error("not yet") });
        const healthy = fakeRuntime({ built: true });
        const { handle } = handleWith(broken, healthy);

        const result = await handle.warmup();
        expect(result.ok).toBe(false);
        expect(await handle.runner(Effect.succeed("healed"))).toBe("healed");
    });

    test("warmup succeeds on a healthy runtime", async () => {
        const { handle } = handleWith(fakeRuntime({ built: true }));
        expect((await handle.warmup()).ok).toBe(true);
    });

    test("dispose tears down the current runtime and stops healing", async () => {
        const broken = fakeRuntime({ built: false });
        const { handle, made } = handleWith(broken, fakeRuntime({ built: true }));

        await handle.dispose();
        expect(broken.disposed).toBe(true);
        await expect(handle.runner(Effect.succeed(1))).rejects.toThrow();
        expect(made.length).toBe(1); // no replacement after dispose
    });
});
