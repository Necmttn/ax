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
}

export function validateProfileV1(value: unknown): ProfileV1 {
    if (!isRecord(value) || value.v !== 1) throw new Error("not a v1 ax profile");
    const stats = value.stats;
    const rig = value.rig;
    if (!isRecord(stats) || !isRecord(rig)) throw new Error("profile missing stats/rig");
    const tokens = stats.tokens;
    if (!isRecord(tokens)) throw new Error("profile missing tokens");
    num(stats.sessions, "sessions");
    num(tokens.total, "tokens.total");
    str(value.github, "github");
    if (!Array.isArray(stats.models) || !Array.isArray(stats.harnesses)) throw new Error("invalid stats arrays");
    if (!Array.isArray(rig.skills) || !Array.isArray(rig.hooks)) throw new Error("invalid rig arrays");
    for (const m of stats.models) {
        if (!isRecord(m)) throw new Error("invalid model row");
        str(m.name, "model.name");
        num(m.share, "model.share");
    }
    for (const s of rig.skills) {
        if (!isRecord(s)) throw new Error("invalid skill row");
        str(s.name, "skill.name");
        num(s.runs, "skill.runs");
    }
    if (value.taste !== undefined) {
        if (!isRecord(value.taste) || !Array.isArray(value.taste.patterns)) throw new Error("invalid taste");
        for (const p of value.taste.patterns) {
            if (!isRecord(p) || !isRecord(p.evidence)) throw new Error("invalid pattern");
            str(p.category, "pattern.category");
            str(p.name, "pattern.name");
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

export function validateSkillStats(value: unknown): SkillStats {
    if (!isRecord(value)) throw new Error("invalid skill stats");
    const out: Record<string, { users: number; runs: number }> = {};
    for (const [k, v] of Object.entries(value)) {
        if (!isRecord(v)) continue;
        if (typeof v.users === "number" && typeof v.runs === "number") {
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
