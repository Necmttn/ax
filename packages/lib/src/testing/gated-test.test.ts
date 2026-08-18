import { describe, expect, test } from "bun:test";
import { gateDecision, REQUIRE_PRECONDITIONS_ENV } from "./gated-test.ts";

// The registration path cannot be unit-tested - bun forbids registering a test
// from inside a running one - so the decision is a pure function and this
// asserts that instead.
describe("gateDecision", () => {
    test("runs when the precondition is present", () => {
        expect(gateDecision("t", { reason: "unused", when: false }, false))
            .toEqual({ mode: "run" });
    });

    test("a skip announcement names BOTH the test and the reason", () => {
        // Naming only one of them is what made the original drift unprovable:
        // a count with no names, or a reason with no test (#847).
        const decision = gateDecision("installs a hook", { reason: "AX_E2E_DB=1 is not set", when: true }, false);
        expect(decision.mode).toBe("skip");
        expect(decision).toEqual({
            mode: "skip",
            announcement: "test skipped: installs a hook - AX_E2E_DB=1 is not set",
        });
    });

    test("the require flag turns the same gate into a failure that says how to fix it", () => {
        const decision = gateDecision("installs a hook", { reason: "AX_E2E_DB=1 is not set", when: true }, true);
        expect(decision.mode).toBe("fail");
        if (decision.mode !== "fail") throw new Error("unreachable");
        expect(decision.message).toContain("precondition missing: AX_E2E_DB=1 is not set");
        expect(decision.message).toContain(REQUIRE_PRECONDITIONS_ENV);
    });

    test("names the env var that turns a skip into a failure", () => {
        // Pinned as a value, not prose: the CI workflow and the docs both have
        // to spell it identically.
        expect(REQUIRE_PRECONDITIONS_ENV).toBe("AX_TEST_REQUIRE_PRECONDITIONS");
    });
});
