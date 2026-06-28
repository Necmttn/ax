/**
 * Effect-free profile validation for the community compile core.
 *
 * The canonical decoder lives in `apps/axctl/src/profile/schema.ts` and uses
 * Effect `Schema` - which cannot bundle into a Cloudflare Worker (and the site
 * deliberately stays effect-free too). This validator mirrors the subset of
 * ProfileV1 that the leaderboard compile actually reads, throwing on any shape
 * the boards would choke on, so a hostile gist can never produce a row.
 *
 * Keep in lockstep with the fields consumed in `compile.ts` - nothing more.
 */

/** The slice of a published ax profile the leaderboard compile depends on. */
export interface CompiledProfile {
    readonly github: string;
    readonly stats: {
        readonly sessions: number;
        readonly streak_days: number;
        readonly tokens: { readonly total: number };
        readonly cost_usd?: number;
        readonly models: ReadonlyArray<{ readonly name: string }>;
        readonly harnesses: readonly string[];
    };
    readonly rig: {
        readonly skills: ReadonlyArray<{ readonly name: string; readonly source: string; readonly runs: number }>;
        readonly hooks: readonly string[];
    };
}

export const PATTERN_CATEGORIES = [
    "design-aesthetic",
    "problem-solving-strategy",
    "debugging",
    "failure-mode",
    "workflow",
    "tool-output-mix",
    "stack-choice",
] as const;
export type PatternCategory = (typeof PATTERN_CATEGORIES)[number];

const PATTERN_CATEGORY_SET = new Set<string>(PATTERN_CATEGORIES);
const PATTERN_LINK_RELS = ["recovered-by", "pairs-with", "conflicts-with"] as const;
const PATTERN_LINK_REL_SET = new Set<string>(PATTERN_LINK_RELS);
const PATTERN_TRENDS = ["rising", "stable", "falling", "stale"] as const;
type PatternTrend = (typeof PATTERN_TRENDS)[number];
const PATTERN_TREND_SET = new Set<string>(PATTERN_TRENDS);

export interface CompiledPatternLink {
    readonly rel: (typeof PATTERN_LINK_RELS)[number];
    readonly ref: string;
}

export interface CompiledTastePattern {
    readonly category: PatternCategory;
    readonly name: string;
    readonly summary?: string;
    readonly slot?: string;
    readonly over?: readonly string[];
    readonly context?: string;
    readonly evidence: {
        readonly sessions: number;
        readonly confidence: number;
        readonly last_reinforced?: string;
        readonly trend?: PatternTrend;
    };
    readonly links?: readonly CompiledPatternLink[];
}

export type PatternDropReason = "invalid-pattern" | "duplicate-pattern";

export interface PatternDrop {
    readonly index?: number;
    readonly key?: string;
    readonly reason: PatternDropReason;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

const num = (v: unknown, what: string): number => {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`invalid ${what}`);
    return v;
};
const str = (v: unknown, what: string): string => {
    if (typeof v !== "string") throw new Error(`invalid ${what}`);
    return v;
};

/**
 * Validate untrusted gist JSON into a CompiledProfile, or throw. Only the
 * fields the boards read are checked; everything else on the profile is
 * ignored. Throws (never returns partial) so the caller drops the row as
 * `invalid-profile`.
 */
export function validateProfile(value: unknown): CompiledProfile {
    if (!isRecord(value) || value.v !== 1) throw new Error("not a v1 ax profile");
    const stats = value.stats;
    const rig = value.rig;
    if (!isRecord(stats) || !isRecord(rig)) throw new Error("profile missing stats/rig");
    const tokens = stats.tokens;
    if (!isRecord(tokens)) throw new Error("profile missing tokens");
    if (!Array.isArray(stats.models) || !Array.isArray(stats.harnesses)) throw new Error("invalid stats arrays");
    if (!Array.isArray(rig.skills) || !Array.isArray(rig.hooks)) throw new Error("invalid rig arrays");

    const github = str(value.github, "github");
    const sessions = num(stats.sessions, "sessions");
    const streak_days = num(stats.streak_days, "streak_days");
    const total = num(tokens.total, "tokens.total");
    const cost_usd = stats.cost_usd === undefined ? undefined : num(stats.cost_usd, "cost_usd");

    for (const h of stats.harnesses) str(h, "harness");
    for (const h of rig.hooks) str(h, "hook");

    const models = stats.models.map((m) => {
        if (!isRecord(m)) throw new Error("invalid model row");
        return { name: str(m.name, "model.name") };
    });
    const skills = rig.skills.map((s) => {
        if (!isRecord(s)) throw new Error("invalid skill row");
        return { name: str(s.name, "skill.name"), source: str(s.source, "skill.source"), runs: num(s.runs, "skill.runs") };
    });

    return {
        github,
        stats: {
            sessions,
            streak_days,
            tokens: { total },
            ...(cost_usd === undefined ? {} : { cost_usd }),
            models,
            harnesses: stats.harnesses as string[],
        },
        rig: { skills, hooks: rig.hooks as string[] },
    };
}

