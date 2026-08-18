import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
    chargeStageSelfTime,
    CurrentStageSelfTime,
    CurrentStageSelfTimeBudget,
    makeStageSelfTime,
    StageSelfTimeBudgetExceeded,
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

describe("self-time budget enforcement (#837)", () => {
    const provideBoth = <A, E, R>(
        effect: import("effect").Effect.Effect<A, E, R>,
        acc: ReturnType<typeof makeStageSelfTime>,
        budgetMs: number | null,
    ) =>
        Effect.provideService(
            Effect.provideService(effect, CurrentStageSelfTime, acc),
            CurrentStageSelfTimeBudget,
            budgetMs,
        );

    test("a call under budget runs; the one AFTER the budget is spent is refused", async () => {
        const acc = makeStageSelfTime();
        // First call allowed at acc.ms=0 and overshoots (a synchronous FFI
        // call cannot be preempted - it is charged after it returns).
        await Effect.runPromise(provideBoth(chargeStageSelfTime(busy(15)), acc, 10));
        expect(acc.calls).toBe(1);
        expect(acc.ms).toBeGreaterThanOrEqual(10);
        // Second call refused before it starts: no charge, tagged defect.
        const exit = await Effect.runPromiseExit(
            provideBoth(chargeStageSelfTime(busy(50)), acc, 10),
        );
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
            const defect = exit.cause.reasons
                .filter((r) => r._tag === "Die")
                .map((r) => (r as { defect: unknown }).defect)
                .find((d) => d instanceof StageSelfTimeBudgetExceeded);
            expect(defect).toBeInstanceOf(StageSelfTimeBudgetExceeded);
            const e = defect as StageSelfTimeBudgetExceeded;
            expect(e.budgetMs).toBe(10);
            expect(e.calls).toBe(1);
            expect(e.selfMs).toBeGreaterThanOrEqual(10);
        }
        expect(acc.calls).toBe(1); // the refused call was never charged
    });

    test("a null budget never refuses", async () => {
        const acc = makeStageSelfTime();
        acc.ms = 1e9;
        const result = await Effect.runPromise(
            provideBoth(chargeStageSelfTime(busy(1)), acc, null),
        );
        expect(result).toBe("done");
    });

    test("a budget without an accumulator cannot enforce and passes through", async () => {
        // No accumulator = nothing counting, so there is nothing to compare
        // the budget against. Only stages (which get an accumulator from
        // wrapStage) are ever budgeted.
        const result = await Effect.runPromise(
            Effect.provideService(
                chargeStageSelfTime(busy(1)),
                CurrentStageSelfTimeBudget,
                0,
            ),
        );
        expect(result).toBe("done");
    });

    test("clearing the budget in an inner scope exempts bookkeeping writes", async () => {
        // wrapStage clears the budget around its settle finalizer so a stage
        // stopped for exhausting the budget can still write its own ledger row.
        const acc = makeStageSelfTime();
        acc.ms = 1e9;
        const result = await Effect.runPromise(
            provideBoth(
                Effect.provideService(
                    chargeStageSelfTime(busy(1)),
                    CurrentStageSelfTimeBudget,
                    null,
                ),
                acc,
                10,
            ),
        );
        expect(result).toBe("done");
    });
});
