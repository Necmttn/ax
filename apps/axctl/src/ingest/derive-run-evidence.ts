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
import { EDIT_TOOL_NAMES } from "@ax/lib/shared/tool-classes";
import { executeStatementsWith } from "@ax/lib/shared/surreal";
import { checkFamilyFromCommand } from "./check-family.ts";
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
    "objective",
    "policy_decision",
    "repo_state",
    "derived_summary",
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
    /** present-only -> a `derived_summary` event is also emitted off this row. */
    readonly summary?: string | null;
}

/** Earliest `task` user turn per session -> the run's objective. */
interface ObjectiveRow {
    readonly id: string;
    readonly session: string | null;
    readonly ts: string;
    readonly seq?: number | null;
    readonly textExcerpt?: string | null;
}

/** A `hook_command_invocation` row with a non-trivial `effect`. */
interface PolicyDecisionRow {
    readonly id: string;
    readonly session: string | null;
    readonly toolCall?: string | null;
    readonly ts: string;
    readonly hookName?: string | null;
    readonly effect?: string | null;
    readonly providerStatus?: string | null;
}

/** A session's checkout -> its repo identity (branch/head). dirty is NOT read
 *  (the git ingest writes it always-false, #578 review). */
interface RepoStateRow {
    readonly session: string | null;
    readonly checkout: string | null;
    readonly ts: string;
    readonly branch?: string | null;
    readonly headSha?: string | null;
    readonly repository?: string | null;
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

/**
 * An `edited` edge row (RELATION FROM turn TO file). Turn-grain, so it is bridged
 * to the turn's edit tool_call (and thus its tool_observation event) only when
 * that turn has EXACTLY ONE edit tool_call - ambiguous multi-edit turns are
 * skipped rather than mis-attributed (#578 slice 5).
 */
interface EditedRow {
    /** turn key (edge `in`). */
    readonly turn: string | null;
    /** file key (edge `out`). */
    readonly file: string | null;
    /** session of the turn (single-hop deref `in.session`). */
    readonly session: string | null;
    readonly ts: string;
    readonly pathSeen?: string | null;
    /** the edit tool that fired (Edit|Write|NotebookEdit). */
    readonly tool?: string | null;
}

/** Parent + root ancestor for a session (from the `spawned` edge). */
export interface SessionLineage {
    readonly parent: string | null;
    readonly root: string | null;
}

/** All source rows for one derivation pass + the session->provider lookup. */
export interface RunEvidenceSourceRows {
    readonly toolCalls: readonly ToolCallRow[];
    readonly commandOutcomes: readonly CommandOutcomeRow[];
    readonly compactions: readonly CompactionRow[];
    readonly planSnapshots: readonly PlanSnapshotRow[];
    readonly fileEvidence: readonly FileEvidenceRow[];
    readonly edited: readonly EditedRow[];
    readonly objectives: readonly ObjectiveRow[];
    readonly policyDecisions: readonly PolicyDecisionRow[];
    readonly repoStates: readonly RepoStateRow[];
    /** turn key -> edit tool_call keys in that turn (for the `edited` bridge). */
    readonly turnEditCalls: ReadonlyMap<string, readonly string[]>;
    /** session key -> parent/root ancestor (from `spawned`); stamped on events. */
    readonly lineage: ReadonlyMap<string, SessionLineage>;
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
    // command_outcome is written for EVERY tool_call - `classifyCommandOutcome`
    // returns "success" for any non-error row - so without this filter a plain
    // `Read`/`ls` succeeding would become verifier_backed evidence, violating the
    // no-promotion rule. A `verification` is ONLY a genuine check (test / build /
    // lint / typecheck), identified by the command's check family (#578 review).
    const family = checkFamilyFromCommand(row.commandNorm ?? null);
    if (family === null) return null;
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
        summary: `${family}: ${row.status ?? "?"}`,
        attrs: dropUndefined({
            family,
            kind: row.kind ?? undefined,
            status: row.status ?? undefined,
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

// The run's stated goal: the earliest `task` user turn (selection, not NLP).
const toObjective = (row: ObjectiveRow, provider: string): RunEvidenceEventWrite | null => {
    if (!row.session) return null;
    return {
        sessionId: row.session,
        ts: row.ts,
        provider,
        kind: "objective",
        backing: "derived",
        sourceTable: "turn",
        sourceId: row.id,
        turnKey: row.id,
        summary: row.textExcerpt ?? null,
    };
};

// A hook decision (block / inject / modify / notify). The verdict is policy.
const toPolicyDecision = (row: PolicyDecisionRow, provider: string): RunEvidenceEventWrite | null => {
    if (!row.session) return null;
    return {
        sessionId: row.session,
        ts: row.ts,
        provider,
        kind: "policy_decision",
        backing: "policy_backed",
        sourceTable: "hook_command_invocation",
        sourceId: row.id,
        hookInvocationKey: row.id,
        toolCallKey: row.toolCall ?? null,
        summary: `${row.hookName ?? "hook"}: ${row.effect ?? "?"}`,
        // Effect/status only - stdout/stderr/content excerpts stay on the hook
        // row (privacy; do not duplicate them into the ledger, #578 review).
        attrs: dropUndefined({
            effect: row.effect ?? undefined,
            hook_name: row.hookName ?? undefined,
            provider_status: row.providerStatus ?? undefined,
        }),
    };
};

// The repo a run worked in (from session.checkout). dirty is NOT reported - the
// git ingest writes checkout.dirty always-false (#578 review).
const toRepoState = (row: RepoStateRow, provider: string): RunEvidenceEventWrite | null => {
    if (!row.session || !row.checkout) return null;
    const sha7 = row.headSha ? row.headSha.slice(0, 7) : null;
    const summary = `${row.repository ?? "repo"}${row.branch ? ` @ ${row.branch}` : ""}${sha7 ? ` · ${sha7}` : ""}`;
    return {
        sessionId: row.session,
        ts: row.ts,
        provider,
        kind: "repo_state",
        backing: "derived",
        sourceTable: "checkout",
        sourceId: row.checkout,
        checkoutKey: row.checkout,
        summary,
        attrs: dropUndefined({
            repository: row.repository ?? undefined,
            branch: row.branch ?? undefined,
            head_sha: row.headSha ?? undefined,
        }),
    };
};

// A compaction's summary TEXT, as a distinct event from the boundary marker.
// Keyed by source_table "compaction_summary" so it does not collide with the
// boundary event off the same compaction row (#578 review - cleaner than a
// `#summary` source_id suffix).
const toDerivedSummary = (row: CompactionRow, provider: string): RunEvidenceEventWrite | null => {
    if (!row.session || !row.summary) return null;
    return {
        sessionId: row.session,
        ts: row.ts,
        provider,
        kind: "derived_summary",
        backing: "derived",
        sourceTable: "compaction_summary",
        sourceId: row.id,
        compactionKey: row.id,
        summary: row.summary,
    };
};

/** Map all source rows into evidence events (pure; null rows dropped). Each
 *  event is then stamped with its session's parent/root ancestry (from
 *  `spawned`) so the ledger supports run->child->tool->evidence traversal. */
export const buildRunEvidenceEvents = (rows: RunEvidenceSourceRows): RunEvidenceEventWrite[] => {
    const events: RunEvidenceEventWrite[] = [];
    const push = (e: RunEvidenceEventWrite | null) => {
        if (e) events.push(e);
    };
    const p = (s: string | null) => (s ? providerOf(rows, s) : "unknown");
    for (const r of rows.toolCalls) push(toToolObservation(r, p(r.session)));
    for (const r of rows.commandOutcomes) push(toVerification(r, p(r.session)));
    for (const r of rows.compactions) push(toBoundary(r, p(r.session)));
    for (const r of rows.compactions) push(toDerivedSummary(r, p(r.session)));
    for (const r of rows.planSnapshots) push(toTaskState(r, p(r.session)));
    for (const r of rows.objectives) push(toObjective(r, p(r.session)));
    for (const r of rows.policyDecisions) push(toPolicyDecision(r, p(r.session)));
    for (const r of rows.repoStates) push(toRepoState(r, p(r.session)));
    // Stamp parent/root ancestry (from `spawned`) onto every event.
    return events.map((e) => {
        const lin = rows.lineage.get(e.sessionId);
        return lin ? { ...e, parentSessionId: lin.parent, rootSessionId: lin.root } : e;
    });
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

/**
 * An `edited` edge -> a write `run_evidence_ref`, bridged turn->event: anchored
 * to the turn's edit tool_call when that turn has EXACTLY ONE (unambiguous).
 * Ambiguous multi-edit turns are dropped rather than mis-attributed.
 */
const toEditedRef = (
    row: EditedRow,
    turnEditCalls: ReadonlyMap<string, readonly string[]>,
): RunEvidenceRefWrite | null => {
    if (!row.session || !row.turn || !row.file) return null;
    const cands = turnEditCalls.get(row.turn) ?? [];
    if (cands.length !== 1) return null;
    const toolCall = cands[0]!;
    return {
        eventKey: runEvidenceEventRecordKey({
            sessionId: row.session,
            sourceTable: "tool_call",
            sourceId: toolCall,
        }),
        sessionId: row.session,
        ts: row.ts,
        refKind: "file",
        targetTable: "file",
        targetId: row.file,
        pathHash: row.pathSeen ? stableDigest(row.pathSeen) : null,
        privacyLevel: "ref_only",
        attrs: dropUndefined({ access: "write", tool: row.tool ?? undefined }),
    };
};

/** Map file-evidence + edited edges into run_evidence_ref rows (pure; null rows dropped). */
export const buildRunEvidenceRefs = (rows: RunEvidenceSourceRows): RunEvidenceRefWrite[] => {
    const refs: RunEvidenceRefWrite[] = [];
    for (const r of rows.fileEvidence) {
        const ref = toFileRef(r);
        if (ref) refs.push(ref);
    }
    for (const r of rows.edited) {
        const ref = toEditedRef(r, rows.turnEditCalls);
        if (ref) refs.push(ref);
    }
    return refs;
};

/** Keep the earliest (min seq) objective turn per session. */
export const pickEarliestPerSession = (rows: readonly ObjectiveRow[]): ObjectiveRow[] => {
    const best = new Map<string, ObjectiveRow>();
    for (const r of rows) {
        if (!r.session) continue;
        const cur = best.get(r.session);
        if (!cur || (r.seq ?? Infinity) < (cur.seq ?? Infinity)) best.set(r.session, r);
    }
    return [...best.values()];
};

/**
 * Build per-session parent + root lineage from `spawned` (parent->child) edges.
 * `root` walks parent links to the top-level ancestor; top-level sessions get
 * `{parent: null, root: null}` (they ARE the root). Cycle-guarded.
 */
export const buildLineage = (
    edges: readonly { readonly parent?: string | null; readonly child?: string | null }[],
): Map<string, SessionLineage> => {
    const parentOf = new Map<string, string>();
    for (const e of edges) {
        if (e.parent && e.child && e.parent !== e.child) parentOf.set(e.child, e.parent);
    }
    const lineage = new Map<string, SessionLineage>();
    for (const child of parentOf.keys()) {
        const parent = parentOf.get(child) ?? null;
        let root = parent;
        const seen = new Set<string>([child]);
        while (root && parentOf.has(root) && !seen.has(root)) {
            seen.add(root);
            root = parentOf.get(root)!;
        }
        lineage.set(child, { parent, root });
    }
    return lineage;
};

// ---------------------------------------------------------------------------
// Stage (thin DB layer: fetch deref-free, map pure, write idempotent).
// ---------------------------------------------------------------------------

const SESSION_PROVIDER_SQL = `SELECT record::id(id) AS id, source FROM session;`;

const toolCallSql = (since: number | undefined): string =>
    `SELECT record::id(id) AS id, record::id(session) AS session, type::string(ts) AS ts,
            name, has_error AS hasError, command_norm AS commandNorm
     FROM tool_call WHERE session != NONE ${sinceAndClause(since)};`;

export const commandOutcomeSql = (since: number | undefined): string =>
    `SELECT record::id(id) AS id, record::id(session) AS session, (IF tool_call != NONE THEN record::id(tool_call) ELSE NONE END) AS toolCall,
            type::string(ts) AS ts, kind, status, command_norm AS commandNorm
     FROM command_outcome WHERE session != NONE ${sinceAndClause(since)};`;

const compactionSql = (since: number | undefined): string =>
    `SELECT record::id(id) AS id, record::id(session) AS session, type::string(ts) AS ts,
            trigger, strategy, tokens_before AS tokensBefore, summary
     FROM compaction WHERE session != NONE ${sinceAndClause(since)};`;

const planSnapshotSql = (since: number | undefined): string =>
    `SELECT record::id(id) AS id, record::id(session) AS session, type::string(ts) AS ts, summary
     FROM plan_snapshot WHERE session != NONE ${sinceAndClause(since)};`;

// read_file / searched_file are RELATION FROM tool_call TO file; `in.session` is
// a single-hop deref to anchor the ref's session.
const fileEvidenceSql = (edge: "read_file" | "searched_file", access: string, since: number | undefined): string =>
    `SELECT record::id(in) AS toolCall, record::id(out) AS file, record::id(in.session) AS session,
            type::string(ts) AS ts, path_seen AS pathSeen, '${access}' AS access
     FROM ${edge} WHERE ts != NONE ${sinceAndClause(since)};`;

// `edited` is RELATION FROM turn TO file; bridged to the turn's edit tool_call.
const editedSql = (since: number | undefined): string =>
    `SELECT record::id(in) AS turn, record::id(out) AS file, record::id(in.session) AS session,
            type::string(ts) AS ts, path_seen AS pathSeen, tool
     FROM edited WHERE ts != NONE ${sinceAndClause(since)};`;

// Edit tool_calls with their turn, for the edited bridge. Filtered to edit tool
// names (lowercased) so the JS turn-map only holds edit candidates.
const editToolCallSql = (since: number | undefined): string => {
    const names = [...EDIT_TOOL_NAMES].map((n) => `"${n}"`).join(", ");
    return `SELECT record::id(id) AS toolCall, record::id(turn) AS turn
            FROM tool_call WHERE turn != NONE AND string::lowercase(name) IN [${names}] ${sinceAndClause(since)};`;
};

// Objective: the run's stated goal. `task`-kind user turns only (real prompts,
// not context/control wrappers); earliest-per-session is picked in JS by seq.
const objectiveSql = (since: number | undefined): string =>
    `SELECT record::id(id) AS id, record::id(session) AS session, type::string(ts) AS ts,
            seq, text_excerpt AS textExcerpt
     FROM turn WHERE session != NONE AND role = "user" AND message_kind = "task" ${sinceAndClause(since)};`;

// Policy decisions: hook invocations whose effect is a real intervention.
export const policyDecisionSql = (since: number | undefined): string =>
    `SELECT record::id(id) AS id, record::id(session) AS session, (IF tool_call != NONE THEN record::id(tool_call) ELSE NONE END) AS toolCall,
            type::string(ts) AS ts, hook_name AS hookName, effect, provider_status AS providerStatus
     FROM hook_command_invocation
     WHERE session != NONE AND effect IN ["blocked", "injected_context", "modified_input", "notified"] ${sinceAndClause(since)};`;

// Repo state: each session's checkout (single-hop derefs for repo identity).
// NOTE: dirty is intentionally not read - the git ingest writes it always-false.
const repoStateSql = (since: number | undefined): string =>
    `SELECT record::id(id) AS session, record::id(checkout) AS checkout,
            type::string(started_at) AS ts, checkout.branch AS branch,
            checkout.head_sha AS headSha, record::id(checkout.repository) AS repository
     FROM session WHERE checkout != NONE ${sinceAndClause(since).replace("ts >", "started_at >")};`;

// spawned is RELATION FROM parent_session TO child_session - parent/root lineage.
const SPAWNED_SQL = `SELECT record::id(in) AS parent, record::id(out) AS child FROM spawned;`;

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
        const [edited] = yield* db.query<[Array<EditedRow>]>(editedSql(sinceDays));
        const [editCalls] = yield* db.query<[Array<{ turn?: string | null; toolCall?: string | null }>]>(editToolCallSql(sinceDays));
        const [objectiveTurns] = yield* db.query<[Array<ObjectiveRow>]>(objectiveSql(sinceDays));
        const [policyDecisions] = yield* db.query<[Array<PolicyDecisionRow>]>(policyDecisionSql(sinceDays));
        const [repoStates] = yield* db.query<[Array<RepoStateRow>]>(repoStateSql(sinceDays));
        const [spawnEdges] = yield* db.query<[Array<{ parent?: string | null; child?: string | null }>]>(SPAWNED_SQL);

        // turn -> edit tool_call keys (the edited bridge anchors only when a turn
        // has exactly one edit tool_call).
        const turnEditCalls = new Map<string, string[]>();
        for (const c of editCalls ?? []) {
            if (!c.turn || !c.toolCall) continue;
            const list = turnEditCalls.get(c.turn);
            if (list) list.push(c.toolCall);
            else turnEditCalls.set(c.turn, [c.toolCall]);
        }

        // Earliest `task` user turn per session = the objective (min seq).
        const objectives = pickEarliestPerSession(objectiveTurns ?? []);

        // Lineage from `spawned` (parent->child): parent map + walked-up root.
        const lineage = buildLineage(spawnEdges ?? []);

        const rows: RunEvidenceSourceRows = {
            toolCalls: toolCalls ?? [],
            commandOutcomes: commandOutcomes ?? [],
            compactions: compactions ?? [],
            planSnapshots: planSnapshots ?? [],
            fileEvidence: [...(reads ?? []), ...(searches ?? [])],
            edited: edited ?? [],
            objectives,
            policyDecisions: policyDecisions ?? [],
            repoStates: repoStates ?? [],
            turnEditCalls,
            lineage,
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
        deps: ["claude", "codex", "pi", "omp", "opencode", "cursor", "outcomes", "git", "spawned"],
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
