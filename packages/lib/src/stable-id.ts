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
    "<edge>": "edgeRowId: edge table + in_id + out_id + optional discriminator",
    "<derived>": "derivedRowId: owning session row id + source table + source row id + optional extra parts",
};

/** Tables in DUCKDB_SCHEMA_TABLES (packages/schema/src/duckdb-tables.ts) that
 *  do not yet have a concrete entry in NATURAL_KEY_RECIPES. This chunk
 *  (w0-schema-ddl) only translates the DDL and the id-generation contract -
 *  it does not wire real writers for these tables, so their natural keys
 *  are not yet pinned down. Wave-2 port chunks MUST remove a table from this
 *  set (and add a concrete NATURAL_KEY_RECIPES entry) as they wire its
 *  writer; packages/schema/src/duckdb-recipe-coverage.test.ts fails the
 *  build if a table is silently missing from BOTH. */
export const RECIPE_TODO: ReadonlySet<string> = new Set([
    "skill",
    "skill_revision",
    "agent_def",
    "claude_sidecar_artifact",
    "used_sidecar_artifact",
    "agent_provider",
    "agent_model",
    "agent_session",
    "file",
    "symbol",
    "error_signature",
    "commit",
    "repository",
    "checkout",
    "workspace",
    "tool",
    "content_type",
    "has_content",
    "plan",
    "plan_item",
    "artifact",
    "content_document",
    "content_block",
    "content_atom",
    "mentions_file",
    "mentions_commit",
    "mentions_artifact",
    "plan_snapshot",
    "compaction",
    "insight",
    "friction_event",
    "turn_analysis",
    "reaction_event",
    "classifier_definition",
    "classifier_run",
    "classifier_result",
    "classifier_graph_node",
    "classifier_graph_edge",
    "classifier_graph_fact",
    "transcript_label_review",
    "transcript_label_vector",
    "semantic_signal",
    "diagnostic_event",
    "guidance",
    "guidance_version",
    "guidance_source",
    "guidance_revision",
    "guidance_config_artifact",
    "stack",
    "command_outcome",
    "user_message_ngram",
    "workflow_epoch",
    "session_token_usage",
    "turn_token_usage",
    "session_health",
    "session_metrics",
    "fragility_cascade",
    "commit_classification",
    "branch",
    "pull_request",
    "review_event",
    "check_run",
    "delivery_outcome",
    "workflow_snapshot",
    "phase_span",
    "skill_candidate",
    "ingest_run",
    "ingest_stage",
    "ingest_event",
    "query_sample",
    "graph_health_check",
    "role",
    "plays_role",
    "invoked",
    "loaded",
    "proposed",
    "edited",
    "mentioned_file",
    "mentioned_symbol",
    "mentioned_error",
    "read_file",
    "searched_file",
    "corrected_by",
    "expresses",
    "reacts_to",
    "has_classification",
    "produced",
    "touched",
    "later_fixed_by",
    "suggests_skill",
    "has_checkout",
    "concerns",
    "resulted_in",
    "produced_artifact",
    "has_artifact",
    "derived_from",
    "skill_paired",
    "recovered_by",
    "spawned",
    "advice",
    "agent_event_child",
    "used_model",
    "agent_used_model",
    "skill_triage_decision",
    "harness_hook_event",
    "hook_command_invocation",
    "ax_invocation",
    "feedback_case_type",
    "feedback_case_result",
    "hook_fire",
    "proposal",
    "directive_ngram",
    "skill_proposal",
    "subagent_proposal",
    "hook_proposal",
    "guidance_proposal",
    "automation_proposal",
    "cites_evidence",
    "experiment",
    "opportunity",
    "checkpoint",
    "dogfood_run",
    "retro",
    "reviewed",
    "ingest_file_state",
    "otel_metric_point",
    "otel_span",
    "otel_log_event",
    "harness_tool_event",
    "harness_run_context",
    "wrapped_card",
    "telemetry_of",
    "run_evidence_event",
    "run_evidence_ref",
]);
