import { describe, expect, test } from "bun:test";
import {
    buildModelColors,
    buildDayColumns,
    buildDisplayArcs,
    sortSkillsByLeverage,
    stripSkillPrefix,
    MODEL_RAMP,
    OTHER_COLOR,
    OTHER_NAME,
} from "./window-chart";
import type { ProfileDailyRow, ProfileModel, ProfileSkill, WorkflowArc } from "./community";

describe("buildModelColors", () => {
    test("top model is green, rest follow the ramp", () => {
        const models: ProfileModel[] = [
            { name: "claude-fable-5", share: 0.5 },
            { name: "claude-opus", share: 0.3 },
            { name: "gpt-5", share: 0.2 },
        ];
        const { colorOf, order } = buildModelColors(models);
        expect(colorOf("claude-fable-5")).toBe(MODEL_RAMP[0]!);
        expect(colorOf("claude-opus")).toBe(MODEL_RAMP[1]!);
        expect(colorOf("gpt-5")).toBe(MODEL_RAMP[2]!);
        expect(order).toEqual(["claude-fable-5", "claude-opus", "gpt-5"]);
    });

    test("colour is by share order, not array order", () => {
        const models: ProfileModel[] = [
            { name: "b", share: 0.2 },
            { name: "a", share: 0.8 },
        ];
        const { colorOf } = buildModelColors(models);
        expect(colorOf("a")).toBe(MODEL_RAMP[0]!);
        expect(colorOf("b")).toBe(MODEL_RAMP[1]!);
    });

    test("tail beyond ramp collapses to a single other bucket", () => {
        const models: ProfileModel[] = Array.from({ length: 9 }, (_, i) => ({
            name: `m${i}`,
            share: 1 - i * 0.1,
        }));
        const { colorOf, order } = buildModelColors(models);
        expect(colorOf("m6")).toBe(OTHER_COLOR);
        expect(colorOf("m8")).toBe(OTHER_COLOR);
        expect(order.filter((n) => n === OTHER_NAME)).toHaveLength(1);
        expect(order).toContain(OTHER_NAME);
    });

    test("unknown model falls back to other colour", () => {
        const { colorOf } = buildModelColors([{ name: "a", share: 1 }]);
        expect(colorOf("nope")).toBe(OTHER_COLOR);
    });
});

describe("buildDayColumns", () => {
    const colorOf = buildModelColors([
        { name: "fable", share: 0.6 },
        { name: "opus", share: 0.4 },
    ]).colorOf;

    test("segments sum to the day total; height scaled to window max", () => {
        const daily: ProfileDailyRow[] = [
            { date: "2026-06-01", sessions: 2, tokens: 100, models: [
                { name: "fable", tokens: 60 }, { name: "opus", tokens: 40 },
            ] },
            { date: "2026-06-02", sessions: 4, tokens: 200, models: [
                { name: "fable", tokens: 200 },
            ] },
        ];
        const cols = buildDayColumns(daily, colorOf, { peakDate: "2026-06-02" });
        expect(cols).toHaveLength(2);
        expect(cols[0]!.segments.reduce((s, x) => s + x.tokens, 0)).toBe(100);
        expect(cols[0]!.heightShare).toBeCloseTo(0.5);
        expect(cols[1]!.heightShare).toBeCloseTo(1);
        expect(cols[1]!.isPeak).toBe(true);
        expect(cols[0]!.isPeak).toBe(false);
    });

    test("sub-threshold models merge into other", () => {
        const daily: ProfileDailyRow[] = [
            { date: "d", sessions: 1, tokens: 1000, models: [
                { name: "fable", tokens: 980 },
                { name: "opus", tokens: 15 }, // 1.5% kept
                { name: "tiny", tokens: 5 }, // 0.5% merged
            ] },
        ];
        const cols = buildDayColumns(daily, colorOf, { minSegmentShare: 0.01 });
        const seg = cols[0]!.segments;
        const other = seg.find((s) => s.name === OTHER_NAME);
        expect(other?.tokens).toBe(5);
        expect(seg.some((s) => s.name === "fable")).toBe(true);
        expect(seg.some((s) => s.name === "opus")).toBe(true);
    });

    test("no model breakdown yields one neutral segment", () => {
        const daily: ProfileDailyRow[] = [{ date: "d", sessions: 1, tokens: 50 }];
        const cols = buildDayColumns(daily, colorOf);
        expect(cols[0]!.segments).toHaveLength(1);
        expect(cols[0]!.segments[0]!.color).toBe(OTHER_COLOR);
    });

    test("zero-token day has no segments and zero height", () => {
        const daily: ProfileDailyRow[] = [{ date: "d", sessions: 0, tokens: 0 }];
        const cols = buildDayColumns(daily, colorOf);
        expect(cols[0]!.segments).toHaveLength(0);
        expect(cols[0]!.heightShare).toBe(0);
    });
});

describe("stripSkillPrefix", () => {
    test("strips known namespaces", () => {
        expect(stripSkillPrefix("superpowers:writing-plans")).toBe("writing-plans");
        expect(stripSkillPrefix("caveman:caveman")).toBe("caveman");
    });
    test("strips generic ns:thing", () => {
        expect(stripSkillPrefix("foo:bar")).toBe("bar");
    });
    test("leaves plain names alone", () => {
        expect(stripSkillPrefix("simplify")).toBe("simplify");
    });
});

describe("buildDisplayArcs", () => {
    test("strongest first, capped, with display+full pairs", () => {
        const arcs: WorkflowArc[] = [
            { steps: ["superpowers:brainstorming", "writing-plans"], count: 3 },
            { steps: ["review-all", "composto", "simplify"], count: 11 },
            { steps: ["a"], count: 1 },
        ];
        const out = buildDisplayArcs(arcs, 5);
        expect(out[0]!.count).toBe(11);
        expect(out[1]!.count).toBe(3);
        expect(out[1]!.steps[0]).toEqual({ display: "brainstorming", full: "superpowers:brainstorming" });
    });
    test("caps at the limit", () => {
        const arcs: WorkflowArc[] = Array.from({ length: 8 }, (_, i) => ({ steps: ["x"], count: i }));
        expect(buildDisplayArcs(arcs, 5)).toHaveLength(5);
    });
    test("drops empty-step arcs", () => {
        const arcs: WorkflowArc[] = [{ steps: [], count: 9 }, { steps: ["x"], count: 1 }];
        const out = buildDisplayArcs(arcs);
        expect(out).toHaveLength(1);
        expect(out[0]!.steps[0]!.display).toBe("x");
    });
});

describe("sortSkillsByLeverage", () => {
    test("downstream_share desc, missing last, then runs desc", () => {
        const skills: ProfileSkill[] = [
            { name: "lowshare", source: "s", runs: 100, downstream_share: 0.2 },
            { name: "noshare-hi", source: "s", runs: 50 },
            { name: "hishare", source: "s", runs: 5, downstream_share: 0.99 },
            { name: "noshare-lo", source: "s", runs: 10 },
        ];
        const out = sortSkillsByLeverage(skills).map((s) => s.name);
        expect(out).toEqual(["hishare", "lowshare", "noshare-hi", "noshare-lo"]);
    });
    test("stable on name when share + runs tie", () => {
        const skills: ProfileSkill[] = [
            { name: "b", source: "s", runs: 1, downstream_share: 0.5 },
            { name: "a", source: "s", runs: 1, downstream_share: 0.5 },
        ];
        expect(sortSkillsByLeverage(skills).map((s) => s.name)).toEqual(["a", "b"]);
    });
});
