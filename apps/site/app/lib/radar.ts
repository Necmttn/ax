/**
 * radar.ts - pure, deterministic derivation of a six-axis "agent shape" from a
 * validated ProfileV1, plus the astrology-flavored archetype ("agent sign")
 * that the dominant two axes map onto.
 *
 * Everything here is a pure function of the profile numbers - no Date.now, no
 * Math.random, no I/O - so the same profile always yields the same radar and
 * the same sign (important for SSR/hydration agreement and for tests).
 *
 * The site does NOT depend on effect/Schema and must not import across apps;
 * the archetype voice is modelled on apps/axctl/src/dashboard/wrapped.ts but
 * reimplemented here as small pure helpers.
 */

import type { ProfileV1 } from "./community";

export const RADAR_AXIS_KEYS = [
    "DEPTH",
    "SCALE",
    "RIGOR",
    "DELEGATION",
    "BREADTH",
    "ENDURANCE",
] as const;

export type RadarAxisKey = (typeof RADAR_AXIS_KEYS)[number];

export interface RadarAxes {
    /** each value is 0..100, comparable across users */
    readonly scores: Readonly<Record<RadarAxisKey, number>>;
    /**
     * true when one or more axes had to default to 0 because the profile
     * (an older ax version) lacked the optional input. The UI captions this so
     * a thin polygon isn't mistaken for a weak operator.
     */
    readonly partial: boolean;
    /** which axes were unmeasurable (input missing), for caption detail */
    readonly missing: readonly RadarAxisKey[];
}

export interface AxisMeta {
    readonly key: RadarAxisKey;
    /** short uppercase label rendered on the spoke */
    readonly label: string;
    /** one-line plain description of what the axis measures */
    readonly note: string;
}

export const RADAR_AXES_META: readonly AxisMeta[] = [
    { key: "DEPTH", label: "DEPTH", note: "share of sessions that ran long" },
    { key: "SCALE", label: "SCALE", note: "total tokens moved" },
    { key: "RIGOR", label: "RIGOR", note: "verification share of tool calls" },
    { key: "DELEGATION", label: "DELEG", note: "subagents per session" },
    { key: "BREADTH", label: "BREADTH", note: "distinct skills × repos" },
    { key: "ENDURANCE", label: "ENDURE", note: "hours in the loop" },
];

/* ---------- scaling helpers ---------- */

const clamp = (x: number, lo: number, hi: number): number =>
    Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo;

/** clamp to [0,100] and round to one decimal so scores stay stable + tidy */
const score = (x: number): number => Math.round(clamp(x, 0, 100) * 10) / 10;

/**
 * Piecewise log-anchored mapping. `anchors` is a list of (input -> output)
 * fixed points in ascending input order; between two anchors we interpolate
 * linearly in log10(input) space (magnitudes span orders of magnitude, so
 * linear-in-log keeps a 1B vs 10B gap legible instead of pinning both at 100).
 * Inputs below the first anchor map below its output by the same log slope,
 * floored at 0; inputs above the last anchor are capped at its output.
 */
function logAnchored(value: number, anchors: ReadonlyArray<readonly [number, number]>): number {
    if (!Number.isFinite(value) || value <= 0) return 0;
    const lv = Math.log10(value);
    const first = anchors[0]!;
    const last = anchors[anchors.length - 1]!;
    // below first anchor: extend the first segment's slope downward, floor 0
    if (value <= first[0]) {
        const next = anchors[1] ?? first;
        const x0 = Math.log10(first[0]);
        const x1 = Math.log10(next[0]);
        const slope = x1 > x0 ? (next[1] - first[1]) / (x1 - x0) : 0;
        return score(first[1] + slope * (lv - x0));
    }
    // above last anchor: cap
    if (value >= last[0]) return score(last[1]);
    // between anchors: linear in log space
    for (let i = 1; i < anchors.length; i++) {
        const [px, pv] = anchors[i - 1]!;
        const [cx, cv] = anchors[i]!;
        if (value <= cx) {
            const x0 = Math.log10(px);
            const x1 = Math.log10(cx);
            const f = x1 > x0 ? (lv - x0) / (x1 - x0) : 0;
            return score(pv + (cv - pv) * f);
        }
    }
    return score(last[1]);
}

/* ---------- axis derivation ---------- */

