/**
 * Private, machine-local opt-in state for team dashboard sharing.
 *
 * Missing or invalid state is always treated as empty (default-deny). The file
 * contains no repo data itself, only the fail-closed repository key and the
 * user's sharing choice.
 */
import { atomicWriteJson } from "../profile/fs.ts";

export const TEAM_SHARE_VALUES = ["anon", "full"] as const;
export type TeamShare = (typeof TEAM_SHARE_VALUES)[number];
export const DEFAULT_TEAM_SHARE: TeamShare = "anon";

export interface TeamBinding {
    readonly org: string;
    readonly share: TeamShare;
    readonly joined_at: string;
}

export interface TeamBindings {
    readonly v: 1;
    readonly bindings: Readonly<Record<string, TeamBinding>>;
}

export const emptyTeamBindings = (): TeamBindings => ({ v: 1, bindings: {} });

export const defaultTeamBindingsPath = (): string =>
    `${process.env.HOME}/.ax/team-bindings.json`;

const isTeamShare = (value: unknown): value is TeamShare =>
    value === "anon" || value === "full";

const decodeBinding = (value: unknown): TeamBinding | null => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
        typeof record.org !== "string" ||
        record.org.trim().length === 0 ||
        !isTeamShare(record.share) ||
        typeof record.joined_at !== "string" ||
        record.joined_at.length === 0
    ) {
        return null;
    }
    return {
        org: record.org,
        share: record.share,
        joined_at: record.joined_at,
    };
};

const decodeTeamBindings = (value: unknown): TeamBindings | null => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
        record.v !== 1 ||
        typeof record.bindings !== "object" ||
        record.bindings === null ||
        Array.isArray(record.bindings)
    ) {
        return null;
    }

    const bindings: Record<string, TeamBinding> = {};
    for (const [repoKey, rawBinding] of Object.entries(record.bindings)) {
        if (repoKey.length === 0) return null;
        const binding = decodeBinding(rawBinding);
        if (binding === null) return null;
        bindings[repoKey] = binding;
    }
    return { v: 1, bindings };
};

export async function loadTeamBindings(path: string): Promise<TeamBindings> {
    try {
        const file = Bun.file(path);
        if (!(await file.exists())) return emptyTeamBindings();
        return decodeTeamBindings(JSON.parse(await file.text())) ?? emptyTeamBindings();
    } catch {
        return emptyTeamBindings();
    }
}

export async function saveTeamBindings(path: string, state: TeamBindings): Promise<void> {
    await atomicWriteJson(path, state);
}

export const bindingFor = (
    state: TeamBindings,
    repoKey: string,
): TeamBinding | undefined => state.bindings[repoKey];

export async function upsertTeamBinding(
    path: string,
    repoKey: string,
    binding: TeamBinding,
): Promise<TeamBindings> {
    const current = await loadTeamBindings(path);
    const next: TeamBindings = {
        v: 1,
        bindings: {
            ...current.bindings,
            [repoKey]: binding,
        },
    };
    await saveTeamBindings(path, next);
    return next;
}

export async function removeTeamBinding(path: string, repoKey: string): Promise<boolean> {
    const current = await loadTeamBindings(path);
    if (bindingFor(current, repoKey) === undefined) return false;
    const bindings = { ...current.bindings };
    delete bindings[repoKey];
    await saveTeamBindings(path, { v: 1, bindings });
    return true;
}
