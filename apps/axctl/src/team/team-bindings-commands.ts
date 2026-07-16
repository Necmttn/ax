import type { PwdResolution } from "../pwd.ts";
import {
    DEFAULT_TEAM_SHARE,
    bindingFor,
    loadTeamBindings,
    removeTeamBinding,
    upsertTeamBinding,
    type TeamShare,
} from "./team-bindings-state.ts";

export interface TeamRepositoryContext {
    readonly repoKey: string;
    readonly name: string;
    readonly repoRoot: string;
    readonly remoteUrlNormalized: string | null;
}

export const teamRepositoryContext = (
    resolution: PwdResolution,
): TeamRepositoryContext => ({
    repoKey: resolution.identity.repositoryKey,
    name:
        resolution.remoteUrlNormalized?.split("/").at(-1) ??
        resolution.repoRoot.split("/").filter(Boolean).at(-1) ??
        resolution.repoRoot,
    repoRoot: resolution.repoRoot,
    remoteUrlNormalized: resolution.remoteUrlNormalized,
});

type WriteLine = (line: string) => void;

const repoDisplay = (repo: TeamRepositoryContext): string =>
    repo.remoteUrlNormalized ?? repo.repoRoot;

const consentLines = (
    repo: TeamRepositoryContext,
    org: string,
    share: TeamShare,
): ReadonlyArray<string> => [
    "[ax team join] repo-scoped sharing consent",
    `repo: ${repoDisplay(repo)}`,
    `repo_key: ${repo.repoKey}`,
    `org: ${org}`,
    `share: ${share}`,
    "fields shared on a later `ax team push`: aggregate skill/hook usage, model mix, cost, verification, tool-failure, and workflow metrics for this repo only.",
    "never shared: no transcripts, no prompts/responses, no code or file contents, no paths, flag values, or positional arguments.",
    share === "anon"
        ? "identity: anonymous aggregate contribution; GitHub login is stripped."
        : "identity: named contribution; GitHub login may be included.",
];

export interface JoinTeamBindingInput {
    readonly org: string;
    readonly currentRepo: TeamRepositoryContext;
    readonly statePath: string;
    readonly share?: TeamShare;
    readonly confirmed?: boolean;
    readonly confirm?: () => boolean | Promise<boolean>;
    readonly now?: string;
    readonly write: WriteLine;
}

export async function joinTeamBinding(
    input: JoinTeamBindingInput,
): Promise<"joined" | "aborted"> {
    const share = input.share ?? DEFAULT_TEAM_SHARE;
    for (const line of consentLines(input.currentRepo, input.org, share)) input.write(line);
    const confirmed = input.confirmed ?? (await input.confirm?.()) ?? false;
    if (!confirmed) {
        input.write("Aborted. Nothing was bound.");
        return "aborted";
    }

    await upsertTeamBinding(input.statePath, input.currentRepo.repoKey, {
        org: input.org,
        share,
        joined_at: input.now ?? new Date().toISOString(),
    });
    input.write(
        `[ax team join] bound ${input.currentRepo.name} (${input.currentRepo.repoKey}) → ${input.org} (${share})`,
    );
    return "joined";
}

export interface StatusTeamBindingsInput {
    readonly statePath: string;
    readonly currentRepo: TeamRepositoryContext | null;
    readonly write: WriteLine;
}

export async function statusTeamBindings(input: StatusTeamBindingsInput): Promise<void> {
    const state = await loadTeamBindings(input.statePath);
    const entries = Object.entries(state.bindings).sort(([left], [right]) =>
        left.localeCompare(right),
    );
    if (entries.length === 0) {
        input.write("[ax team status] no repos bound (default-deny; nothing will push).");
        return;
    }

    input.write(`[ax team status] ${entries.length} bound repo(s):`);
    for (const [repoKey, binding] of entries) {
        const current = input.currentRepo?.repoKey === repoKey;
        const name = current ? `${input.currentRepo.name} / ` : "";
        input.write(
            `${current ? "*" : " "} ${name}${repoKey} → ${binding.org}  share=${binding.share}`,
        );
    }
    if (input.currentRepo !== null && bindingFor(state, input.currentRepo.repoKey) === undefined) {
        input.write(
            `current repo ${input.currentRepo.name} is unbound (default-deny; nothing will push).`,
        );
    }
}

export interface LeaveTeamBindingInput {
    readonly currentRepo: TeamRepositoryContext;
    readonly statePath: string;
    readonly write: WriteLine;
}

export async function leaveTeamBinding(
    input: LeaveTeamBindingInput,
): Promise<"left" | "unbound"> {
    const removed = await removeTeamBinding(input.statePath, input.currentRepo.repoKey);
    if (!removed) {
        input.write(
            `[ax team leave] ${input.currentRepo.name} is not bound; nothing to do.`,
        );
        return "unbound";
    }
    input.write(
        `[ax team leave] unbound ${input.currentRepo.name} (${input.currentRepo.repoKey}).`,
    );
    return "left";
}
