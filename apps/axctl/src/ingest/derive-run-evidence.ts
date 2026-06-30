/**
 * @stage derive-run-evidence
 * @rationale Populate the run-evidence ledger (#578) by normalizing structural
 *   rows already in the graph into `run_evidence_event` rows. This first slice
 *   covers the four UNAMBIGUOUS, provider-agnostic sources whose `backing` is
 *   structurally determined (no NLP, no trust guesses):
 *
 *     tool_call       -> tool_observation  (tool_backed)
 *     command_outcome -> verification      (verifier_backed)
 *     compaction      -> boundary          (derived)
 *     plan_snapshot   -> task_state        (tool_backed)
 *
 *   `backing` is DERIVED from the source table, never a producer trust label,
 *   and there is no promotion between classes. Kinds that need turn-text NLP,
 *   hook data, or git state (objective, claim, policy_decision, artifact_ref,
 *   repo_state, derived_summary) and all `run_evidence_ref` rows are deferred to
 *   later slices - see {@link RUN_EVIDENCE_DERIVED_KINDS} for the covered set.
 * @inputs `session` (id, source), `tool_call`, `command_outcome`, `compaction`,
 *   `plan_snapshot` rows (deref-free projections).
 * @outputs `run_evidence_event` rows (idempotent UPSERT, keyed by
 *   session+source_table+source_id) + `run_evidence_ref` file refs off each
 *   tool_observation event, from `read_file`/`searched_file` edges (path HASHED,
 *   privacy `ref_only`). `edited` (turn->file) is deferred - it has no
 *   tool_observation event to anchor to.
 * @order after the provider stages + outcomes (which writes command_outcome).
 */

import { Effect, Schema } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { stableDigest } from "@ax/lib/ids";
import { executeStatementsWith } from "@ax/lib/shared/surreal";
import {
    buildRunEvidenceStatements,
    runEvidenceEventRecordKey,
    type RunEvidenceEventWrite,
    type RunEvidenceKind,
    type RunEvidenceRefWrite,
} from "@ax/lib/shared/run-evidence";
import {
    BaseStageStats,
    IngestContext,
    sinceAndClause,
    sinceDaysFromCtx,
    StageMeta,
} from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

/** The evidence kinds this stage derives today (honest capability surface). */
export const RUN_EVIDENCE_DERIVED_KINDS = [
    "tool_observation",
    "verification",
    "boundary",
    "task_state",
] as const satisfies readonly RunEvidenceKind[];

// ---------------------------------------------------------------------------
// Deref-free row shapes (record links projected to bare keys via record::id).
// ---------------------------------------------------------------------------

interface ToolCallRow {
    readonly id: string;
    readonly session: string | null;
    readonly ts: string;
    readonly name?: string | null;
    readonly hasError?: boolean | null;
    readonly commandNorm?: string | null;
}

interface CommandOutcomeRow {
    readonly id: string;
    readonly session: string | null;
    readonly toolCall?: string | null;
    readonly ts: string;
    readonly kind?: string | null;
    readonly status?: string | null;
    readonly commandNorm?: string | null;
}

interface CompactionRow {
    readonly id: string;
    readonly session: string | null;
    readonly ts: string;
    readonly trigger?: string | null;
    readonly strategy?: string | null;
    readonly tokensBefore?: number | null;
}

interface PlanSnapshotRow {
    readonly id: string;
    readonly session: string | null;
    readonly ts: string;
    readonly summary?: string | null;
}

/**
 * A `read_file` / `searched_file` edge row (both are RELATION FROM tool_call TO
 * file, so they anchor cleanly to the tool_call's tool_observation event).
 * `edited` is RELATION FROM turn TO file - turn-grain, no matching event - so it
 * is intentionally NOT a ref source here (deferred; needs a turn->event bridge).
 */
interface FileEvidenceRow {
    /** tool_call key (edge `in`). */
    readonly toolCall: string | null;
    /** file key (edge `out`). */
    readonly file: string | null;
    /** session of the tool_call (single-hop deref `in.session`). */
    readonly session: string | null;
    readonly ts: string;
    readonly pathSeen?: string | null;
    /** "read" | "search" - which access edge produced this ref. */
    readonly access: string;
}

/** All source rows for one derivation pass + the session->provider lookup. */
export interface RunEvidenceSourceRows {
    readonly toolCalls: readonly ToolCallRow[];
    readonly commandOutcomes: readonly CommandOutcomeRow[];
    readonly compactions: readonly CompactionRow[];
    readonly planSnapshots: readonly PlanSnapshotRow[];
    readonly fileEvidence: readonly FileEvidenceRow[];
    readonly sessionProvider: ReadonlyMap<string, string>;
}

// ---------------------------------------------------------------------------
// Pure mappers (one per source). Return null when a row has no session - an
// evidence event must anchor to a run. backing is fixed per source table.
// ---------------------------------------------------------------------------

const dropUndefined = (o: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
        if (v !== undefined && v !== null) out[k] = v;
    }
    return out;
};

