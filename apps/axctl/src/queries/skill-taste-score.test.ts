import { describe, expect, test } from "bun:test";
import { commitCredit, computeTasteScore, TASTE_SCORE_FORMULA, TASTE_SCORE_LEGEND } from "./skill-taste-score.ts";

describe("commitCredit", () => {
    test("passes cmts through unchanged when it does not exceed total", () => {
        expect(commitCredit(3, 10)).toBe(3);
    });

    test("caps cmts at total when cmts exceeds total", () => {
        expect(commitCredit(50, 2)).toBe(2);
    });

    test("is zero when total is zero, regardless of cmts", () => {
        expect(commitCredit(7, 0)).toBe(0);
    });
});

describe("computeTasteScore", () => {
    test("matches the documented formula for an uncapped mid-range skill", () => {
        // score = total - 2*corr + min(cmts, total) - 0.5*prop
        //       = 20 - 2*2 + 5 - 0.5*4 = 20 - 4 + 5 - 2 = 19
        const score = computeTasteScore({ total: 20, corrections: 2, cmts: 5, proposals: 4 });
        expect(score).toBe(19);
    });

    test("caps commit credit at total so a commit-heavy session cannot dominate", () => {
        // Without the cap this would be 1 - 0 + 500 - 0 = 501.
        // With the cap: commit_credit = min(500, 1) = 1, so score = 1 - 0 + 1 - 0 = 2.
        const score = computeTasteScore({ total: 1, corrections: 0, cmts: 500, proposals: 0 });
        expect(score).toBe(2);
    });

    test("corrections apply a double-weight negative term", () => {
        const score = computeTasteScore({ total: 10, corrections: 3, cmts: 0, proposals: 0 });
        expect(score).toBe(10 - 2 * 3);
    });

    test("proposals-only (never invoked) skill scores negative", () => {
        const score = computeTasteScore({ total: 0, corrections: 0, cmts: 0, proposals: 6 });
        expect(score).toBe(-3);
    });

    test("score can go negative when corrections outweigh everything else", () => {
        const score = computeTasteScore({ total: 2, corrections: 5, cmts: 0, proposals: 2 });
        expect(score).toBe(2 - 10 + 0 - 1);
    });
});

describe("TASTE_SCORE_FORMULA / TASTE_SCORE_LEGEND", () => {
    test("formula string documents the cap explicitly", () => {
        expect(TASTE_SCORE_FORMULA).toContain("min(cmts, total)");
    });

    test("legend documents every column the formula or table uses", () => {
        const keys = TASTE_SCORE_LEGEND.map((l) => l.key);
        expect(keys).toEqual(["total", "clean", "corr", "prop", "cmts"]);
    });

    test("legend calls out that clean does not affect score", () => {
        const clean = TASTE_SCORE_LEGEND.find((l) => l.key === "clean");
        expect(clean?.desc.toLowerCase()).toContain("does not affect score");
    });
});
