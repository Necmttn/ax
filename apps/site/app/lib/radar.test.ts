import { describe, expect, it } from "bun:test";
import {
    archetypeFor,
    dominantPair,
    profileToAxes,
    RADAR_AXIS_KEYS,
    type RadarAxes,
    type RadarAxisKey,
} from "./radar";
import type { ProfileInsights, ProfileV1 } from "@ax/lib/shared/community";

/* ---------- fixtures ---------- */

const baseInsights = (over: Partial<ProfileInsights> = {}): ProfileInsights => ({
    hours_total: 0,
    longest_session_minutes: 0,
    deep_session_share: 0,
    peak_hour_utc: 0,
    busiest_day: { date: "2026-01-01", sessions: 0 },
    max_parallel_sessions: 0,
    subagents_spawned: 0,
    commits: 0,
    tools_top: [],
    ...over,
});

const profile = (over: {
    tokensTotal?: number;
    sessions?: number;
    insights?: ProfileInsights | undefined;
} = {}): ProfileV1 => ({
    v: 1,
    github: "tester",
    generated_at: "2026-01-01T00:00:00Z",
    window_days: 30,
    stats: {
        sessions: over.sessions ?? 100,
        active_days: 20,
        streak_days: 5,
        tokens: { prompt: 0, completion: 0, total: over.tokensTotal ?? 0 },
        models: [],
        harnesses: [],
    },
    rig: { skills: [], hooks: [], routing_table: false },
    insights: over.insights,
});

/* ---------- axis anchor math ---------- */

describe("profileToAxes - SCALE log anchors", () => {
    const scaleOf = (total: number) => profileToAxes(profile({ tokensTotal: total, insights: baseInsights() })).scores.SCALE;

    it("hits the documented anchor points", () => {
        expect(scaleOf(1e6)).toBeCloseTo(10, 1);
        expect(scaleOf(1e8)).toBeCloseTo(40, 1);
        expect(scaleOf(1e9)).toBeCloseTo(60, 1);
        expect(scaleOf(1e10)).toBeCloseTo(85, 1);
        expect(scaleOf(1e11)).toBeCloseTo(100, 1);
    });

    it("interpolates between anchors in log space (geometric midpoint sits between outputs)", () => {
        // sqrt(1e8 * 1e9) = ~3.16e8 -> halfway between 40 and 60 in log space
        const mid = scaleOf(Math.sqrt(1e8 * 1e9));
        expect(mid).toBeGreaterThan(40);
        expect(mid).toBeLessThan(60);
        expect(mid).toBeCloseTo(50, 0);
    });

    it("caps above the top anchor and floors at 0 for non-positive", () => {
        expect(scaleOf(1e15)).toBe(100);
        expect(scaleOf(0)).toBe(0);
        expect(scaleOf(-5)).toBe(0);
    });
});

describe("profileToAxes - ENDURANCE log anchors", () => {
    const endOf = (hours: number) => profileToAxes(profile({ insights: baseInsights({ hours_total: hours }) })).scores.ENDURANCE;
    it("hits anchors", () => {
        expect(endOf(10)).toBeCloseTo(20, 1);
        expect(endOf(100)).toBeCloseTo(50, 1);
        expect(endOf(1000)).toBeCloseTo(80, 1);
        expect(endOf(3000)).toBeCloseTo(100, 1);
    });
    it("caps and floors", () => {
        expect(endOf(99999)).toBe(100);
        expect(endOf(0)).toBe(0);
    });
});

