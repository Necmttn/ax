import { test } from "bun:test";

/**
 * A `test` that skips ONLY when a named precondition is absent, and says so.
 *
 * `bun test` prints a skip COUNT with no names, so a run that quietly loses
 * coverage still reads as "the same pre-existing failures". Four runs on four
 * branches of the v2 sweep each reported 11 skips against a baseline of 7, and
 * three separate agents each noticed the drift, each decided it was benign, and
 * none could prove it - because nothing named the four tests that had converted
 * from pass to skip (#847).
 *
 * A skip that depends on ambient state has to say so out loud:
 *
 * ```ts
 * const dbTest = gatedTest({ reason: "AX_E2E_DB=1 is not set", when: !e2eDb });
 * dbTest("installs a hook end to end", () => { ... });
 * ```
 *
 * On a run where the precondition is present this is exactly `test`. Where it
 * is absent, the test is skipped AND a `test skipped:` line names the test and
 * the reason, so the reason appears in the same output as the count.
 */
export interface GatedTestOptions {
    /** Why the test cannot run - phrased as the MISSING thing, e.g.
     *  `"AX_DUCKDB_DYLIB is not set"`. It is printed verbatim. */
    readonly reason: string;
    /** True when the precondition is ABSENT and the test must be skipped. */
    readonly when: boolean;
}

/**
 * Set in CI to turn every gated skip into a hard failure.
 *
 * A skip is acceptable on a laptop that has no DuckDB dylib; it is not
 * acceptable on a gate that is supposed to prove the code works. With this set,
 * a missing precondition fails loudly at the site instead of subtracting one
 * from a count nobody reads.
 */
export const REQUIRE_PRECONDITIONS_ENV = "AX_TEST_REQUIRE_PRECONDITIONS";

/** Every reason a test was skipped this run, in declaration order. Exported so
 *  a reporter (or a test of this helper) can assert on it. */
export const skippedPreconditions: Array<{ name: string; reason: string }> = [];

/** What a gate decides, separated from the act of registering a test so it can
 *  be asserted directly - bun forbids registering a test from inside a running
 *  one, so the registration path itself is not unit-testable. */
export type GateDecision =
    | { readonly mode: "run" }
    | { readonly mode: "skip"; readonly announcement: string }
    | { readonly mode: "fail"; readonly message: string };

export const gateDecision = (
    name: string,
    opts: GatedTestOptions,
    requirePreconditions: boolean,
): GateDecision => {
    if (!opts.when) return { mode: "run" };
    if (requirePreconditions) {
        return {
            mode: "fail",
            message: `precondition missing: ${opts.reason}. ` +
                `${REQUIRE_PRECONDITIONS_ENV}=1 forbids skipping it here - ` +
                "provide the precondition or unset that variable.",
        };
    }
    return { mode: "skip", announcement: `test skipped: ${name} - ${opts.reason}` };
};

export const gatedTest = (opts: GatedTestOptions) =>
    (name: string, fn: Parameters<typeof test>[1]): void => {
        const decision = gateDecision(
            name,
            opts,
            process.env[REQUIRE_PRECONDITIONS_ENV] === "1",
        );
        if (decision.mode === "run") {
            test(name, fn);
            return;
        }
        if (decision.mode === "fail") {
            test(name, () => {
                throw new Error(decision.message);
            });
            return;
        }
        skippedPreconditions.push({ name, reason: opts.reason });
        // Named on stdout so the reason lands in the same output as the count.
        console.log(decision.announcement);
        test.skip(name, fn);
    };
