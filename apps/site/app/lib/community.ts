/**
 * Community data: typed fetch + validation for profile gists and the
 * nightly-compiled leaderboard. Validation is intentionally manual (the
 * site does not depend on effect/Schema); throw-on-invalid mirrors
 * session-share.ts. Everything fetched here is untrusted user data -
 * validate shapes, render as text only.
 */

const REPO_RAW = "https://raw.githubusercontent.com/Necmttn/ax/main";
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
export interface ProfileDailyRow {
    readonly date: string;
    readonly sessions: number;
    readonly tokens: number;
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

export const leaderboardUrl = `${REPO_RAW}/community/leaderboard.json`;
export const skillStatsUrl = `${REPO_RAW}/community/skill-stats.json`;

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
