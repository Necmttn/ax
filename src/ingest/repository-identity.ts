import { repositoryRecordKey } from "./record-keys.ts";

export type RepositoryIdentityKind = "remote" | "initial_commit" | "local_path_hash";
export type CheckoutKind = "normal" | "worktree";

export interface RepositoryIdentityInput {
    remoteUrlNormalized?: string | null;
    initialCommit?: string | null;
    checkoutRoot?: string | null;
}

export interface RepositoryIdentity {
    kind: RepositoryIdentityKind;
    repositoryKey: string;
}

export function normalizeGitRemoteUrl(remoteUrl: string): string | null {
    const trimmed = remoteUrl.trim();
    if (trimmed.length === 0) return null;

    const withoutGitSuffix = trimmed.replace(/\.git\/?$/, "");
    const sshMatch = withoutGitSuffix.match(/^git@([^:]+):(.+)$/);
    if (sshMatch) {
        return `${sshMatch[1]}/${sshMatch[2].replace(/^\/+/, "")}`.toLowerCase();
    }

    try {
        const url = new URL(withoutGitSuffix);
        const pathname = url.pathname.replace(/^\/+|\/+$/g, "");
        if (url.hostname.length === 0 || pathname.length === 0) return null;
        return `${url.hostname}/${pathname}`.toLowerCase();
    } catch {
        const scpLike = withoutGitSuffix.match(/^([^:]+):(.+)$/);
        if (scpLike) {
            return `${scpLike[1]}/${scpLike[2].replace(/^\/+/, "")}`.toLowerCase();
        }
        return withoutGitSuffix.replace(/^\/+|\/+$/g, "").toLowerCase() || null;
    }
}

export function classifyCheckoutKind(gitEntry: string): CheckoutKind {
    return gitEntry.trim().startsWith("gitdir:") ? "worktree" : "normal";
}

export function chooseIdentity(input: RepositoryIdentityInput): RepositoryIdentity {
    const remoteUrlNormalized = input.remoteUrlNormalized?.trim();
    if (remoteUrlNormalized) {
        return {
            kind: "remote",
            repositoryKey: repositoryRecordKey({ remoteUrlNormalized }),
        };
    }

    const initialCommit = input.initialCommit?.trim();
    if (initialCommit) {
        return {
            kind: "initial_commit",
            repositoryKey: repositoryRecordKey({ initialCommit }),
        };
    }

    return {
        kind: "local_path_hash",
        repositoryKey: repositoryRecordKey({ checkoutRoot: input.checkoutRoot ?? null }),
    };
}
