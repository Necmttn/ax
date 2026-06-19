/**
 * Minimal community client for the studio Team Metrics MEMBERS tab.
 *
 * Ported from apps/site/app/lib/community.ts (same URLs, same registration ->
 * gist -> profile fetch path, CORS-open raw.githubusercontent + gist raw). The
 * studio is loopback-local, but MEMBER data is inherently public, so we fetch
 * the same registered-gist profiles the site does. Validation is trimmed to the
 * fields the comparison reads - everything is rendered as text only.
 *
 * TODO: unify with apps/site/app/lib/community.ts into @ax/lib/shared/community
 * so both apps share one validator (mirrors the @ax/recap-deck unification).
 */

const REPO_RAW = "https://raw.githubusercontent.com/Necmttn/ax/main";
const BOARD_API = "https://ax-community.necmttn.com";
const LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/;

/** Known registered logins (community/users/*.json). Seeds the MEMBERS roster
 *  so it is not gated on the sparse nightly-compiled leaderboard. */
export const SEED_LOGINS = [
    "Necmttn", "janniks", "jannik-stacks", "mitchnick", "supnim", "dariia-smyrnova",
] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown, what: string): string => {
    if (typeof v !== "string") throw new Error(`invalid ${what}`);
    return v;
};

export interface MemberModel {
    readonly name: string;
    readonly share: number;
    readonly cost_usd?: number;
}
/** Trimmed ProfileV1 - only the fields the comparison reads. */
export interface MemberProfile {
    readonly github: string;
    readonly generated_at: string;
    readonly window_days: number;
    readonly sessions: number;
    readonly active_days: number;
    readonly streak_days: number;
    readonly tokens_total: number;
    readonly cost_usd: number | null;
    readonly models: ReadonlyArray<MemberModel>;
    readonly harnesses: ReadonlyArray<string>;
    readonly skills_top: ReadonlyArray<{ name: string; runs: number }>;
}

function parseProfile(value: unknown): MemberProfile {
    if (!isRecord(value) || value.v !== 1) throw new Error("not a v1 ax profile");
    const stats = value.stats;
    if (!isRecord(stats) || !isRecord(stats.tokens)) throw new Error("profile missing stats/tokens");
    const models = Array.isArray(stats.models) ? stats.models : [];
    const harnesses = Array.isArray(stats.harnesses) ? stats.harnesses : [];
    const rig = isRecord(value.rig) ? value.rig : {};
    const skills = Array.isArray(rig.skills) ? rig.skills : [];
    return {
        github: str(value.github, "github"),
        generated_at: typeof value.generated_at === "string" ? value.generated_at : "",
        window_days: num(value.window_days),
        sessions: num(stats.sessions),
        active_days: num(stats.active_days),
        streak_days: num(stats.streak_days),
        tokens_total: num((stats.tokens as Record<string, unknown>).total),
        cost_usd: typeof stats.cost_usd === "number" ? stats.cost_usd : null,
        models: models.filter(isRecord).map((m) => ({
            name: str(m.name, "model.name"),
            share: num(m.share),
            ...(typeof m.cost_usd === "number" ? { cost_usd: m.cost_usd } : {}),
        })),
        harnesses: harnesses.filter((h): h is string => typeof h === "string"),
        skills_top: skills.filter(isRecord)
            .map((s) => ({ name: str(s.name, "skill.name"), runs: num(s.runs) }))
            .sort((a, b) => b.runs - a.runs).slice(0, 5),
    };
}

interface Registration { github: string; gist_id: string }
function parseRegistration(value: unknown): Registration {
    if (!isRecord(value)) throw new Error("invalid registration");
    return { github: str(value.github, "github"), gist_id: str(value.gist_id, "gist_id") };
}

function registrationRawUrl(login: string): string {
    if (!LOGIN_RE.test(login)) throw new Error("invalid login");
    return `${REPO_RAW}/community/users/${login.toLowerCase()}.json`;
}
function profileGistRawUrl(owner: string, gistId: string): string {
    if (!LOGIN_RE.test(owner) || !/^[a-f0-9]+$/i.test(gistId)) throw new Error("invalid gist ref");
    return `https://gist.githubusercontent.com/${owner}/${gistId}/raw/ax-profile.json`;
}

async function fetchJson(url: string): Promise<unknown> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch failed (${res.status})`);
    return res.json();
}

/** registration -> gist -> validated trimmed profile. */
export async function fetchMember(login: string): Promise<MemberProfile> {
    const reg = parseRegistration(await fetchJson(registrationRawUrl(login)));
    return parseProfile(await fetchJson(profileGistRawUrl(reg.github, reg.gist_id)));
}

/** Fetch every seed login in parallel; drop the ones that fail (unregistered /
 *  no gist / invalid). Returns the members that resolved, richest first. */
export async function fetchMembers(logins: ReadonlyArray<string> = SEED_LOGINS): Promise<MemberProfile[]> {
    const settled = await Promise.allSettled(logins.map((l) => fetchMember(l)));
    return settled
        .filter((r): r is PromiseFulfilledResult<MemberProfile> => r.status === "fulfilled")
        .map((r) => r.value)
        .sort((a, b) => b.sessions - a.sessions);
}

export { BOARD_API };