describe("profileToAxes - linear axes + caps", () => {
    it("DEPTH maps 0->0, 30%->100, caps above", () => {
        expect(profileToAxes(profile({ insights: baseInsights({ deep_session_share: 0 }) })).scores.DEPTH).toBe(0);
        expect(profileToAxes(profile({ insights: baseInsights({ deep_session_share: 0.15 }) })).scores.DEPTH).toBeCloseTo(50, 1);
        expect(profileToAxes(profile({ insights: baseInsights({ deep_session_share: 0.3 }) })).scores.DEPTH).toBe(100);
        expect(profileToAxes(profile({ insights: baseInsights({ deep_session_share: 0.9 }) })).scores.DEPTH).toBe(100);
    });

    it("RIGOR maps verification share 0->0, 15%->100, caps", () => {
        const r = (verification: number, calls: number) =>
            profileToAxes(profile({ insights: baseInsights({ verification_calls: verification, tool_calls: calls }) })).scores.RIGOR;
        expect(r(0, 1000)).toBe(0);
        expect(r(75, 1000)).toBeCloseTo(50, 1); // 7.5% -> 50
        expect(r(150, 1000)).toBe(100); // 15% -> 100
        expect(r(500, 1000)).toBe(100); // 50% -> capped
    });

    it("DELEGATION maps subagents/session 0->0, 2.0->100, caps", () => {
        const d = (subagents: number, sessions: number) =>
            profileToAxes(profile({ sessions, insights: baseInsights({ subagents_spawned: subagents }) })).scores.DELEGATION;
        expect(d(0, 100)).toBe(0);
        expect(d(100, 100)).toBeCloseTo(50, 1); // 1.0/session -> 50
        expect(d(200, 100)).toBe(100); // 2.0/session -> 100
        expect(d(1000, 100)).toBe(100); // capped
    });

    it("BREADTH blends skills*0.8 + repos*2, caps at 100", () => {
        const b = (skills: number | undefined, repos: number | undefined) =>
            profileToAxes(profile({ insights: baseInsights({ distinct_skills: skills, repos_count: repos }) })).scores.BREADTH;
        expect(b(50, 10)).toBeCloseTo(60, 1); // 50*0.8 + 10*2 = 60
        expect(b(125, 0)).toBe(100); // 100
        expect(b(200, 50)).toBe(100); // capped
        expect(b(10, undefined)).toBeCloseTo(8, 1); // repos missing -> treated as 0
    });
});

/* ---------- partial handling ---------- */

describe("profileToAxes - partial / missing", () => {
    it("flags partial and lists all insight-derived axes when insights absent", () => {
        const a = profileToAxes(profile({ tokensTotal: 1e9, insights: undefined }));
        expect(a.partial).toBe(true);
        expect(a.scores.SCALE).toBeCloseTo(60, 1); // SCALE still measurable from tokens
        expect(a.scores.DEPTH).toBe(0);
        expect(new Set(a.missing)).toEqual(new Set<RadarAxisKey>(["DEPTH", "RIGOR", "DELEGATION", "BREADTH", "ENDURANCE"]));
    });

    it("flags RIGOR missing when tool_calls absent but other insights present", () => {
        const a = profileToAxes(profile({ insights: baseInsights({ hours_total: 100 }) }));
        expect(a.partial).toBe(true);
        expect(a.missing).toContain("RIGOR");
        expect(a.missing).toContain("BREADTH");
        expect(a.missing).not.toContain("DEPTH");
        expect(a.missing).not.toContain("ENDURANCE");
    });

    it("a full insights profile is not partial", () => {
        const a = profileToAxes(profile({
            tokensTotal: 1e9,
            insights: baseInsights({
                hours_total: 100,
                deep_session_share: 0.3,
                subagents_spawned: 50,
                verification_calls: 75,
                tool_calls: 1000,
                distinct_skills: 50,
                repos_count: 10,
            }),
        }));
        expect(a.partial).toBe(false);
        expect(a.missing).toEqual([]);
    });
});

/* ---------- raw values (reference-table labels) ---------- */