/**
 * profileToAxes - the six comparable axes. Anchors are documented inline; each
 * axis is 0..100. Missing optional inputs collapse an axis to 0 and flag the
 * result `partial` so the UI can say "some axes need a newer ax version".
 *
 * Axes:
 *  - DEPTH      deep_session_share, linear: 0% -> 0, 60% -> 100 (capped).
 *               Deep work plateaus; nobody runs 100% 90-min sessions.
 *  - SCALE      tokens.total, log-anchored:
 *                 1M -> 10, 100M -> 40, 1B -> 60, 10B -> 85, 100B -> 100.
 *               Token totals span 5+ orders of magnitude; log keeps them legible.
 *  - RIGOR      verification_calls / tool_calls, linear: 0% -> 0, 15% -> 100 (cap).
 *               15% of calls being tests/lints/checks is already very rigorous.
 *  - DELEGATION subagents_spawned / sessions, linear: 0 -> 0, 2.0/session -> 100 (cap).
 *               Two dispatched subagents per session = heavy orchestration.
 *  - BREADTH    blend: min(100, distinct_skills*0.8 + repos_count*2).
 *               A skill is worth 0.8pt, a repo 2pt; ~125 skills or ~50 repos maxes.
 *  - ENDURANCE  hours_total, log-anchored: 10h -> 20, 100h -> 50, 1000h -> 80, 3000h -> 100.
 */
export function profileToAxes(p: ProfileV1): RadarAxes {
    const ins = p.insights;
    const sessions = p.stats.sessions;
    const missing: RadarAxisKey[] = [];

    // DEPTH - present whenever insights exist
    let depth = 0;
    if (ins) depth = score((ins.deep_session_share / 0.6) * 100);
    else missing.push("DEPTH");

    // SCALE - tokens.total is always validated/present
    const scale = logAnchored(p.stats.tokens.total, [
        [1e6, 10],
        [1e8, 40],
        [1e9, 60],
        [1e10, 85],
        [1e11, 100],
    ]);

    // RIGOR - needs verification_calls + tool_calls
    let rigor = 0;
    if (ins && ins.verification_calls !== undefined && ins.tool_calls !== undefined && ins.tool_calls > 0) {
        rigor = score((ins.verification_calls / ins.tool_calls / 0.15) * 100);
    } else {
        missing.push("RIGOR");
    }

    // DELEGATION - subagents per session
    let delegation = 0;
    if (ins && sessions > 0) {
        delegation = score((ins.subagents_spawned / sessions / 2.0) * 100);
    } else {
        missing.push("DELEGATION");
    }

    // BREADTH - distinct_skills + repos_count blend
    let breadth = 0;
    if (ins && (ins.distinct_skills !== undefined || ins.repos_count !== undefined)) {
        const skills = ins.distinct_skills ?? 0;
        const repos = ins.repos_count ?? 0;
        breadth = score(skills * 0.8 + repos * 2);
    } else {
        missing.push("BREADTH");
    }

    // ENDURANCE - hours_total log-anchored
    let endurance = 0;
    if (ins) {
        endurance = logAnchored(ins.hours_total, [
            [10, 20],
            [100, 50],
            [1000, 80],
            [3000, 100],
        ]);
    } else {
        missing.push("ENDURANCE");
    }

    return {
        scores: {
            DEPTH: depth,
            SCALE: scale,
            RIGOR: rigor,
            DELEGATION: delegation,
            BREADTH: breadth,
            ENDURANCE: endurance,
        },
        partial: missing.length > 0,
        missing,
    };
}

/* ---------- archetype ("agent sign") ---------- */

export interface Archetype {
    readonly sign: string;
    /** a short glyph for the sign - astrology-port flavour, plain unicode */
    readonly symbol: string;
    /** one horoscope-toned, number-grounded sentence */
    readonly blurb: string;
}

/**
 * The dominant ordering of axes. Ties are broken deterministically by the
 * fixed RADAR_AXIS_KEYS order so the same scores always pick the same pair.
 */
function rankAxes(axes: RadarAxes): RadarAxisKey[] {
    const order = new Map(RADAR_AXIS_KEYS.map((k, i) => [k, i] as const));
    return [...RADAR_AXIS_KEYS].sort((a, b) => {
        const d = axes.scores[b] - axes.scores[a];
        if (d !== 0) return d;
        return order.get(a)! - order.get(b)!; // stable, deterministic tiebreak
    });
}

/**
 * unordered-pair key so DEPTH+RIGOR and RIGOR+DEPTH resolve to one sign. The
 * canonical order is RADAR_AXIS_KEYS order.
 */
function pairKey(a: RadarAxisKey, b: RadarAxisKey): string {
    const idx = (k: RadarAxisKey) => RADAR_AXIS_KEYS.indexOf(k);
    return idx(a) <= idx(b) ? `${a}+${b}` : `${b}+${a}`;
}

