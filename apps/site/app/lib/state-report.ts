import type { StateReport } from "@ax/lib/shared/community";

export const STATE_MIN_USERS = 25;

export interface StateRow {
    readonly label: string;
    readonly count: number;
    readonly share: number;
}

export function parseStateYearParam(
    raw: string,
    opts: { readonly nowYear?: number } = {},
): number | null {
    if (!/^\d{4}$/.test(raw)) return null;
    const year = Number(raw);
    const nowYear = opts.nowYear ?? new Date().getUTCFullYear();
    if (year > nowYear) return null;
    if (year < 2020) return null;
    return year;
}

export function hasEnoughStateUsers(
    report: Pick<StateReport, "users">,
    minUsers = STATE_MIN_USERS,
): boolean {
    return report.users >= minUsers;
}

export function stateRows(values: Record<string, number>, denominator?: number): StateRow[] {
    const total = denominator ?? Object.values(values).reduce((sum, n) => sum + n, 0);
    return Object.entries(values)
        .map(([label, count]) => ({
            label,
            count,
            share: total > 0 ? count / total : 0,
        }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function topStateRows(values: Record<string, number>, limit: number, denominator?: number): StateRow[] {
    return stateRows(values, denominator).slice(0, limit);
}
