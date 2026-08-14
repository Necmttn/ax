// packages/lib/src/stable-id.ts
/**
 * Deterministic content-hash row ids for the DuckDB cache (v2).
 *
 * CONTRACT: a row's id is a hash of its NATURAL KEY - the source file
 * identity plus provider-native ids/offsets. It is NEVER an autoincrement,
 * a run id, or a wall-clock timestamp. Re-deriving the same input therefore
 * rewrites the same ids, which is what makes the cache rebuildable and
 * makes sidecar refs (SQLite) survive a full re-derive.
 *
 * SHA-256 (not `Bun.hash`) so ids stay stable across bun versions; 128 bits
 * of it is ~2^-64 collision risk at 10^9 rows, far past ax's scale.
 */
export type NaturalKeyPart = string | number | bigint | boolean | null | undefined;

const ID_HEX_LENGTH = 32;

/** `number` and `bigint` share the same `i:` tag on purpose: `1` and `1n` are
 *  the same natural key value (a provider seq/offset arriving as either JS
 *  number or bigint should hash identically), so `stableId("t",[1]) ===
 *  stableId("t",[1n])` is INTENDED, not a bug to "fix". */
const encodePart = (part: NaturalKeyPart): string => {
    if (part === null) return "n:";
    if (part === undefined) return "u:";
    if (typeof part === "boolean") return `b:${part ? "1" : "0"}`;
    if (typeof part === "number") {
        if (!Number.isFinite(part)) throw new Error(`stableId: non-finite number part ${String(part)}`);
        return `i:${Number.isInteger(part) ? part.toFixed(0) : part.toExponential(17)}`;
    }
    if (typeof part === "bigint") return `i:${part.toString(10)}`;
    return `s:${part.length}:${part}`;
};

/** Canonical, injection-free rendering of a natural key. */
export function encodeNaturalKey(parts: readonly NaturalKeyPart[]): string {
    if (parts.length === 0) throw new Error("stableId: empty natural key");
    return parts.map(encodePart).join("|");
}

/** Hash `parts` into the row id for `table`. Table name is part of the hash, so
 *  the same natural key in two tables yields two different ids. */
export function stableId(table: string, parts: readonly NaturalKeyPart[]): string {
    if (table.length === 0) throw new Error("stableId: empty table name");
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(`${table.length}:${table}|${encodeNaturalKey(parts)}`);
    return hasher.digest("hex").slice(0, ID_HEX_LENGTH);
}

export interface SourceIdentity {
    /** Absolute path of the file the rows were parsed from. */
    readonly path: string;
    /** Content hash of that file when known; null/undefined are equivalent. */
    readonly contentHash?: string | null;
}

/** Stable identity of the file a derived row came from. */
export function sourceFileKey(src: SourceIdentity): string {
    return encodeNaturalKey([src.path, src.contentHash ?? null]);
}

export function sessionRowId(provider: string, providerSessionId: string): string {
    return stableId("session", [provider, providerSessionId]);
}

export function turnRowId(sessionId: string, seq: number): string {
    return stableId("turn", [sessionId, seq]);
}

export function toolCallRowId(sessionId: string, seq: number, callId?: string | null): string {
    return stableId("tool_call", [sessionId, seq, callId ?? null]);
}

export function agentEventRowId(agentSessionId: string, seq: number, providerEventId?: string | null): string {
    return stableId("agent_event", [agentSessionId, seq, providerEventId ?? null]);
}

/** Id for a row derived from a parsed source file (the general case). */
export function derivedRowId(
    table: string,
    src: SourceIdentity,
    parts: readonly NaturalKeyPart[],
): string {
    return stableId(table, [sourceFileKey(src), ...parts]);
}

/** Id for an edge row. `discriminator` separates parallel edges between the
 *  same pair (e.g. `invoked` args, `edited` tool name). */
export function edgeRowId(
    edgeTable: string,
    inId: string,
    outId: string,
    discriminator?: string | null,
): string {
    return stableId(edgeTable, ["in", inId, "out", outId, discriminator ?? null]);
}

/** Documentation of what each derived table hashes. Keep in sync with the
 *  helpers above; the wave-2 seam port reads this to pick the right key. */
export const NATURAL_KEY_RECIPES: Readonly<Record<string, string>> = {
    session: "provider + provider-native session id",
    turn: "session row id + provider-native turn seq",
    tool_call: "session row id + seq + provider call id (when present)",
    agent_event: "agent_session row id + seq + provider event id (when present)",
    "<edge>": "edge table + in_id + out_id + optional discriminator",
    "<derived>": "source file identity (path + content hash) + provider-native offsets",
};
