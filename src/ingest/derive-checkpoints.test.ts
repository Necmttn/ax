import { describe, expect, test } from "bun:test";
import {
    buildCheckpointStatement,
    checkpointKey,
    computeSuggestedVerdict,
    dueCheckpointKinds,
} from "./derive-checkpoints.ts";

describe("computeSuggestedVerdict", () => {
    test("opportunities=0 -> no_longer_needed (pattern self-resolved)", () => {
        expect(computeSuggestedVerdict({ opportunities: 0, addressed: 0, ratio: 0, built: true })).toBe("no_longer_needed");
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
    const created = new Date("2026-01-01T00:00:00Z");
    test("nothing due yet at t+6 days", () => {
        const now = new Date("2026-01-07T00:00:00Z"); // 6 days exactly minus 1ms = 6 < 7
        expect(dueCheckpointKinds(created, now, new Set()).length).toBe(0);
    });

    test("t+7 due at exactly 7 days", () => {
        const now = new Date("2026-01-08T00:00:00Z"); // 7 days
        expect(dueCheckpointKinds(created, now, new Set())).toEqual(["t+7"]);
    });

    test("t+7, t+30 due at 31 days", () => {
        const now = new Date("2026-02-01T00:00:00Z"); // 31 days
        expect(dueCheckpointKinds(created, now, new Set())).toEqual(["t+7", "t+30"]);
    });

    test("all three due at 91 days", () => {
        const now = new Date("2026-04-02T00:00:00Z"); // 91 days
        expect(dueCheckpointKinds(created, now, new Set())).toEqual(["t+7", "t+30", "t+90"]);
    });

    test("skips kinds already present in existing", () => {
        const now = new Date("2026-04-02T00:00:00Z");
        expect(dueCheckpointKinds(created, now, new Set(["t+7", "t+30"]))).toEqual(["t+90"]);
    });
});

describe("checkpointKey", () => {
    test("deterministic and disambiguates by kind", () => {
        expect(checkpointKey("exp_a", "t+7")).toBe(checkpointKey("exp_a", "t+7"));
        expect(checkpointKey("exp_a", "t+7")).not.toBe(checkpointKey("exp_a", "t+30"));
    });
});

describe("buildCheckpointStatement", () => {
    test("emits UPSERT with NONE user_verdict + json measured + recorded suggested", () => {
        const sql = buildCheckpointStatement({
            experimentKey: "exp_demo",
            kind: "t+7",
            measured: { opportunities: 4, addressed: 3, ratio: 0.75, built: true },
            suggested: "adopted",
            observedAt: new Date("2026-05-25T00:00:00.000Z"),
        });
        expect(sql).toContain("UPSERT checkpoint:");
        expect(sql).toContain("experiment: experiment:");
        expect(sql).toContain("kind: \"t+7\"");
        expect(sql).toContain("suggested: \"adopted\"");
        expect(sql).toContain("user_verdict: NONE");
        expect(sql).toContain("\"opportunities\":4");
        expect(sql).toContain("\"addressed\":3");
    });
});
