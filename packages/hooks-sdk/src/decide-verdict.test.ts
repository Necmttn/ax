// packages/hooks-sdk/src/decide-verdict.test.ts
import { describe, expect, test } from "bun:test";
import { decideVerdict } from "./decide-verdict.ts";

// inp() helper: match defaults to false (the plan's `null` adjusted to false
// to satisfy `match: boolean` under strict TS)
const inp = (o: Partial<Parameters<typeof decideVerdict>[0]>) => ({
    match: false, explicit: false, cheap: false, judgmentStrong: false, routeDownEnforced: true,
    input: { description: "x" }, suggest: "sonnet", ...o,
});

describe("decideVerdict", () => {
    test("judgment + cheap → Warn (rule 0, any mode)", () => {
        expect(decideVerdict(inp({ judgmentStrong: true, explicit: true, cheap: true }))._tag).toBe("Warn");
    });
    test("judgment + cheap → Warn even in splurge", () => {
        expect(decideVerdict(inp({ judgmentStrong: true, explicit: true, cheap: true, routeDownEnforced: false }))._tag).toBe("Warn");
    });
    test("explicit (non-judgment) → Allow, never overridden", () => {
        expect(decideVerdict(inp({ explicit: true, cheap: false }))._tag).toBe("Allow");
        expect(decideVerdict(inp({ explicit: true, cheap: true }))._tag).toBe("Allow"); // explicit cheap, not judgment
    });
    test("match + inherit + conserve → Route(suggest)", () => {
        const v = decideVerdict(inp({ match: true, routeDownEnforced: true }));
        expect(v._tag).toBe("Route");
        if (v._tag === "Route") expect(v.input.model).toBe("sonnet");
    });
    test("match + inherit + splurge → Allow (subtractive: runs on strong inherited model)", () => {
        expect(decideVerdict(inp({ match: true, routeDownEnforced: false }))._tag).toBe("Allow");
    });
    test("no match + inherit → Allow", () => {
        expect(decideVerdict(inp({ match: false }))._tag).toBe("Allow");
    });
    test("judgment + inherit (strong) any mode → Allow (not warned, not routed)", () => {
        expect(decideVerdict(inp({ judgmentStrong: true, explicit: false }))._tag).toBe("Allow");
    });
    test("match + judgment + inherit + conserve → Allow (judgment is NEVER routed down)", () => {
        expect(decideVerdict(inp({ match: true, judgmentStrong: true, routeDownEnforced: true }))._tag).toBe("Allow");
    });
});