const providerOf = (rows: RunEvidenceSourceRows, sessionId: string): string =>
    rows.sessionProvider.get(sessionId) ?? "unknown";

const toToolObservation = (row: ToolCallRow, provider: string): RunEvidenceEventWrite | null => {
    if (!row.session) return null;
    return {
        sessionId: row.session,
        ts: row.ts,
        provider,
        kind: "tool_observation",
        backing: "tool_backed",
        sourceTable: "tool_call",
        sourceId: row.id,
        toolCallKey: row.id,
        summary: row.name ?? null,
        attrs: dropUndefined({
            tool: row.name ?? undefined,
            has_error: row.hasError ?? false,
            command_norm: row.commandNorm ?? undefined,
        }),
    };
};

const toVerification = (row: CommandOutcomeRow, provider: string): RunEvidenceEventWrite | null => {
    if (!row.session) return null;
    return {
        sessionId: row.session,
        ts: row.ts,
        provider,
        kind: "verification",
        backing: "verifier_backed",
        sourceTable: "command_outcome",
        sourceId: row.id,
        commandOutcomeKey: row.id,
        toolCallKey: row.toolCall ?? null,
        summary: `${row.kind ?? "outcome"}: ${row.status ?? "?"}`,
        attrs: dropUndefined({
            kind: row.kind ?? undefined,
            status: row.status ?? undefined,
            command_norm: row.commandNorm ?? undefined,
        }),
    };
};

const toBoundary = (row: CompactionRow, provider: string): RunEvidenceEventWrite | null => {
    if (!row.session) return null;
    return {
        sessionId: row.session,
        ts: row.ts,
        provider,
        kind: "boundary",
        // A compaction is a system-recorded lifecycle boundary, not a tool
        // result or a verifier outcome - so it is `derived`, not tool_backed.
        backing: "derived",
        sourceTable: "compaction",
        sourceId: row.id,
        compactionKey: row.id,
        summary: `compaction (${row.strategy ?? "?"}${row.trigger ? `, ${row.trigger}` : ""})`,
        attrs: dropUndefined({
            trigger: row.trigger ?? undefined,
            strategy: row.strategy ?? undefined,
            tokens_before: row.tokensBefore ?? undefined,
        }),
    };
};

const toTaskState = (row: PlanSnapshotRow, provider: string): RunEvidenceEventWrite | null => {
    if (!row.session) return null;
    return {
        sessionId: row.session,
        ts: row.ts,
        provider,
        kind: "task_state",
        // Plan/todo snapshots are emitted by a tool (TodoWrite / update_plan).
        backing: "tool_backed",
        sourceTable: "plan_snapshot",
        sourceId: row.id,
        planSnapshotKey: row.id,
        summary: row.summary ?? null,
    };
};

/** Map all source rows into evidence events (pure; null rows dropped). */
export const buildRunEvidenceEvents = (rows: RunEvidenceSourceRows): RunEvidenceEventWrite[] => {
    const events: RunEvidenceEventWrite[] = [];
    const push = (e: RunEvidenceEventWrite | null) => {
        if (e) events.push(e);
    };
    for (const r of rows.toolCalls) push(toToolObservation(r, r.session ? providerOf(rows, r.session) : "unknown"));
    for (const r of rows.commandOutcomes) push(toVerification(r, r.session ? providerOf(rows, r.session) : "unknown"));
    for (const r of rows.compactions) push(toBoundary(r, r.session ? providerOf(rows, r.session) : "unknown"));
    for (const r of rows.planSnapshots) push(toTaskState(r, r.session ? providerOf(rows, r.session) : "unknown"));
    return events;
};

/**
 * A file-evidence edge -> a `run_evidence_ref` off the tool_call's
 * tool_observation event. The path is HASHED, never stored raw (privacy:
 * `ref_only` + path_hash); the structural pointer is `file:<id>`.
 */
const toFileRef = (row: FileEvidenceRow): RunEvidenceRefWrite | null => {
    if (!row.session || !row.toolCall || !row.file) return null;
    return {
        eventKey: runEvidenceEventRecordKey({
            sessionId: row.session,
            sourceTable: "tool_call",
            sourceId: row.toolCall,
        }),
        sessionId: row.session,
        ts: row.ts,
        refKind: "file",
        targetTable: "file",
        targetId: row.file,
        pathHash: row.pathSeen ? stableDigest(row.pathSeen) : null,
        privacyLevel: "ref_only",
        attrs: { access: row.access },
    };
};

/** Map file-evidence edges into run_evidence_ref rows (pure; null rows dropped). */
export const buildRunEvidenceRefs = (rows: RunEvidenceSourceRows): RunEvidenceRefWrite[] => {
    const refs: RunEvidenceRefWrite[] = [];
    for (const r of rows.fileEvidence) {
        const ref = toFileRef(r);
        if (ref) refs.push(ref);
    }
    return refs;
};

// ---------------------------------------------------------------------------
// Stage (thin DB layer: fetch deref-free, map pure, write idempotent).
// ---------------------------------------------------------------------------