describe("profileToAxes - raws", () => {
    it("formats the un-normalised number behind every axis", () => {
        const a = profileToAxes(profile({
            tokensTotal: 19.6e9,
            sessions: 100,
            insights: baseInsights({
                hours_total: 2300,
                deep_session_share: 0.077,
                subagents_spawned: 87,
                verification_calls: 29,
                tool_calls: 1000,
                distinct_skills: 84,
                repos_count: 12,
            }),
        }));
        expect(a.raws.DEPTH.label).toBe("7.7% landed clean");
        expect(a.raws.SCALE.label).toBe("19.6B tokens");
        expect(a.raws.RIGOR.label).toBe("2.9% verification share");
        expect(a.raws.DELEGATION.label).toBe("0.87 subagents/session");
        expect(a.raws.BREADTH.label).toBe("84 skills · 12 repos");
        expect(a.raws.ENDURANCE.label).toBe("2.3K hrs");
    });

    it("carries comparable numerics matching the axis direction", () => {
        const a = profileToAxes(profile({
            tokensTotal: 1e9,
            sessions: 50,
            insights: baseInsights({
                hours_total: 100,
                deep_session_share: 0.3,
                subagents_spawned: 25,
                verification_calls: 75,
                tool_calls: 1000,
                distinct_skills: 50,
                repos_count: 10,
            }),
        }));
        expect(a.raws.DEPTH.value).toBeCloseTo(0.3, 5);
        expect(a.raws.SCALE.value).toBe(1e9);
        expect(a.raws.RIGOR.value).toBeCloseTo(0.075, 5);
        expect(a.raws.DELEGATION.value).toBeCloseTo(0.5, 5);
        expect(a.raws.BREADTH.value).toBeCloseTo(50 * 0.8 + 10 * 2, 5); // uncapped blend
        expect(a.raws.ENDURANCE.value).toBe(100);
    });

    it("missing inputs yield a null value and an em-dash label", () => {
        const a = profileToAxes(profile({ tokensTotal: 1e9, insights: undefined }));
        expect(a.raws.DEPTH).toEqual({ label: "-", value: null });
        expect(a.raws.RIGOR).toEqual({ label: "-", value: null });
        expect(a.raws.DELEGATION).toEqual({ label: "-", value: null });
        expect(a.raws.BREADTH).toEqual({ label: "-", value: null });
        expect(a.raws.ENDURANCE).toEqual({ label: "-", value: null });
        // SCALE is always measurable
        expect(a.raws.SCALE.value).toBe(1e9);
        expect(a.raws.SCALE.label).toBe("1B tokens");
    });

    it("every axis key has a raw entry", () => {
        const a = profileToAxes(profile({ insights: baseInsights() }));
        for (const k of RADAR_AXIS_KEYS) {
            expect(a.raws[k]).toBeDefined();
            expect(typeof a.raws[k].label).toBe("string");
        }
    });
});

/* ---------- determinism ---------- */

describe("determinism", () => {
    it("identical profiles yield identical axes + archetype", () => {
        const p = profile({
            tokensTotal: 5e9,
            insights: baseInsights({ hours_total: 400, deep_session_share: 0.4, subagents_spawned: 120, verification_calls: 200, tool_calls: 1500, distinct_skills: 80, repos_count: 20 }),
        });
        const a1 = profileToAxes(p);
        const a2 = profileToAxes(p);
        expect(a1).toEqual(a2);
        expect(archetypeFor(a1, p)).toEqual(archetypeFor(a2, p));
    });
});

/* ---------- leadTally ---------- */

import { leadTally } from "./radar";

// minimal RadarAxes builder: every axis gets {value,label}; scores/raws only
function axesWith(values: ReadonlyArray<number | null>): RadarAxes {
    const raws = {} as Record<RadarAxisKey, { value: number | null; label: string }>;
    const scores = {} as Record<RadarAxisKey, number>;
    RADAR_AXIS_KEYS.forEach((k, i) => {
        const v = values[i] ?? null;
        raws[k] = { value: v, label: v === null ? "-" : String(v) };
        scores[k] = v ?? 0;
    });
    // NOTE: real RadarAxes requires `missing` field (absent from the task spec's builder);
    // added here to satisfy the interface.
    return { scores, raws, partial: false, missing: [] };
}

describe("leadTally", () => {
    it("counts strictly-greater per-axis wins for each side", () => {
        const a = axesWith([10, 5, 8, 3, 9, 1]);
        const b = axesWith([2, 5, 12, 4, 1, 0]);
        // a wins axes 0,4,5 ; b wins axes 2,3 ; axis 1 is a tie (no lead)
        const t = leadTally(a, b);
        expect(t.aLeads).toBe(3);
        expect(t.bLeads).toBe(2);
        expect(t.total).toBe(RADAR_AXIS_KEYS.length);
    });

    it("null never leads; a non-null beats a null", () => {
        const a = axesWith([5, null, null, null, null, null]);
        const b = axesWith([null, 7, null, null, null, null]);
        const t = leadTally(a, b);
        expect(t.aLeads).toBe(1); // axis0: 5 > null
        expect(t.bLeads).toBe(1); // axis1: 7 > null
    });
});

/* ---------- archetype matrix coverage ---------- */

