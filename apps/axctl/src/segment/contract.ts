// apps/axctl/src/segment/contract.ts
/**
 * The segment contract (#902, Phase 4 piece 2): which tables a session-scoped
 * segment carries, which columns of each ride, and the manifest that binds an
 * exported directory together.
 *
 * A segment is "session-scoped EVENT rows, minus machine-local enrichment":
 * - Only `layer: "event"` tables ride (pinned by contract.test.ts against
 *   `DUCKDB_TABLE_LAYERS`). Derived tables re-derive on the importing machine;
 *   bookkeeping is per-store.
 * - Dimension/catalog tables (skill, tool, file, commit, repository, checkout,
 *   agent_model, ...) do NOT ride: they are per-machine installs with
 *   write-stamped columns, so re-importing them is never idempotent. Imported
 *   edges into absent dimensions dangle by design - skill ids are stable
 *   name-derived, so they knit once the target installs the skill, and the
 *   deref-free queries already tolerate a dangling edge.
 * - `ENRICHMENT_COLUMNS` are EXCLUDED from the projection (not nulled): the
 *   import loader's ON CONFLICT updates exactly the exported column set, so a
 *   column that never rides can never clobber the importer's own enrichment.
 * - Cost columns on the usage tables ride as-is: they were priced by the
 *   EXPORTING machine's catalog. Accepted divergence, same as local history
 *   priced before a catalog update; `notes.cost_columns` says so.
 */
import { Schema } from "effect";
import { ENRICHMENT_COLUMNS } from "@ax/schema/duckdb-tables";
import { DUCKDB_SCHEMA_SQL, parseDuckdbColumnDefs, type DuckdbColumnDef } from "@ax/schema/duckdb-ddl";

export const SEGMENT_VERSION = 1;

/** Marker file written FIRST (it creates the directory); `manifest.json` is
 *  written LAST, so a marker without a manifest is an aborted export. */
export const SEGMENT_MARKER_FILE = ".ax-segment";
export const SEGMENT_MANIFEST_FILE = "manifest.json";

/** `__SCOPE__` in a predicate is replaced with the quoted session-id list. */
export interface SegmentTableSpec {
    readonly table: string;
    /** SQL boolean scoping this table's rows to the session set. */
    readonly predicate: string;
}

/**
 * Every session-scoped event table, with the predicate that ties its rows to a
 * session set. Order matters loosely on import (parents before children is
 * nice for reading, though nothing enforces FKs).
 *
 * `concerns` has polymorphic endpoints (`in_table`/`out_table`); the predicate
 * covers the endpoint kinds parsers actually write (tool_call/turn/session).
 * An endpoint kind outside that set under-matches - rows are LEFT OUT of the
 * segment, never wrongly included.
 */
export const SEGMENT_TABLES: readonly SegmentTableSpec[] = [
    { table: "session", predicate: "id IN (__SCOPE__)" },
    { table: "agent_session", predicate: "ax_session IN (__SCOPE__)" },
    { table: "agent_event", predicate: "ax_session IN (__SCOPE__)" },
    {
        table: "agent_event_child",
        predicate: "agent_session IN (SELECT id FROM agent_session WHERE ax_session IN (__SCOPE__))",
    },
    { table: "turn", predicate: "session IN (__SCOPE__)" },
    { table: "tool_call", predicate: "session IN (__SCOPE__)" },
    { table: "edited", predicate: "in_id IN (SELECT id FROM turn WHERE session IN (__SCOPE__))" },
    { table: "read_file", predicate: "in_id IN (SELECT id FROM tool_call WHERE session IN (__SCOPE__))" },
    { table: "searched_file", predicate: "in_id IN (SELECT id FROM tool_call WHERE session IN (__SCOPE__))" },
    { table: "invoked", predicate: "session IN (__SCOPE__)" },
    {
        table: "concerns",
        predicate:
            "((in_table = 'session' AND in_id IN (__SCOPE__))" +
            " OR (in_table = 'turn' AND in_id IN (SELECT id FROM turn WHERE session IN (__SCOPE__)))" +
            " OR (in_table = 'tool_call' AND in_id IN (SELECT id FROM tool_call WHERE session IN (__SCOPE__))))",
    },
    { table: "session_token_usage", predicate: "session IN (__SCOPE__)" },
    { table: "turn_token_usage", predicate: "session IN (__SCOPE__)" },
    { table: "compaction", predicate: "session IN (__SCOPE__)" },
    { table: "plan", predicate: "session IN (__SCOPE__)" },
    { table: "plan_snapshot", predicate: "session IN (__SCOPE__)" },
    { table: "plan_item", predicate: "plan IN (SELECT id FROM plan WHERE session IN (__SCOPE__))" },
    { table: "harness_hook_event", predicate: "session IN (__SCOPE__)" },
    { table: "hook_command_invocation", predicate: "session IN (__SCOPE__)" },
    { table: "claude_sidecar_artifact", predicate: "session IN (__SCOPE__)" },
    { table: "used_sidecar_artifact", predicate: "session IN (__SCOPE__)" },
    { table: "spawned", predicate: "(in_id IN (__SCOPE__) OR out_id IN (__SCOPE__))" },
];

