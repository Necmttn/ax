type RepositoryKeyInput = {
    remoteUrlNormalized?: string | null;
    initialCommit?: string | null;
    checkoutRoot?: string | null;
};

type ToolKeyInput = {
    provider: string;
    kind: string;
    name: string;
};

type ToolCallKeyInput = {
    sessionId: string;
    seq: number;
    callId?: string | null;
};

const sanitizeRecordKeyPart = (value: string, fallback = "_"): string => {
    const sanitized = value
        .replace(/[^a-zA-Z0-9]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
    return sanitized.length > 0 ? sanitized : fallback;
};

const longHash = (value: string): string => Bun.hash(value).toString(16).padStart(16, "0");

const identityPart = (value: string, fallback = "_"): string => {
    const sanitized = sanitizeRecordKeyPart(value, fallback);
    return `${sanitized}__${longHash(value)}`;
};

const normalizeRepositoryKey = (repositoryKey: string): string =>
    repositoryKey.startsWith("repository:") ? repositoryKey.slice("repository:".length) : repositoryKey;

export function repositoryRecordKey(input: RepositoryKeyInput): string {
    if (input.remoteUrlNormalized) {
        return `remote__${identityPart(input.remoteUrlNormalized)}`;
    }

    if (input.initialCommit) {
        return `initial__${sanitizeRecordKeyPart(input.initialCommit).slice(0, 16)}`;
    }

    const checkoutRoot = input.checkoutRoot ?? "unknown";
    return `local__${identityPart(checkoutRoot, "checkout")}`;
}

export function checkoutRecordKey(checkoutRoot: string): string {
    return identityPart(checkoutRoot, "checkout");
}

// Prefer the raw repository key (`remote__...`), but normalize accidental RecordId strings.
export function fileRecordKey(repositoryKey: string, path: string): string {
    const normalizedRepositoryKey = normalizeRepositoryKey(repositoryKey);
    return `${identityPart(normalizedRepositoryKey, "repository")}__${identityPart(path, "file")}`;
}

export function commitRecordKey(repositoryKey: string, sha: string): string {
    const normalizedRepositoryKey = normalizeRepositoryKey(repositoryKey);
    return `${identityPart(normalizedRepositoryKey, "repository")}__${identityPart(sha, "commit")}`;
}

export function toolRecordKey(input: ToolKeyInput): string {
    return [
        identityPart(input.provider, "provider"),
        identityPart(input.kind, "kind"),
        identityPart(input.name, "tool"),
    ].join("__");
}

export function toolCallRecordKey(input: ToolCallKeyInput): string {
    const sessionPart = identityPart(input.sessionId, "session");
    const callPart = input.callId
        ? identityPart(input.callId, "call")
        : `seq_${input.seq.toString(10).padStart(6, "0")}`;

    return `${sessionPart}__${callPart}`;
}