/**
 * Full sign matrix: every unordered pair of the six axes maps to a sign. C(6,2)
 * = 15 pairs. Each entry is a name + glyph; the blurb is generated from the
 * actual numbers in `blurbFor` so it stays grounded.
 */
const SIGN_MATRIX: Record<string, { sign: string; symbol: string }> = {
    "DEPTH+SCALE": { sign: "The Excavator", symbol: "♁" },
    "DEPTH+RIGOR": { sign: "The Auditor", symbol: "⚖" },
    "DEPTH+DELEGATION": { sign: "The Architect", symbol: "◈" },
    "DEPTH+BREADTH": { sign: "The Cartographer", symbol: "✦" },
    "DEPTH+ENDURANCE": { sign: "The Deep Worker", symbol: "◉" },
    "SCALE+RIGOR": { sign: "The Refinery", symbol: "⧉" },
    "SCALE+DELEGATION": { sign: "The Fleet Commander", symbol: "⚓" },
    "SCALE+BREADTH": { sign: "The Polyglot", symbol: "✸" },
    "SCALE+ENDURANCE": { sign: "The Marathoner", symbol: "∞" },
    "RIGOR+DELEGATION": { sign: "The Overseer", symbol: "△" },
    "RIGOR+BREADTH": { sign: "The Inspector", symbol: "✓" },
    "RIGOR+ENDURANCE": { sign: "The Watchkeeper", symbol: "◉" },
    "DELEGATION+BREADTH": { sign: "The Conductor", symbol: "⚘" },
    "DELEGATION+ENDURANCE": { sign: "The Ringmaster", symbol: "❂" },
    "BREADTH+ENDURANCE": { sign: "The Wanderer", symbol: "✵" },
};

/** when every axis is 0 (no insights at all) */
const VOID_SIGN = { sign: "The Unmeasured", symbol: "○" };

const fmtCompact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const pct1 = (x: number): string => `${Math.round(x * 10) / 10}%`;

/**
 * One dry, horoscope-toned sentence grounded in the real numbers behind the two
 * dominant axes - "Mercury has nothing to do with it" energy.
 */
function blurbFor(top: RadarAxisKey, second: RadarAxisKey, p: ProfileV1): string {
    const ins = p.insights;
    const fact = (axis: RadarAxisKey): string => {
        switch (axis) {
            case "DEPTH":
                return ins ? `${pct1(ins.deep_session_share * 100)} of your sessions run long` : "your deep-session share";
            case "SCALE":
                return `${fmtCompact.format(p.stats.tokens.total)} tokens moved`;
            case "RIGOR":
                return ins && ins.verification_calls !== undefined
                    ? `${fmtCompact.format(ins.verification_calls)} verification calls`
                    : "your verification habit";
            case "DELEGATION":
                return ins ? `${fmtCompact.format(ins.subagents_spawned)} subagents dispatched` : "your delegation rate";
            case "BREADTH":
                return ins && ins.distinct_skills !== undefined
                    ? `${fmtCompact.format(ins.distinct_skills)} distinct skills`
                    : "the width of your rig";
            case "ENDURANCE":
                return ins ? `${fmtCompact.format(ins.hours_total)} hours in the loop` : "your hours on the clock";
        }
    };
    return `The stars are flattered, but it's ${fact(top)} and ${fact(second)} that wrote this chart.`;
}

/**
 * archetypeFor - deterministic "agent sign" from the top-two dominant axes.
 * Ties broken by RADAR_AXIS_KEYS order. When all axes are 0, returns a void
 * sign rather than picking an arbitrary pair.
 */
export function archetypeFor(axes: RadarAxes, profile?: ProfileV1): Archetype {
    const ranked = rankAxes(axes);
    const top = ranked[0]!;
    const second = ranked[1]!;
    const allZero = RADAR_AXIS_KEYS.every((k) => axes.scores[k] === 0);
    const base = allZero ? VOID_SIGN : (SIGN_MATRIX[pairKey(top, second)] ?? VOID_SIGN);

    const blurb = allZero
        ? "No telemetry, no chart. Publish with a newer ax and the stars align."
        : profile
            ? blurbFor(top, second, profile)
            : `Born under ${top.toLowerCase()} rising, with ${second.toLowerCase()} on the ascendant.`;

    return { sign: base.sign, symbol: base.symbol, blurb };
}

/** the two axes that defined the sign - handy for the compare delta block */
export function dominantPair(axes: RadarAxes): readonly [RadarAxisKey, RadarAxisKey] {
    const ranked = rankAxes(axes);
    return [ranked[0]!, ranked[1]!];
}
