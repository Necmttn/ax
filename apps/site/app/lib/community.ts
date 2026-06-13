/**
 * Community data: typed fetch + validation for profile gists and the
 * nightly-compiled leaderboard. Validation is intentionally manual (the
 * site does not depend on effect/Schema); throw-on-invalid mirrors
 * session-share.ts. Everything fetched here is untrusted user data -
 * validate shapes, render as text only.
 */

const REPO_RAW = "https://raw.githubusercontent.com/Necmttn/ax/main";
// Compiled outputs live on the community-data branch (nightly bot pushes
// there; main has a required-checks ruleset that blocks bot pushes).
const DATA_RAW = "https://raw.githubusercontent.com/Necmttn/ax/community-data";
const LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/;

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

// --- profile -----------------------------------------------------------------

export interface ProfileModel {
    readonly name: string;
    readonly share: number;
    readonly cost_usd?: number;
}
export interface ProfileSkill {
    readonly name: string;
    readonly source: string;
    readonly runs: number;
    readonly downstream_share?: number;
}
export interface TastePattern {
    readonly category: string;
    readonly name: string;
    readonly summary?: string;
    readonly slot?: string;
    readonly over?: readonly string[];
    readonly context?: string;
    readonly evidence: { readonly sessions: number; readonly confidence: number; readonly last_reinforced?: string; readonly trend?: string };
}
export interface ProfileDailyModelRow {
    readonly name: string;
    readonly tokens: number;
}
export interface ProfileDailyRow {
    readonly date: string;
    readonly sessions: number;
    readonly tokens: number;
    readonly models?: readonly ProfileDailyModelRow[];
    readonly tool_calls?: number;
    readonly commits?: number;
}
export interface WorkflowArc {
    readonly steps: readonly string[];
    readonly count: number;
}
export interface ProfileWorkflow {
    readonly arcs: readonly WorkflowArc[];
}
export interface ProfileToolRun {
    readonly name: string;
    readonly runs: number;
}
export interface ProfileInsights {
    readonly hours_total: number;
    readonly longest_session_minutes: number;
    readonly deep_session_share: number;
    readonly peak_hour_utc: number;
    readonly busiest_day: { readonly date: string; readonly sessions: number };
    readonly max_parallel_sessions: number;
    readonly subagents_spawned: number;
    readonly commits: number;
    readonly tools_top: readonly ProfileToolRun[];
    // wrapped-style window aggregates (optional - old gists may omit them)
    readonly turns?: number;
    readonly tool_calls?: number;
    readonly tool_failures?: number;
    readonly distinct_skills?: number;
    readonly distinct_tools?: number;
    readonly repos_count?: number;
    readonly verification_calls?: number;
    readonly context_calls?: number;
}
export interface ProfileV1 {
    readonly v: 1;
    readonly github: string;
    readonly generated_at: string;
    readonly window_days: number;
    readonly stats: {
        readonly sessions: number;
        readonly active_days: number;
        readonly streak_days: number;
        readonly tokens: { readonly prompt: number; readonly completion: number; readonly total: number };
        readonly cost_usd?: number;
        readonly models: readonly ProfileModel[];
        readonly harnesses: readonly string[];
    };
    readonly rig: {
        readonly skills: readonly ProfileSkill[];
        readonly hooks: readonly string[];
        readonly routing_table: boolean;
        readonly rules?: { readonly count: number };
    };
    readonly taste?: { readonly patterns: readonly TastePattern[] };
    readonly activity?: { readonly daily: readonly ProfileDailyRow[] };
    readonly insights?: ProfileInsights;
    readonly workflow?: ProfileWorkflow;
}

const optNum = (v: unknown, what: string): void => {
    if (v !== undefined) num(v, what);
};
const optStr = (v: unknown, what: string): void => {
    if (v !== undefined) str(v, what);
};

/**
 * Every field a route renders as a JSX child or calls a method on MUST be
 * validated here - a hostile gist value that survives this function can
 * only ever render as text, never crash the page.
 */