const SESSION_PROVIDER_SQL = `SELECT record::id(id) AS id, source FROM session;`;

const toolCallSql = (since: number | undefined): string =>
    `SELECT record::id(id) AS id, record::id(session) AS session, type::string(ts) AS ts,
            name, has_error AS hasError, command_norm AS commandNorm
     FROM tool_call WHERE session != NONE ${sinceAndClause(since)};`;

const commandOutcomeSql = (since: number | undefined): string =>
    `SELECT record::id(id) AS id, record::id(session) AS session, record::id(tool_call) AS toolCall,
            type::string(ts) AS ts, kind, status, command_norm AS commandNorm
     FROM command_outcome WHERE session != NONE ${sinceAndClause(since)};`;

const compactionSql = (since: number | undefined): string =>
    `SELECT record::id(id) AS id, record::id(session) AS session, type::string(ts) AS ts,
            trigger, strategy, tokens_before AS tokensBefore
     FROM compaction WHERE session != NONE ${sinceAndClause(since)};`;

const planSnapshotSql = (since: number | undefined): string =>
    `SELECT record::id(id) AS id, record::id(session) AS session, type::string(ts) AS ts, summary
     FROM plan_snapshot WHERE session != NONE ${sinceAndClause(since)};`;

// read_file / searched_file are RELATION FROM tool_call TO file; `in.session` is
// a single-hop deref to anchor the ref's session. `edited` (turn->file) is
// intentionally excluded (turn grain, no tool_observation event to attach to).
const fileEvidenceSql = (edge: "read_file" | "searched_file", access: string, since: number | undefined): string =>
    `SELECT record::id(in) AS toolCall, record::id(out) AS file, record::id(in.session) AS session,
            type::string(ts) AS ts, path_seen AS pathSeen, '${access}' AS access
     FROM ${edge} WHERE ts != NONE ${sinceAndClause(since)};`;

export interface DeriveRunEvidenceStats {
    readonly written: number;
    readonly refsWritten: number;
}

export const deriveRunEvidence = (sinceDays?: number): Effect.Effect<
    DeriveRunEvidenceStats,
    DbError,
    SurrealClient
> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;

        const [providers] = yield* db.query<[Array<{ id: string; source?: string | null }>]>(SESSION_PROVIDER_SQL);
        const sessionProvider = new Map<string, string>();
        for (const p of providers ?? []) {
            if (p.id) sessionProvider.set(p.id, p.source ?? "unknown");
        }

        const [toolCalls] = yield* db.query<[Array<ToolCallRow>]>(toolCallSql(sinceDays));
        const [commandOutcomes] = yield* db.query<[Array<CommandOutcomeRow>]>(commandOutcomeSql(sinceDays));
        const [compactions] = yield* db.query<[Array<CompactionRow>]>(compactionSql(sinceDays));
        const [planSnapshots] = yield* db.query<[Array<PlanSnapshotRow>]>(planSnapshotSql(sinceDays));
        const [reads] = yield* db.query<[Array<FileEvidenceRow>]>(fileEvidenceSql("read_file", "read", sinceDays));
        const [searches] = yield* db.query<[Array<FileEvidenceRow>]>(fileEvidenceSql("searched_file", "search", sinceDays));

        const rows: RunEvidenceSourceRows = {
            toolCalls: toolCalls ?? [],
            commandOutcomes: commandOutcomes ?? [],
            compactions: compactions ?? [],
            planSnapshots: planSnapshots ?? [],
            fileEvidence: [...(reads ?? []), ...(searches ?? [])],
            sessionProvider,
        };
        const events = buildRunEvidenceEvents(rows);
        const refs = buildRunEvidenceRefs(rows);

        const stmts = buildRunEvidenceStatements({ events, refs });
        yield* executeStatementsWith(db, stmts, { chunkSize: 250, label: "runEvidence" });
        return { written: events.length, refsWritten: refs.length } satisfies DeriveRunEvidenceStats;
    });

export class RunEvidenceStats extends BaseStageStats.extend<RunEvidenceStats>("RunEvidenceStats")({
    written: Schema.Number,
    refsWritten: Schema.Number,
}) {}

/**
 * Run-evidence stage - normalizes structural graph rows into the
 * `run_evidence_event` ledger (#578). Incremental by the ingest since-window;
 * idempotent UPSERTs keyed by (session, source_table, source_id). Tags: derive.
 */
export const runEvidenceStage: StageDef<RunEvidenceStats, SurrealClient> = {
    meta: StageMeta.make({
        key: "run-evidence",
        deps: ["claude", "codex", "pi", "omp", "opencode", "cursor", "outcomes"],
        tags: ["derive"],
    }),
    run: (ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const result = yield* deriveRunEvidence(sinceDaysFromCtx(ctx));
            return RunEvidenceStats.make({
                durationMs: Date.now() - t0,
                summary: `derived ${result.written} run-evidence events, ${result.refsWritten} refs`,
                written: result.written,
                refsWritten: result.refsWritten,
            });
        }),
};
