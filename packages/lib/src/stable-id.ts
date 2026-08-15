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
 * ONE CARVE-OUT: when a table's natural key IS ALREADY a single provider-native
 * stable id, the row id is that identifier VERBATIM, not a hash of it. The
 * canonical case is `session` (see `sessionRowId`): its provider uuid is the
 * value the rest of the system joins session identity on (OTLP correlation,
 * Studio deeplinks), so hashing it would break those joins. Composite keys
 * (turn = session + seq, etc.) have no single provider id and stay hashed.
 *
 * APPEND-STABILITY (P1-2): a natural key must be append-stable - re-deriving
 * after a source file grows (more lines appended to a transcript) must
 * produce IDENTICAL ids for rows that were already seen before the file
 * grew. Two key-part shapes silently break this:
 *   - a file content hash: appending a line changes the whole file's hash,
 *     so every row derived "from this file" gets a new id even though the
 *     row itself did not change.
 *   - an absolute file path: portable across machines in name only - and
 *     even on one machine, a rotated/renamed source file mints new ids for
 *     rows that are otherwise identical.
 * BOTH ARE BANNED KEY PARTS. Stable identity instead comes from
 * provider-native identifiers that do not move when a file grows: a session
 * uuid, a provider event uuid, or an explicit (sessionId, seq/offset)
 * ordinal pair. See `derivedRowId` below for the sanctioned "general case"
 * shape, and NATURAL_KEY_RECIPES for the rule stated as prose.
 *
 * SHA-256 (not `Bun.hash`) so ids stay stable across bun versions; 128 bits
 * of it is ~2^-64 collision risk at 10^9 rows, far past ax's scale.
 */
export type NaturalKeyPart = string | number | bigint | boolean | null | undefined;

const ID_HEX_LENGTH = 32;

// A number whose magnitude looks like a wall-clock epoch (ms since 1970 is
// ~1.7e12 today; even a *seconds* epoch a few centuries out never reaches
// this) is banned outright - timestamps are the classic non-append-stable
// key part smuggled in as "just a number". 10^12 is comfortably above any
// plausible offset/seq/count value ax ever hashes and comfortably below any
// real epoch-ms timestamp.
const EPOCH_LIKE_MAGNITUDE = 1e12;

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
        if (Number.isInteger(part) && !Number.isSafeInteger(part)) {
            throw new Error(
                `stableId: integer part ${part} exceeds Number.MAX_SAFE_INTEGER - two distinct 64-bit ` +
                    "source values can round to the same double and silently collide into one row id; " +
                    "pass the value as a bigint or string instead",
            );
        }
        if (Math.abs(part) > EPOCH_LIKE_MAGNITUDE) {
            throw new Error(
                `stableId: number part ${part} has a magnitude above 1e12, which is the wall-clock-epoch ` +
                    "ban: timestamps are not append-stable natural key parts (they change nothing about a " +
                    "row's identity but would mint a fresh id on every re-derive if hashed in) - pass a " +
                    "provider-native id/seq/offset instead, never a Date.now()/mtime/created-at value",
            );
        }
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

/**
 * The `session` row id is the provider-native session identifier VERBATIM - it
 * is NOT hashed. A provider's session id (a uuid for a main session, a
 * `<provider>-subagent-<hash>` id for a subagent) is already a stable, globally
 * unique natural key, and session identity is joined on that BARE value across
 * the system: OTLP correlation extracts the uuid straight out of `session.id`
 * (apps/axctl/src/otel/correlate.ts), Studio deeplinks address
 * `/sessions/<bare-session-id>`, and `ax otel` coverage matches uuid-to-uuid.
 * The earlier `stableId("session", [provider, id])` replaced the uuid with 32
 * hex chars that match no uuid, silently zeroing every one of those joins
 * (wave-0 finding P1-3). This mirrors the old SurrealDB `session:<id>` keying,
 * where the key was the raw provider session id.
 *
 * `provider` stays in the signature for call-site symmetry with the other
 * row-id helpers, but is NOT folded into the id: provider-native session ids do
 * not collide across providers (uuids are globally unique; subagent ids embed
 * the provider name), exactly as the single-namespace Surreal scheme assumed.
 *
 * Only tables whose natural key IS itself a provider-native stable id qualify
 * for verbatim ids. `turn`/`tool_call`/`agent_event` are keyed on a COMPOSITE
 * (session id + seq + ...), so they have no single provider id to be and stay
 * hashed via `stableId`.
 */