export function validateProfileV1(value: unknown): ProfileV1 {
    if (!isRecord(value) || value.v !== 1) throw new Error("not a v1 ax profile");
    const stats = value.stats;
    const rig = value.rig;
    if (!isRecord(stats) || !isRecord(rig)) throw new Error("profile missing stats/rig");
    const tokens = stats.tokens;
    if (!isRecord(tokens)) throw new Error("profile missing tokens");
    str(value.github, "github");
    str(value.generated_at, "generated_at");
    num(value.window_days, "window_days");
    num(stats.sessions, "sessions");
    num(stats.active_days, "active_days");
    num(stats.streak_days, "streak_days");
    num(tokens.total, "tokens.total");
    optNum(stats.cost_usd, "cost_usd");
    if (!Array.isArray(stats.models) || !Array.isArray(stats.harnesses)) throw new Error("invalid stats arrays");
    for (const h of stats.harnesses) str(h, "harness");
    if (!Array.isArray(rig.skills) || !Array.isArray(rig.hooks)) throw new Error("invalid rig arrays");
    for (const h of rig.hooks) str(h, "hook");
    if (rig.rules !== undefined) {
        if (!isRecord(rig.rules)) throw new Error("invalid rules");
        num(rig.rules.count, "rules.count");
    }
    for (const m of stats.models) {
        if (!isRecord(m)) throw new Error("invalid model row");
        str(m.name, "model.name");
        num(m.share, "model.share");
        optNum(m.cost_usd, "model.cost_usd");
    }
    for (const s of rig.skills) {
        if (!isRecord(s)) throw new Error("invalid skill row");
        str(s.name, "skill.name");
        str(s.source, "skill.source");
        num(s.runs, "skill.runs");
        optNum(s.downstream_share, "skill.downstream_share");
    }
    if (value.taste !== undefined) {
        if (!isRecord(value.taste) || !Array.isArray(value.taste.patterns)) throw new Error("invalid taste");
        for (const p of value.taste.patterns) {
            if (!isRecord(p) || !isRecord(p.evidence)) throw new Error("invalid pattern");
            str(p.category, "pattern.category");
            str(p.name, "pattern.name");
            optStr(p.summary, "pattern.summary");
            optStr(p.slot, "pattern.slot");
            num(p.evidence.sessions, "evidence.sessions");
            num(p.evidence.confidence, "evidence.confidence");
            optStr(p.evidence.trend, "evidence.trend");
        }
    }
    if (value.activity !== undefined) {
        if (!isRecord(value.activity) || !Array.isArray(value.activity.daily)) {
            throw new Error("invalid activity");
        }
        for (const d of value.activity.daily) {
            if (!isRecord(d)) throw new Error("invalid activity.daily row");
            str(d.date, "activity.daily.date");
            num(d.sessions, "activity.daily.sessions");
            num(d.tokens, "activity.daily.tokens");
            // New optional daily fields
            optNum(d.tool_calls, "activity.daily.tool_calls");
            optNum(d.commits, "activity.daily.commits");
            if (d.models !== undefined) {
                if (!Array.isArray(d.models)) throw new Error("invalid activity.daily.models");
                for (const m of d.models) {
                    if (!isRecord(m)) throw new Error("invalid daily model row");
                    str(m.name, "daily.model.name");
                    num(m.tokens, "daily.model.tokens");
                }
            }
        }
    }
    if (value.insights !== undefined) {
        const ins = value.insights;
        if (!isRecord(ins)) throw new Error("invalid insights");
        num(ins.hours_total, "insights.hours_total");
        num(ins.longest_session_minutes, "insights.longest_session_minutes");
        num(ins.deep_session_share, "insights.deep_session_share");
        num(ins.peak_hour_utc, "insights.peak_hour_utc");
        if (!isRecord(ins.busiest_day)) throw new Error("invalid insights.busiest_day");
        str(ins.busiest_day.date, "insights.busiest_day.date");
        num(ins.busiest_day.sessions, "insights.busiest_day.sessions");
        num(ins.max_parallel_sessions, "insights.max_parallel_sessions");
        num(ins.subagents_spawned, "insights.subagents_spawned");
        num(ins.commits, "insights.commits");
        if (!Array.isArray(ins.tools_top)) throw new Error("invalid insights.tools_top");
        for (const t of ins.tools_top) {
            if (!isRecord(t)) throw new Error("invalid tools_top row");
            str(t.name, "tools_top.name");
            num(t.runs, "tools_top.runs");
        }
        // wrapped-style optional fields
        optNum(ins.turns, "insights.turns");
        optNum(ins.tool_calls, "insights.tool_calls");
        optNum(ins.tool_failures, "insights.tool_failures");
        optNum(ins.distinct_skills, "insights.distinct_skills");
        optNum(ins.distinct_tools, "insights.distinct_tools");
        optNum(ins.repos_count, "insights.repos_count");
        optNum(ins.verification_calls, "insights.verification_calls");
        optNum(ins.context_calls, "insights.context_calls");
    }
    if (value.workflow !== undefined) {
        if (!isRecord(value.workflow) || !Array.isArray(value.workflow.arcs)) {
            throw new Error("invalid workflow");
        }
        for (const arc of value.workflow.arcs) {
            if (!isRecord(arc)) throw new Error("invalid workflow arc");
            if (!Array.isArray(arc.steps)) throw new Error("invalid workflow arc.steps");
            for (const step of arc.steps) str(step, "workflow.arc.step");
            num(arc.count, "workflow.arc.count");
        }
    }
    return value as unknown as ProfileV1;
}

// --- registration --------------------------------------------------------------

export interface Registration {
    readonly github: string;
    readonly gist_id: string;
    readonly joined: string;
}

export function validateRegistration(value: unknown): Registration {
    if (!isRecord(value)) throw new Error("invalid registration");
    return {
        github: str(value.github, "github"),
        gist_id: str(value.gist_id, "gist_id"),
        joined: str(value.joined, "joined"),
    };
}

// --- leaderboard ----------------------------------------------------------------

