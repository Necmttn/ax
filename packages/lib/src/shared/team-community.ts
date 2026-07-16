/**
 * Browser-safe TeamProfileV1 contract.
 *
 * Validation is intentionally manual so consumers do not pull Effect into
 * their bundle. Snapshots are untrusted git data, so malformed fields collapse
 * to inert render-safe defaults instead of escaping into the render path.
 */

export interface TeamProfileV1 {
    readonly v: 1;
    readonly login: string | null;
    readonly org: string;
    readonly repo_key: string;
    readonly window_days: number;
    readonly generated_at: string;
    readonly stats: {
        readonly sessions: number;
        readonly active_days: number;
        readonly harnesses: ReadonlyArray<string>;
    };
    readonly activity: {
        readonly daily: ReadonlyArray<{
            readonly date: string;
            readonly sessions: number;
            readonly tokens: number;
        }>;
    };
    readonly skills: ReadonlyArray<{
        readonly skill: string;
        readonly runs: number;
        readonly sessions: number;
    }>;
    readonly spend: {
        readonly tokens: {
            readonly prompt: number;
            readonly completion: number;
            readonly total: number;
        };
        readonly cost_usd: number | null;
        readonly model_mix: ReadonlyArray<{
            readonly model: string;
            readonly share: number;
            readonly tokens: number;
            readonly cost_usd?: number;
        }>;
    };
    readonly efficiency: {
        readonly tool_calls: number;
        readonly tool_failures: number;
        readonly verification_calls: number;
    };
}

type UnknownRecord = Record<string, unknown>;

const record = (value: unknown): UnknownRecord =>
    typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as UnknownRecord
        : {};

const text = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (value === null || value === undefined) return "";
    try {
        return String(value);
    } catch {
        return "";
    }
};

const nonNegative = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;

const ratio = (value: unknown): number => Math.min(1, nonNegative(value));

const rows = <T>(value: unknown, map: (row: UnknownRecord) => T): T[] =>
    Array.isArray(value) ? value.map((item) => map(record(item))) : [];

function normalizeTeamProfile(value: unknown): TeamProfileV1 {
    const profile = record(value);
    const stats = record(profile.stats);
    const activity = record(profile.activity);
    const spend = record(profile.spend);
    const tokens = record(spend.tokens);
    const efficiency = record(profile.efficiency);

    return {
        v: 1,
        login: profile.login === null ? null : text(profile.login),
        org: text(profile.org),
        repo_key: text(profile.repo_key),
        window_days: nonNegative(profile.window_days),
        generated_at: text(profile.generated_at),
        stats: {
            sessions: nonNegative(stats.sessions),
            active_days: nonNegative(stats.active_days),
            harnesses: Array.isArray(stats.harnesses) ? stats.harnesses.map(text) : [],
        },
        activity: {
            daily: rows(activity.daily, (row) => ({
                date: text(row.date),
                sessions: nonNegative(row.sessions),
                tokens: nonNegative(row.tokens),
            })),
        },
        skills: rows(profile.skills, (row) => ({
            skill: text(row.skill),
            runs: nonNegative(row.runs),
            sessions: nonNegative(row.sessions),
        })),
        spend: {
            tokens: {
                prompt: nonNegative(tokens.prompt),
                completion: nonNegative(tokens.completion),
                total: nonNegative(tokens.total),
            },
            cost_usd: spend.cost_usd === null ? null : nonNegative(spend.cost_usd),
            model_mix: rows(spend.model_mix, (row) => ({
                model: text(row.model),
                share: ratio(row.share),
                tokens: nonNegative(row.tokens),
                ...(typeof row.cost_usd === "number" && Number.isFinite(row.cost_usd)
                    ? { cost_usd: nonNegative(row.cost_usd) }
                    : {}),
            })),
        },
        efficiency: {
            tool_calls: nonNegative(efficiency.tool_calls),
            tool_failures: nonNegative(efficiency.tool_failures),
            verification_calls: nonNegative(efficiency.verification_calls),
        },
    };
}

export function validateTeamProfile(value: unknown): TeamProfileV1 {
    try {
        return normalizeTeamProfile(value);
    } catch {
        return normalizeTeamProfile({});
    }
}