// hand-built axes need a raws record too; tests above cover real derivation
const emptyRaws = (): Record<RadarAxisKey, { label: string; value: number | null }> => ({
    DEPTH: { label: "-", value: null },
    SCALE: { label: "-", value: null },
    RIGOR: { label: "-", value: null },
    DELEGATION: { label: "-", value: null },
    BREADTH: { label: "-", value: null },
    ENDURANCE: { label: "-", value: null },
});

// build an axes object that ranks two chosen axes highest, deterministically
function axesWithTop(top: RadarAxisKey, second: RadarAxisKey): RadarAxes {
    const scores: Record<RadarAxisKey, number> = {
        DEPTH: 5, SCALE: 5, RIGOR: 5, DELEGATION: 5, BREADTH: 5, ENDURANCE: 5,
    };
    scores[top] = 90;
    scores[second] = 80;
    return { scores, raws: emptyRaws(), partial: false, missing: [] };
}

describe("archetypeFor - matrix coverage", () => {
    it("every unordered axis pair maps to a named sign", () => {
        const signs = new Set<string>();
        for (let i = 0; i < RADAR_AXIS_KEYS.length; i++) {
            for (let j = i + 1; j < RADAR_AXIS_KEYS.length; j++) {
                const a = RADAR_AXIS_KEYS[i]!;
                const b = RADAR_AXIS_KEYS[j]!;
                const arch = archetypeFor(axesWithTop(a, b));
                expect(arch.sign).toMatch(/^The /);
                expect(arch.sign).not.toBe("The Unmeasured");
                expect(arch.symbol.length).toBeGreaterThan(0);
                signs.add(arch.sign);
            }
        }
        // 15 pairs; signs may repeat by design but most are distinct
        expect(signs.size).toBeGreaterThanOrEqual(10);
    });

    it("pair is order-independent (DEPTH+RIGOR == RIGOR+DEPTH)", () => {
        expect(archetypeFor(axesWithTop("DEPTH", "RIGOR")).sign)
            .toBe(archetypeFor(axesWithTop("RIGOR", "DEPTH")).sign);
    });

    it("known mappings hold", () => {
        expect(archetypeFor(axesWithTop("DEPTH", "RIGOR")).sign).toBe("The Auditor");
        expect(archetypeFor(axesWithTop("SCALE", "DELEGATION")).sign).toBe("The Fleet Commander");
        expect(archetypeFor(axesWithTop("SCALE", "BREADTH")).sign).toBe("The Polyglot");
        expect(archetypeFor(axesWithTop("DEPTH", "ENDURANCE")).sign).toBe("The Deep Worker");
        expect(archetypeFor(axesWithTop("RIGOR", "DELEGATION")).sign).toBe("The Overseer");
    });

    it("all-zero axes yield the void sign", () => {
        const zero: RadarAxes = {
            scores: { DEPTH: 0, SCALE: 0, RIGOR: 0, DELEGATION: 0, BREADTH: 0, ENDURANCE: 0 },
            raws: emptyRaws(),
            partial: true,
            missing: [...RADAR_AXIS_KEYS],
        };
        expect(archetypeFor(zero).sign).toBe("The Unmeasured");
    });

    it("ties break deterministically by axis order", () => {
        // all equal -> top two are DEPTH, SCALE (first in RADAR_AXIS_KEYS)
        const flat: RadarAxes = {
            scores: { DEPTH: 50, SCALE: 50, RIGOR: 50, DELEGATION: 50, BREADTH: 50, ENDURANCE: 50 },
            raws: emptyRaws(),
            partial: false,
            missing: [],
        };
        expect(dominantPair(flat)).toEqual(["DEPTH", "SCALE"]);
        expect(archetypeFor(flat).sign).toBe("The Excavator");
    });

    it("blurb is grounded in real numbers when a profile is supplied", () => {
        const p = profile({
            tokensTotal: 5e9,
            insights: baseInsights({ deep_session_share: 0.42, verification_calls: 3400, tool_calls: 10000, hours_total: 400 }),
        });
        const a = profileToAxes(p);
        const arch = archetypeFor(a, p);
        // a real number landed in the sentence (compact-formatted, e.g. "3.4K")
        expect(arch.blurb).toMatch(/[\d.]+[KMB]?/);
        expect(arch.blurb).toContain("verification calls");
        expect(arch.blurb.length).toBeGreaterThan(20);
    });
});