export interface BoardRow {
    readonly login: string;
    readonly value: number;
}
export interface Leaderboard {
    readonly compiled_at: string;
    readonly window_days: number;
    readonly boards: {
        readonly tokens: readonly BoardRow[];
        readonly sessions: readonly BoardRow[];
        readonly streak: readonly BoardRow[];
        readonly cost: readonly BoardRow[];
    };
}

export function validateLeaderboard(value: unknown): Leaderboard {
    if (!isRecord(value) || !isRecord(value.boards)) throw new Error("invalid leaderboard");
    const board = (key: string): BoardRow[] => {
        const rows = (value.boards as Record<string, unknown>)[key];
        if (!Array.isArray(rows)) throw new Error(`invalid board ${key}`);
        return rows.map((r) => {
            if (!isRecord(r)) throw new Error(`invalid row in ${key}`);
            return { login: str(r.login, "login"), value: num(r.value, "value") };
        });
    };
    return {
        compiled_at: typeof value.compiled_at === "string" ? value.compiled_at : "",
        window_days: typeof value.window_days === "number" ? value.window_days : 30,
        boards: {
            tokens: board("tokens"),
            sessions: board("sessions"),
            streak: board("streak"),
            cost: board("cost"),
        },
    };
}

export type SkillStats = Record<string, { readonly users: number; readonly runs: number }>;

// --- formatting (shared) --------------------------------------------------------

/**
 * Compact number formatter - the SAME one the leaderboard uses for token and
 * session counts. Reused for money so a raw `$22882` renders `$22.9k` instead
 * of an unreadable wall of digits. Do not add a second formatter elsewhere.
 */
const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
export const formatCompact = (n: number): string => compactFmt.format(n);

/** Grouped USD: `$22,882`. For larger boards prefer formatUsdCompact. */
const usdGroupedFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
export const formatUsd = (n: number): string => `$${usdGroupedFmt.format(n)}`;

/** Compact USD: `$22.9k` under 100k stays readable; reuses compactFmt. */
export const formatUsdCompact = (n: number): string =>
    n >= 10_000 ? `$${compactFmt.format(n)}` : `$${usdGroupedFmt.format(n)}`;

// --- trending skills (display filter) -------------------------------------------

/**
 * A skill "trends" only when it is a real, shared skill: plugin-namespaced or
 * a known shared source - never a one-off `local:*` skill scoped to a single
 * machine - and adopted by at least `minUsers` people. Without this the board
 * fills with junk (every personal/project skill from a single early adopter).
 */
export function trendingSkills(
    stats: SkillStats,
    opts: { readonly minUsers?: number; readonly limit?: number } = {},
): ReadonlyArray<readonly [string, { readonly users: number; readonly runs: number }]> {
    const minUsers = opts.minUsers ?? 2;
    const limit = opts.limit ?? 50;
    return Object.entries(stats)
        .filter(([name, s]) => !name.startsWith("local:") && s.users >= minUsers)
        .sort(([, a], [, b]) => b.users - a.users || b.runs - a.runs)
        .slice(0, limit);
}

export function validateSkillStats(value: unknown): SkillStats {
    if (!isRecord(value)) throw new Error("invalid skill stats");
    const out: Record<string, { users: number; runs: number }> = {};
    for (const [k, v] of Object.entries(value)) {
        if (!isRecord(v)) continue;
        if (typeof v.users === "number" && Number.isFinite(v.users)
            && typeof v.runs === "number" && Number.isFinite(v.runs)) {
            out[k] = { users: v.users, runs: v.runs };
        }
    }
    return out;
}

// --- urls + fetchers --------------------------------------------------------------

export function registrationRawUrl(login: string): string {
    if (!LOGIN_RE.test(login)) throw new Error("invalid login");
    return `${REPO_RAW}/community/users/${login.toLowerCase()}.json`;
}

export function profileGistRawUrl(owner: string, gistId: string): string {
    if (!LOGIN_RE.test(owner) || !/^[a-f0-9]+$/i.test(gistId)) throw new Error("invalid gist ref");
    return `https://gist.githubusercontent.com/${owner}/${gistId}/raw/ax-profile.json`;
}

export const leaderboardUrl = `${DATA_RAW}/community/leaderboard.json`;
export const skillStatsUrl = `${DATA_RAW}/community/skill-stats.json`;

async function fetchJson(url: string): Promise<unknown> {
    const res = await fetch(url);
    if (res.status === 404) throw Object.assign(new Error("not found"), { notFound: true });
    if (!res.ok) throw new Error(`fetch failed (${res.status})`);
    return res.json();
}

/** registration -> gist -> validated profile. Throws {notFound:true} when unregistered. */
export async function fetchProfile(login: string): Promise<ProfileV1> {
    const reg = validateRegistration(await fetchJson(registrationRawUrl(login)));
    return validateProfileV1(await fetchJson(profileGistRawUrl(reg.github, reg.gist_id)));
}

export async function fetchLeaderboard(): Promise<Leaderboard> {
    return validateLeaderboard(await fetchJson(leaderboardUrl));
}

export async function fetchSkillStats(): Promise<SkillStats> {
    return validateSkillStats(await fetchJson(skillStatsUrl));
}
