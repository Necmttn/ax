import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
    chargeStageSelfTime,
    CurrentStageSelfTime,
    makeStageSelfTime,
} from "./self-time.ts";

const busy = (ms: number) =>
    Effect.sync(() => {
        // A synchronous spin, which is what a bun:ffi DuckDB call looks like to
        // the event loop - the whole point of measuring it.
        const until = performance.now() + ms;
        while (performance.now() < until) { /* spin */ }
        return "done";
    });

describe("chargeStageSelfTime", () => {
    test("charges a call to the stage accumulator in scope", async () => {
        const acc = makeStageSelfTime();
        const result = await Effect.runPromise(
            Effect.provideService(chargeStageSelfTime(busy(20)), CurrentStageSelfTime, acc),
        );
        expect(result).toBe("done");
        expect(acc.calls).toBe(1);
        expect(acc.ms).toBeGreaterThanOrEqual(15);
    });

    test("sums across calls, including ones made from a forked child fiber", async () => {
        // A stage's internal fan-out (claude parses 8 files at a time) has to
        // charge to the SAME total, which is what makes Context.Reference the
        // right mechanism - it is inherited by child fibers.
        const acc = makeStageSelfTime();
        await Effect.runPromise(
            Effect.provideService(
                Effect.forEach([10, 10, 10], () => chargeStageSelfTime(busy(10)), {
                    concurrency: 3,
                }),
                CurrentStageSelfTime,
                acc,
            ),
        );
        expect(acc.calls).toBe(3);
        expect(acc.ms).toBeGreaterThanOrEqual(20);
    });

    test("outside a stage the effect is untouched and nothing is recorded", async () => {
        // The CLI, the dashboard and every test read through the same seam. No
        // accumulator means no bookkeeping and no behaviour change.
        const result = await Effect.runPromise(chargeStageSelfTime(busy(1)));
        expect(result).toBe("done");
    });

    test("a failed call is still charged - it consumed the thread", async () => {
        const acc = makeStageSelfTime();
        const exit = await Effect.runPromiseExit(
            Effect.provideService(
                chargeStageSelfTime(Effect.flatMap(busy(15), () => Effect.fail("boom"))),
                CurrentStageSelfTime,
                acc,
            ),
        );
        expect(exit._tag).toBe("Failure");
        expect(acc.calls).toBe(1);
        expect(acc.ms).toBeGreaterThanOrEqual(10);
    });
});
