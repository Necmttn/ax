import { describe, expect, test } from "bun:test";
import {
    buildCheckpointStatement,
    checkpointKey,
    computeSuggestedVerdict,
    dueCheckpointKinds,
} from "./derive-checkpoints.ts";

describe("computeSuggestedVerdict", () => {
    test("opportunities=0 + no frequency info -> no_longer_needed", () => {
        expect(computeSuggestedVerdict({ opportunities: 0, addressed: 0, ratio: 0, built: true })).toBe("no_longer_needed");
    });

    test("opportunities=0 + current==baseline -> no_longer_needed (pattern self-resolved)", () => {
        expect(computeSuggestedVerdict({
            opportunities: 0,
            addressed: 0,
            ratio: 0,
            built: true,
            currentFrequency: 5,
            baselineFrequency: 5,
        })).toBe("no_longer_needed");
    });

    test("opportunities=0 + current > baseline -> ignored (artifact exists but pattern still firing)", () => {
        expect(computeSuggestedVerdict({
            opportunities: 0,
            addressed: 0,
            ratio: 0,
            built: true,
            currentFrequency: 9,
            baselineFrequency: 5,
        })).toBe("ignored");
    });

    test("ratio > 0.6 -> adopted", () => {
        expect(computeSuggestedVerdict({ opportunities: 10, addressed: 7, ratio: 0.7, built: true })).toBe("adopted");
    });

    test("ratio < 0.1 -> ignored", () => {
        expect(computeSuggestedVerdict({ opportunities: 10, addressed: 0, ratio: 0, built: true })).toBe("ignored");
    });

    test("middling ratio -> partial", () => {
        expect(computeSuggestedVerdict({ opportunities: 10, addressed: 3, ratio: 0.3, built: true })).toBe("partial");
    });
});

describe("dueCheckpointKinds", () => {
    test("nothing due at 2 sessions", () => {
        expect(dueCheckpointKinds(2, new Set()).length).toBe(0);
    });

    test("+3s due at exactly 3 sessions", () => {
        expect(dueCheckpointKinds(3, new Set())).toEqual(["+3s"]);
    });

    test("+3s and +10s due at 11 sessions", () => {
        expect(dueCheckpointKinds(11, new Set())).toEqual(["+3s", "+10s"]);
    });

    test("all three due at 30+ sessions", () => {
        expect(dueCheckpointKinds(30, new Set())).toEqual(["+3s", "+10s", "+30s"]);
        expect(dueCheckpointKinds(42, new Set())).toEqual(["+3s", "+10s", "+30s"]);
    });

    test("skips kinds already present in existing", () => {
        expect(dueCheckpointKinds(40, new Set(["+3s", "+10s"]))).toEqual(["+30s"]);
    });

    test("legacy day-based kinds in existing are not treated as the new session-based ones", () => {
        // A migrated experiment may have legacy t+7/t+30/t+90 rows. Those
        // don't satisfy the new windows; they're separate kinds. The new
        // session-based checkpoints should still emit.
        expect(dueCheckpointKinds(40, new Set(["t+7", "t+30", "t+90"]))).toEqual(["+3s", "+10s", "+30s"]);
    });
});

describe("checkpointKey", () => {
    test("deterministic and disambiguates by kind", () => {
        expect(checkpointKey("exp_a", "+3s")).toBe(checkpointKey("exp_a", "+3s"));
        expect(checkpointKey("exp_a", "+3s")).not.toBe(checkpointKey("exp_a", "+10s"));
    });

    test("escapes the + so the key is a safe SurrealDB identifier", () => {
        const key = checkpointKey("exp_a", "+3s");
        expect(key).not.toContain("+");
        expect(key).toContain("_plus_3s");
    });
});

describe("buildCheckpointStatement", () => {
    test("emits UPSERT with NONE user_verdict + json measured + recorded suggested", () => {
        const sql = buildCheckpointStatement({
            experimentKey: "exp_demo",
            kind: "+3s",
            measured: { opportunities: 4, addressed: 3, ratio: 0.75, built: true },
            suggested: "adopted",
            observedAt: new Date("2026-05-25T00:00:00.000Z"),
        });
        expect(sql).toContain("UPSERT checkpoint:");
        expect(sql).toContain("experiment: experiment:");
        expect(sql).toContain("kind: \"+3s\"");
        expect(sql).toContain("suggested: \"adopted\"");
        expect(sql).toContain("user_verdict: NONE");
        expect(sql).toContain("\"opportunities\":4");
        expect(sql).toContain("\"addressed\":3");
    });
});