export function sessionRowId(_provider: string, providerSessionId: string): string {
    return providerSessionId;
}

export function turnRowId(sessionId: string, seq: number): string {
    return stableId("turn", [sessionId, seq]);
}

/** Disambiguates a tool_call from every other tool_call at the same
 *  (sessionId, seq). Some providers assign the same seq to more than one
 *  parallel tool call in a turn, so `seq` alone is not always unique - a
 *  caller must supply either the provider's own call id OR an explicit
 *  ordinal (e.g. its index within the seq) so two such calls never
 *  silently collapse onto one id (P3-1). There is deliberately no optional
 *  fallback: a caller that has neither must invent one before calling this. */
export type ToolCallDisambiguator = { readonly callId: string } | { readonly ordinal: number };

export function toolCallRowId(sessionId: string, seq: number, disambiguator: ToolCallDisambiguator): string {
    const tag = "callId" in disambiguator ? `call:${disambiguator.callId}` : `ord:${disambiguator.ordinal}`;
    return stableId("tool_call", [sessionId, seq, tag]);
}

export function agentEventRowId(agentSessionId: string, seq: number, providerEventId?: string | null): string {
    return stableId("agent_event", [agentSessionId, seq, providerEventId ?? null]);
}

/**
 * A git commit, keyed on `(repo, sha)` - exactly the table's own
 * `commit_sha_uq` unique index, so the row id and the natural key can never
 * disagree. Append-stable by construction: a sha is content-addressed by git and
 * `repo` is the repository's stable slug, so re-deriving a longer git history
 * rewrites every previously-seen commit to the same id.
 *
 * The commit `ts` is deliberately NOT a key part: the same commit re-read after
 * a rebase-free fetch must keep its id, and a timestamp is banned anyway (see
 * `encodePart`'s epoch-magnitude ban).
 */
export function commitRowId(repo: string, sha: string): string {
    return stableId("commit", [repo, sha]);
}

/**
 * An installed skill, keyed on its NAME alone - the table's `skill_name_uq`
 * unique index, and the value every reader joins on (`ax skills weighted`, the
 * recall skill picker, the `invoked` edge's target).
 *
 * `dir_path` is deliberately NOT a key part, on two counts: it is an absolute
 * path (a banned key part - see the module header), and the same skill
 * reinstalled under another root is the SAME catalogue entry, which is precisely
 * what a name-unique index says. The name is used verbatim as the hash input -
 * plugin-namespaced names keep their `:`, since nothing here has SurrealDB's
 * record-id character restrictions (the `:` -> `__` encoding in
 * `packages/lib/src/skill-id.ts` existed only for those).
 */
export function skillRowId(name: string): string {
    return stableId("skill", [name]);
}

/**
 * A durable role, keyed on its normalized name.
 *
 * Role rows live in the SQLite judgment sidecar, but they use the same
 * content-hash contract as cache rows. Every role writer must use this helper,
 * so `plays_role.out_id` has one stable form across user, frontmatter and brief
 * sources.
 */
export function roleRowId(name: string): string {
    return stableId("role", [name]);
}

/** The provider-native row this derived row was built from: an existing
 *  graph row's own (already provider-native, already append-stable) id -
 *  never a file identity. */
export interface DerivedFrom {
    /** Row id of the owning session (see `sessionRowId`). */
    readonly sessionId: string;
    /** Table name of the row this one was derived from, e.g. "tool_call",
     *  "compaction", "turn". */
    readonly sourceTable: string;
    /** Row id of that source row (or another provider-native identifier,
     *  e.g. a provider event uuid, when there is no source row yet). */
    readonly sourceId: string;
}

