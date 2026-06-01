export type RepositoryKeyInput = {
    readonly remoteUrlNormalized?: string | null;
    readonly initialCommit?: string | null;
    readonly checkoutRoot?: string | null;
};
export type ToolKeyInput = {
    readonly provider: string;
    readonly kind: string;
    readonly name: string;
};
export type ToolCallKeyInput = {
    readonly sessionId: string;
    readonly seq: number;
    readonly callId?: string | null;
};
export type InvokedRelationKeyInput = {
    readonly turnKey: string;
    readonly skillKey: string;
    readonly args: string;
};
export type EditedRelationKeyInput = {
    readonly turnKey: string;
    readonly fileKey: string;
    readonly tool: string;
};
export type MentionedRelationKeyInput = {
    readonly turnKey: string;
    readonly targetKey: string;
    readonly source: string;
};
export type ToolFileRelationKeyInput = {
    readonly toolCallKey: string;
    readonly fileKey: string;
    readonly kind: string;
};

export function stableDigest(value: string, length = 16): string {
    // Preserve existing Bun.hash behavior - ax's 89 baseline tests depend on these exact hashes.
    return Bun.hash(value).toString(16).padStart(16, "0").slice(0, length);
}

export function sanitizeRecordKeyPart(value: string, fallback = "_"): string {
    const sanitized = value
        .replace(/[^a-zA-Z0-9]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
    return sanitized.length > 0 ? sanitized : fallback;
}

export function identityPart(value: string, fallback = "_"): string {
    return `${sanitizeRecordKeyPart(value, fallback)}__${stableDigest(value)}`;
}

export function normalizeRepositoryKey(repositoryKey: string): string {
    const trimmed = repositoryKey.trim();
    const recordLiteral = trimmed.match(/^repository:`(.+)`$/);
    if (recordLiteral) return recordLiteral[1];
    if (trimmed.startsWith("repository:")) return trimmed.slice("repository:".length);
    return trimmed;
}

export function repositoryRecordKey(input: RepositoryKeyInput): string {
    if (input.remoteUrlNormalized) return `remote__${identityPart(input.remoteUrlNormalized)}`;
    if (input.initialCommit) {
        return `initial__${sanitizeRecordKeyPart(input.initialCommit).slice(0, 16)}`;
    }
    return `local__${identityPart(input.checkoutRoot ?? "unknown", "checkout")}`;
}

export function checkoutRecordKey(checkoutRoot: string): string {
    return identityPart(checkoutRoot, "checkout");
}

export function fileRecordKey(repositoryKey: string, path: string): string {
    return `${identityPart(normalizeRepositoryKey(repositoryKey), "repository")}__${identityPart(path, "file")}`;
}

export function commitRecordKey(repositoryKey: string, sha: string): string {
    return `${identityPart(normalizeRepositoryKey(repositoryKey), "repository")}__${identityPart(sha, "commit")}`;
}

export function skillRecordKeyV2(name: string): string {
    return `v2__${identityPart(name, "skill")}`;
}

export function symbolRecordKey(name: string): string {
    return identityPart(name, "symbol");
}

export function errorSignatureRecordKey(normalized: string): string {
    return identityPart(normalized, "error");
}

export function legacySkillRecordKey(name: string): string {
    return name.replace(/:/g, "__");
}

export function turnRecordKey(sessionId: string, seq: number): string {
    return `${sanitizeRecordKeyPart(sessionId, "session")}__${stableDigest(sessionId)}__seq_${seq.toString(10).padStart(6, "0")}`;
}

export function toolRecordKey(input: ToolKeyInput): string {
    return [
        identityPart(input.provider, "provider"),
        identityPart(input.kind, "kind"),
        identityPart(input.name, "tool"),
    ].join("__");
}

export function toolCallRecordKey(input: ToolCallKeyInput): string {
    const callPart = input.callId
        ? identityPart(input.callId, "call")
        : `seq_${input.seq.toString(10).padStart(6, "0")}`;
    return `${identityPart(input.sessionId, "session")}__${callPart}`;
}

export function invokedRelationRecordKey(input: InvokedRelationKeyInput): string {
    return stableDigest(`${input.turnKey}|${input.skillKey}|${input.args}`);
}

export function editedRelationRecordKey(input: EditedRelationKeyInput): string {
    return stableDigest(`${input.turnKey}|${input.fileKey}|${input.tool}`);
}

export function mentionedRelationRecordKey(input: MentionedRelationKeyInput): string {
    return stableDigest(`${input.turnKey}|${input.targetKey}|${input.source}`);
}

export function toolFileRelationRecordKey(input: ToolFileRelationKeyInput): string {
    return stableDigest(`${input.toolCallKey}|${input.fileKey}|${input.kind}`);
}

/**
 * Validate that a record key is safe to embed as a backtick-quoted SurrealDB
 * record literal (`table:\`key\``). Throws when the key contains characters
 * that would break or escape the literal: backtick, newline, or null byte.
 *
 * Call this early (on user-supplied input) to get a clear error before the
 * broken key reaches a SQL string.
 */
export function safeRecordKey(key: string): string {
    if (key.length === 0) {
        throw new Error('recordLiteral: invalid record key "" (empty key)');
    }
    for (const ch of key) {
        const code = ch.codePointAt(0)!;
        if (ch === "`" || code === 0x0a /* \n */ || code === 0x00 /* \0 */) {
            const escaped =
                ch === "`" ? "\\`" :
                code === 0x0a ? "\\n" :
                "\\0";
            throw new Error(`recordLiteral: invalid record key "${escaped}" (forbidden char)`);
        }
    }
    return key;
}

/**
 * Build a backtick-quoted SurrealDB record literal: `table:\`key\``.
 *
 * This is the canonical way to embed a known record id into a SurrealQL
 * string. The SDK's RecordId binding silently produces empty results in some
 * query contexts (see src/lib/shared/graph-query.ts:132).
 *
 * @throws {Error} when `key` contains a backtick, newline, or null byte.
 */
export function recordLiteral(table: string, key: string): string {
    safeRecordKey(key);
    return `${table}:\`${key}\``;
}