/** The columns of `table` that ride in a segment: DDL order, minus the
 *  machine-local enrichment set. */
export const segmentExportColumns = (table: string): readonly string[] => {
    const strip = new Set(ENRICHMENT_COLUMNS[table] ?? []);
    return parseDuckdbColumnDefs(table)
        .map((col) => col.name)
        .filter((name) => !strip.has(name));
};

/** Local DDL defs by column name, for the import-side intersection loader. */
export const localColumnDefs = (table: string): ReadonlyMap<string, DuckdbColumnDef> =>
    new Map(parseDuckdbColumnDefs(table).map((col) => [col.name, col]));

/** SHA-256 (hex) of the local DDL text. A mismatch on import means the two
 *  machines run different schema versions - allowed only under `--yes`. */
export const ddlHash = (): string => {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(DUCKDB_SCHEMA_SQL);
    return hasher.digest("hex");
};

/** Quote a session id for an IN (...) literal list. Ids are internal, but a
 *  quote in one must corrupt nothing. */
export const quoteScopeId = (id: string): string => `'${id.replace(/'/g, "''")}'`;

export const withScope = (predicate: string, scopeIds: readonly string[]): string =>
    predicate.replaceAll("__SCOPE__", scopeIds.map(quoteScopeId).join(", "));

export const SegmentTableEntry = Schema.Struct({
    table: Schema.String,
    rows: Schema.Number,
    sha256: Schema.String,
    columns: Schema.Array(Schema.String),
});

export const SegmentSourceFile = Schema.Struct({
    source_kind: Schema.String,
    sha: Schema.String,
    size: Schema.NullOr(Schema.Number),
});

export const SegmentManifest = Schema.Struct({
    segment_version: Schema.Number,
    created_at: Schema.String,
    ax_version: Schema.String,
    ddl_hash: Schema.String,
    scope: Schema.Struct({
        kind: Schema.Literals(["sessions", "since"]),
        sessions: Schema.Array(Schema.String),
        since_days: Schema.NullOr(Schema.Number),
    }),
    tables: Schema.Array(SegmentTableEntry),
    /** Content hashes of the transcript files behind the exported sessions -
     *  the slice-2 watermark handshake: the importer writes
     *  `__imported__/<kind>/<sha>` marks so the target's next ingest
     *  refresh-skips those bytes instead of reparsing them. */
    source_files: Schema.Array(SegmentSourceFile),
    notes: Schema.Struct({
        cost_columns: Schema.String,
        enrichment_stripped: Schema.Boolean,
    }),
});

export type SegmentManifestT = typeof SegmentManifest.Type;
export type SegmentTableEntryT = typeof SegmentTableEntry.Type;
export type SegmentSourceFileT = typeof SegmentSourceFile.Type;
