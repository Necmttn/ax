// packages/schema/src/sidecar-tables.ts
/**
 * Manifest of every table in schema.sidecar.sql - the SQLite judgment sidecar.
 *
 * The set below is the SINGLE SOURCE OF TRUTH for "what is judgment". It has two
 * jobs, and the second is the load-bearing one:
 *
 *  1. It says what the sidecar owns, so nothing widens the boundary by accident
 *     (`feedback_case_*` and `opportunity` are decision-SHAPED and still
 *     re-derivable, so they stay in the cache - see schema.sidecar.sql's header).
 *  2. It says what the CACHE must NOT define. A table defined in BOTH
 *     schema.duckdb.sql and schema.sidecar.sql would give a reader two homes and
 *     one of them empty, and an empty table answers a query with zero rows rather
 *     than an error - the silent wrong answer the v2 no-fallback rule exists to
 *     prevent. `duckdb-schema.test.ts` asserts the cache DDL defines none of
 *     these; `sidecar-schema.test.ts` asserts the sidecar DDL defines all of them
 *     and nothing else.
 *
 * `session_label` is here and was never a table in v1: the wave-3 backlog calls
 * these "spar labels", and they were VALUES stamped into `session.labels`, a
 * column on the rebuildable `session` row. See that table's comment in the DDL.
 */
import { parseSqliteTables, SIDECAR_SCHEMA_SQL } from "./sidecar-ddl.ts";

export interface SidecarTableSpec {
    readonly table: string;
    readonly kind: "node" | "edge";
    readonly note: string;
}

/** Table names parsed out of schema.sidecar.sql. */
export const SIDECAR_TABLE_NAMES: ReadonlySet<string> = new Set(parseSqliteTables(SIDECAR_SCHEMA_SQL));

/**
 * Durable judgment tables: user/agent DECISIONS that cannot be re-derived from
 * transcripts, git, skills or the OTLP spool, so a cache rebuild must not drop
 * them. Enumerated explicitly rather than derived from the DDL, so ADDING a table
 * to schema.sidecar.sql is a deliberate widening of the boundary that has to be
 * written down in two places instead of one.
 */
export const SIDECAR_JUDGMENT_TABLES: ReadonlySet<string> = new Set([
    "proposal",
    "skill_proposal",
    "subagent_proposal",
    "hook_proposal",
    "guidance_proposal",
    "automation_proposal",
    "experiment",
    "checkpoint",
    "role",
    "plays_role",
    "retro",
    "skill_triage_decision",
    "transcript_label_review",
    "dogfood_run",
    "session_label",
]);

/** Hand-authored editorial metadata, keyed by table name - content the DDL does
 *  not carry. The manifest below is DERIVED from the parsed DDL, so an entry for
 *  a table the DDL dropped (or a table with no entry) throws at import. */
const TABLE_METADATA: Readonly<Record<string, Omit<SidecarTableSpec, "table">>> = {
    proposal: { kind: "node", note: "Polymorphic shortlist of repeated workflow improvement candidates." },
    skill_proposal: { kind: "node", note: "Typed payload rows for skill-form proposals." },
    subagent_proposal: { kind: "node", note: "Typed payload rows for subagent-form proposals." },
    hook_proposal: { kind: "node", note: "Typed payload rows for hook-form proposals." },
    guidance_proposal: { kind: "node", note: "Typed payload rows for guidance-file proposals." },
    automation_proposal: { kind: "node", note: "Typed payload rows for automation-form proposals." },
    experiment: { kind: "node", note: "Accepted proposals and their scaffold/verdict state." },
    checkpoint: { kind: "node", note: "Experiment measurement snapshots and the human-confirmed verdict." },
    role: { kind: "node", note: "Skill role labels and their user-tuned weights." },
    plays_role: { kind: "edge", note: "Skill-to-role classification edges (in_id = cache skill id)." },
    retro: { kind: "node", note: "Structured session retrospectives (tried/worked/failed/next)." },
    skill_triage_decision: { kind: "node", note: "Keep/archive/review decisions per skill NAME." },
    transcript_label_review: { kind: "node", note: "Human/agent review verdicts for mined transcript label candidates." },
    dogfood_run: { kind: "node", note: "Terminal dogfood scenario results." },
    session_label: { kind: "node", note: "Labels stamped on a cache session (spar), durable across re-derive." },
};

function buildManifest(): readonly SidecarTableSpec[] {
    const missingMetadata = [...SIDECAR_TABLE_NAMES].filter((table) => !(table in TABLE_METADATA));
    if (missingMetadata.length > 0) {
        throw new Error(
            `sidecar-tables.ts: DDL table(s) with no TABLE_METADATA entry: ${missingMetadata.join(", ")}. ` +
                "Add a { kind, note } entry for each before the manifest can build.",
        );
    }
    const staleMetadata = Object.keys(TABLE_METADATA).filter((table) => !SIDECAR_TABLE_NAMES.has(table));
    if (staleMetadata.length > 0) {
        throw new Error(
            `sidecar-tables.ts: TABLE_METADATA entry for table(s) no longer in the DDL: ${staleMetadata.join(", ")}. ` +
                "Remove the stale entry (or the table was renamed and the entry needs the new name).",
        );
    }
    return [...SIDECAR_TABLE_NAMES].map((table) => ({ table, ...TABLE_METADATA[table]! }));
}

export const SIDECAR_SCHEMA_TABLES: readonly SidecarTableSpec[] = buildManifest();