export function patternKey(category: string, name: string): string {
    return `${category.trim()}/${name.trim()}`;
}

const finitePatternNumber = (v: unknown, what: string): number => {
    const n = num(v, what);
    if (n < 0) throw new Error(`invalid ${what}`);
    return n;
};

function validatePatternRow(row: unknown): CompiledTastePattern {
    if (!isRecord(row) || !isRecord(row.evidence)) throw new Error("invalid pattern");
    const category = str(row.category, "pattern.category").trim();
    const name = str(row.name, "pattern.name").trim();
    if (!PATTERN_CATEGORY_SET.has(category) || name === "" || name.includes("/")) throw new Error("invalid pattern key");

    const trend = row.evidence.trend === undefined ? undefined : str(row.evidence.trend, "pattern.evidence.trend");
    if (trend !== undefined && !PATTERN_TREND_SET.has(trend)) throw new Error("invalid pattern.evidence.trend");
    const evidence: CompiledTastePattern["evidence"] = {
        sessions: finitePatternNumber(row.evidence.sessions, "pattern.evidence.sessions"),
        confidence: finitePatternNumber(row.evidence.confidence, "pattern.evidence.confidence"),
        ...(row.evidence.last_reinforced === undefined ? {} : { last_reinforced: str(row.evidence.last_reinforced, "pattern.evidence.last_reinforced") }),
        ...(trend === undefined ? {} : { trend: trend as PatternTrend }),
    };
    if (evidence.confidence > 1) throw new Error("invalid pattern.evidence.confidence");

    if (category === "stack-choice") {
        const slot = str(row.slot, "pattern.slot").trim();
        if (slot === "") throw new Error("invalid pattern.slot");
        const over = row.over === undefined ? undefined : row.over;
        if (over !== undefined && (!Array.isArray(over) || over.some((v) => typeof v !== "string"))) {
            throw new Error("invalid pattern.over");
        }
        const links = validatePatternLinks(row.links);
        return {
            category,
            slot,
            name,
            evidence,
            ...(over === undefined ? {} : { over: over as string[] }),
            ...(row.context === undefined ? {} : { context: str(row.context, "pattern.context") }),
            ...(links === undefined ? {} : { links }),
        };
    }

    const summary = str(row.summary, "pattern.summary").trim();
    if (summary === "") throw new Error("invalid pattern.summary");
    const links = validatePatternLinks(row.links);
    return {
        category: category as Exclude<PatternCategory, "stack-choice">,
        name,
        summary,
        evidence,
        ...(links === undefined ? {} : { links }),
    };
}

function validatePatternLinks(value: unknown): CompiledPatternLink[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw new Error("invalid pattern.links");
    return value.map((link) => {
        if (!isRecord(link)) throw new Error("invalid pattern.link");
        const rel = str(link.rel, "pattern.link.rel");
        const ref = str(link.ref, "pattern.link.ref").trim();
        if (!PATTERN_LINK_REL_SET.has(rel) || ref === "") throw new Error("invalid pattern.link");
        return { rel: rel as CompiledPatternLink["rel"], ref };
    });
}

/**
 * Validate optional taste patterns without invalidating the whole profile. The
 * profile gist is user-controlled community input; one bad taste row should be
 * reported and skipped, not erase the user's leaderboard row.
 */
export function validateTastePatterns(value: unknown): { patterns: CompiledTastePattern[]; dropped: PatternDrop[] } {
    if (!isRecord(value) || value.taste === undefined) return { patterns: [], dropped: [] };
    if (!isRecord(value.taste) || !Array.isArray(value.taste.patterns)) {
        return { patterns: [], dropped: [{ reason: "invalid-pattern" }] };
    }

    const patterns: CompiledTastePattern[] = [];
    const dropped: PatternDrop[] = [];
    const seen = new Set<string>();
    for (const [index, row] of value.taste.patterns.entries()) {
        let p: CompiledTastePattern;
        try {
            p = validatePatternRow(row);
        } catch {
            dropped.push({ index, reason: "invalid-pattern" });
            continue;
        }
        const key = patternKey(p.category, p.name);
        if (seen.has(key)) {
            dropped.push({ index, key, reason: "duplicate-pattern" });
            continue;
        }
        seen.add(key);
        patterns.push(p);
    }
    return { patterns, dropped };
}