/** Id for a row derived from an existing graph row (the general case, e.g.
 *  run_evidence_event, content_document). Keyed on the owning session's row
 *  id plus the source row's table + id - both provider-native and both
 *  already append-stable by construction, so this can never regress into
 *  hashing file content or an absolute path. `parts` carries any additional
 *  discriminating natural-key fields (e.g. a `kind` string). */
export function derivedRowId(table: string, from: DerivedFrom, parts: readonly NaturalKeyPart[] = []): string {
    return stableId(table, [from.sessionId, from.sourceTable, from.sourceId, ...parts]);
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
 *  helpers above; the wave-2 seam port reads this to pick the right key.
 *
 *  RULE: a natural key must be append-stable - re-deriving after a file
 *  grows must produce identical ids for previously-seen rows; content
 *  hashes and absolute paths are banned key parts. Every table that does
 *  not yet have a concrete recipe below is tracked in RECIPE_TODO instead
 *  of silently having none. */
export const NATURAL_KEY_RECIPES: Readonly<Record<string, string>> = {
    session: "the provider-native session id VERBATIM (NOT hashed) - see sessionRowId; the one carve-out from the hash-the-natural-key rule",
    turn: "session row id + provider-native turn seq",
    tool_call: "session row id + seq + (provider call id OR an explicit ordinal) - see toolCallRowId",
    agent_event: "agent_session row id + seq + provider event id (when present)",
    commit: "repo slug + commit sha (the commit_sha_uq unique index) - see commitRowId; NEVER the commit ts",
    skill: "the skill name alone (the skill_name_uq unique index) - see skillRowId; NEVER dir_path (absolute path)",
    ingest_file_state:
        "source_kind + the watched path - see watermarkRowId (@ax/lib/duckdb/watermark). The absolute path IS the key here, the one place that is right: a watermark is a statement about one file on THIS machine, in a per-machine rebuildable cache, so it has no path-independent identity",
    invoked: "edgeRowId('invoked', turn row id, skill row id, JSON.stringify(args)) - args discriminates two invocations of the same skill in one turn",
    has_content: "edgeRowId('has_content', tool_call row id, content_type row id) - one classification per (tool_call, content_type) pair, so no discriminator",
    "<edge>": "edgeRowId: edge table + in_id + out_id + optional discriminator",
    "<derived>": "derivedRowId: owning session row id + source table + source row id + optional extra parts",
};

/**
 * The two documentation-only keys in NATURAL_KEY_RECIPES that describe a RULE
 * (`edgeRowId` / `derivedRowId`) rather than naming a table. Coverage checks must
 * not read them as "a table by that literal name has a concrete recipe". `<` and
 * `>` are not valid DuckDB identifier characters, so no parsed table name can
 * ever equal one - but the coverage test asserts that rather than assuming it.
 */
export const PSEUDO_RECIPE_KEYS: ReadonlySet<string> = new Set(["<edge>", "<derived>"]);

/**
 * THERE IS NO `RECIPE_TODO` CONSTANT ANY MORE, deliberately.
 *
 * It used to be a hand-listed set of the 134 tables with no concrete recipe yet -
 * a third mirror of the DDL's table list, alongside `duckdb-tables.ts` and the
 * parity test's banned-type array, and the one most likely to rot: a table added
 * to the DDL and forgotten here read as "covered".
 *
 * Coverage is now DERIVED where the DDL lives, in
 * `packages/schema/src/duckdb-recipe-coverage.test.ts`: the todo set is simply
 * every parsed DDL table minus the keys of `NATURAL_KEY_RECIPES` (minus
 * {@link PSEUDO_RECIPE_KEYS}). The derived set was verified byte-for-byte
 * identical to the hand-listed one it replaced.
 *
 * FOR WAVE-2 PORTERS: a table leaves the todo set by GAINING A RECIPE here -
 * add its entry to `NATURAL_KEY_RECIPES` when you wire its writer, and the
 * coverage set shrinks by itself. There is no second list to remember to edit,
 * which is the whole point.
 *
 * Keeping the derivation out of this module also keeps `@ax/lib` free of a
 * runtime dependency on `@ax/schema` (and the package cycle that came with it):
 * this module is imported by every writer, and it should not drag the entire DDL
 * text in to compute a constant only tests read.
 */
