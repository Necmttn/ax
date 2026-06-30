/**
 * Run evidence ledger contract (#578).
 *
 * A metadata-only overlay on the normalized graph: it normalizes facts already
 * in `turn` / `tool_call` / `agent_event` / `plan_snapshot` / `compaction` /
 * `command_outcome` / hook tables into a single reviewer-facing ledger that can
 * answer, for a run: objective, durable task state, tool-backed observations,
 * verifier results, policy decisions, and what was lost at compaction/resume
 * boundaries - and can distinguish a model CLAIM from tool-BACKED evidence.
 *
 * This module is the shared CONTRACT + deterministic statement builders. It has
 * no DB or parser dependency, so both a future ingest stage and read queries can
 * reuse it. The two tables it targets are `run_evidence_event` and
 * `run_evidence_ref` (see packages/schema/src/schema.surql).
 *
 * Design invariants (from the issue thread):
 *   - Refs + hashes by default, never raw private payloads (`privacy_level`).
 *   - `backing` is verifier-DERIVED from joins, not a producer trust label - no
 *     automatic promotion (repeated claims never become observations; policy
 *     permission is not proof of execution).
 *   - Rows are REBUILDABLE: the event key is derived from
 *     (session, source_table, source_id), so re-deriving overwrites in place.
 */

import { Schema } from "effect";
import { stableDigest } from "../ids.ts";
import {
    recordRef,
    safeKeyPart,
    surrealDate,
    surrealObject,
    surrealOptionDate,
    surrealOptionRecord,
    surrealOptionString,
    surrealString,
} from "./surreal.ts";

// ============================================================================
// 1. ENUMS / CLOSED SETS
// ----------------------------------------------------------------------------
// Each closed set is a const tuple (the single source of truth) + a derived
// Effect `Schema.Literal` union, so the same values validate at the boundary
// and type the builder input.
// ============================================================================

/** What an evidence event asserts about the run. */
export const RUN_EVIDENCE_KINDS = [
    "objective",
    "task_state",
    "tool_observation",
    "verification",
    "policy_decision",
    "boundary",
    "artifact_ref",
    "repo_state",
    "claim",
    "derived_summary",
] as const;
export const RunEvidenceKind = Schema.Literals(RUN_EVIDENCE_KINDS);
export type RunEvidenceKind = typeof RunEvidenceKind.Type;

/**
 * How well-grounded the event is. Verifier-derived from available joins, never a
 * producer-controlled trust label. No automatic promotion between classes.
 */
export const RUN_EVIDENCE_BACKINGS = [
    "model_claim",
    "tool_backed",
    "verifier_backed",
    "policy_backed",
    "derived",
    "unknown",
] as const;
export const RunEvidenceBacking = Schema.Literals(RUN_EVIDENCE_BACKINGS);
export type RunEvidenceBacking = typeof RunEvidenceBacking.Type;

/** What kind of thing a ref points at. */
export const RUN_EVIDENCE_REF_KINDS = [
    "record",
    "file",
    "sidecar",
    "url",
    "command",
    "commit",
    "external_event",
] as const;
export const RunEvidenceRefKind = Schema.Literals(RUN_EVIDENCE_REF_KINDS);
export type RunEvidenceRefKind = typeof RunEvidenceRefKind.Type;

/**
 * How much of the underlying payload a ref retains. Defaults to `ref_only` -
 * structural pointer + hashes, no payload - so the ledger never re-leaks private
 * content the producer already holds.
 */
export const RUN_EVIDENCE_PRIVACY_LEVELS = [
    "ref_only",
    "hashed",
    "summary",
    "raw",
] as const;
export const RunEvidencePrivacyLevel = Schema.Literals(RUN_EVIDENCE_PRIVACY_LEVELS);
export type RunEvidencePrivacyLevel = typeof RunEvidencePrivacyLevel.Type;

// ============================================================================
// 2. WRITE DTOs
// ----------------------------------------------------------------------------
// Plain interfaces consumed by the statement builders. Bare record KEYS (no
// `table:` prefix) are passed for every link; the builder splices them through
// `recordRef` / `surrealOptionRecord`.
// ============================================================================

/** Optional hot-ref keys into the normalized graph (bare record keys). */
export interface RunEvidenceHotRefs {
    readonly turnKey?: string | null;
    readonly toolCallKey?: string | null;
    readonly agentEventKey?: string | null;
    readonly compactionKey?: string | null;
    readonly planSnapshotKey?: string | null;
    readonly commandOutcomeKey?: string | null;
    readonly hookInvocationKey?: string | null;
    readonly artifactKey?: string | null;
    readonly fileKey?: string | null;
    readonly checkoutKey?: string | null;
    readonly commitKey?: string | null;
}

export interface RunEvidenceEventWrite extends RunEvidenceHotRefs {
    /** Bare session id (no `session:` prefix) the evidence belongs to. */
    readonly sessionId: string;
    readonly rootSessionId?: string | null;
    readonly parentSessionId?: string | null;
    /** Logical event time (from the source row, not wall-clock). */
    readonly ts: Date | string;
    readonly provider: string;
    readonly kind: RunEvidenceKind;
    readonly backing: RunEvidenceBacking;
    /** Table the evidence was normalized from, e.g. `tool_call`. */
    readonly sourceTable: string;
    /** Stable id within `sourceTable` (the producer's record/event id). */
    readonly sourceId: string;
    readonly summary?: string | null;
    readonly contentHash?: string | null;
    readonly inputHash?: string | null;
    readonly outputHash?: string | null;
    /** Free-form structured attributes; JSON-encoded into the `attrs` column. */
    readonly attrs?: unknown;
    /**
     * When this derivation first observed the row. Omit to let the column
     * default once at create time (keeps re-derivation idempotent - a later
     * rebuild does not re-stamp it).
     */
    readonly observedAt?: Date | string | null;
}

export interface RunEvidenceRefWrite {
    /** Bare key of the owning `run_evidence_event` row. */
    readonly eventKey: string;
    /** Bare session id (no `session:` prefix). */
    readonly sessionId: string;
    readonly ts: Date | string;
    readonly refKind: RunEvidenceRefKind;
    readonly targetTable?: string | null;
    readonly targetId?: string | null;
    readonly pathHash?: string | null;
    readonly uriHash?: string | null;
    readonly contentHash?: string | null;
    readonly privacyLevel?: RunEvidencePrivacyLevel;
    readonly attrs?: unknown;
}

// ============================================================================
// 3. RECORD KEYS
// ----------------------------------------------------------------------------
// Deterministic + idempotent: the same logical source always yields the same
// key, so re-derivation UPSERTs in place rather than duplicating.
// ============================================================================

/**
 * `<session>__<digest(source_table|source_id)>` - one event row per
 * (session, source row). Re-deriving the same source overwrites in place.
 */
export const runEvidenceEventRecordKey = (input: {
    readonly sessionId: string;
    readonly sourceTable: string;
    readonly sourceId: string;
}): string =>
    `${safeKeyPart(input.sessionId)}__${stableDigest(`${input.sourceTable}|${input.sourceId}`)}`;

/**
 * `<digest(event|refKind|target|path|uri)>` - one ref row per distinct pointer
 * off an event. Stable across re-derivation.
 */
export const runEvidenceRefRecordKey = (input: {
    readonly eventKey: string;
    readonly refKind: RunEvidenceRefKind;
    readonly targetTable?: string | null;
    readonly targetId?: string | null;
    readonly pathHash?: string | null;
    readonly uriHash?: string | null;
}): string =>
    stableDigest(
        [
            input.eventKey,
            input.refKind,
            input.targetTable ?? "",
            input.targetId ?? "",
            input.pathHash ?? "",
            input.uriHash ?? "",
        ].join("|"),
    );

// ============================================================================
// 4. STATEMENT BUILDERS
// ----------------------------------------------------------------------------
// Deterministic SurrealQL strings. UPSERT ... MERGE so a re-derive overwrites
// the row in place. `attrs` is JSON-encoded; every ref/hash field is an
// `option` literal (NONE when absent).
// ============================================================================

const optHotRef = (
    fields: (readonly [string, string])[],
    name: string,
    table: string,
    key: string | null | undefined,
): void => {
    if (key !== null && key !== undefined) fields.push([name, recordRef(table, key)]);
};

/** Build the `UPSERT run_evidence_event:... MERGE {...}` statement. */
export const buildRunEvidenceEventStatement = (input: RunEvidenceEventWrite): string => {
    const key = runEvidenceEventRecordKey(input);
    const fields: (readonly [string, string])[] = [
        ["session", recordRef("session", input.sessionId)],
        ["root_session", surrealOptionRecord("session", input.rootSessionId)],
        ["parent_session", surrealOptionRecord("session", input.parentSessionId)],
        ["ts", surrealDate(input.ts)],
        ["provider", surrealString(input.provider)],
        ["kind", surrealString(input.kind)],
        ["backing", surrealString(input.backing)],
    ];
    optHotRef(fields, "turn", "turn", input.turnKey);
    optHotRef(fields, "tool_call", "tool_call", input.toolCallKey);
    optHotRef(fields, "agent_event", "agent_event", input.agentEventKey);
    optHotRef(fields, "compaction", "compaction", input.compactionKey);
    optHotRef(fields, "plan_snapshot", "plan_snapshot", input.planSnapshotKey);
    optHotRef(fields, "command_outcome", "command_outcome", input.commandOutcomeKey);
    optHotRef(fields, "hook_invocation", "hook_command_invocation", input.hookInvocationKey);
    optHotRef(fields, "artifact", "artifact", input.artifactKey);
    optHotRef(fields, "file", "file", input.fileKey);
    optHotRef(fields, "checkout", "checkout", input.checkoutKey);
    optHotRef(fields, "commit", "commit", input.commitKey);
    fields.push(
        ["source_table", surrealString(input.sourceTable)],
        ["source_id", surrealString(input.sourceId)],
        ["summary", surrealOptionString(input.summary)],
        ["content_hash", surrealOptionString(input.contentHash)],
        ["input_hash", surrealOptionString(input.inputHash)],
        ["output_hash", surrealOptionString(input.outputHash)],
        ["attrs", surrealOptionString(encodeAttrs(input.attrs))],
    );
    // Omit observed_at unless explicitly provided so the column defaults once at
    // create time and a later rebuild does not re-stamp it (idempotent).
    if (input.observedAt !== undefined && input.observedAt !== null) {
        fields.push(["observed_at", surrealOptionDate(input.observedAt)]);
    }
    return `UPSERT ${recordRef("run_evidence_event", key)} MERGE ${surrealObject(fields)};`;
};

/** Build the `UPSERT run_evidence_ref:... MERGE {...}` statement. */
export const buildRunEvidenceRefStatement = (input: RunEvidenceRefWrite): string => {
    const key = runEvidenceRefRecordKey(input);
    const fields: (readonly [string, string])[] = [
        ["event", recordRef("run_evidence_event", input.eventKey)],
        ["session", recordRef("session", input.sessionId)],
        ["ts", surrealDate(input.ts)],
        ["ref_kind", surrealString(input.refKind)],
        ["target_table", surrealOptionString(input.targetTable)],
        ["target_id", surrealOptionString(input.targetId)],
        ["path_hash", surrealOptionString(input.pathHash)],
        ["uri_hash", surrealOptionString(input.uriHash)],
        ["content_hash", surrealOptionString(input.contentHash)],
        ["privacy_level", surrealString(input.privacyLevel ?? "ref_only")],
        ["attrs", surrealOptionString(encodeAttrs(input.attrs))],
    ];
    return `UPSERT ${recordRef("run_evidence_ref", key)} MERGE ${surrealObject(fields)};`;
};

/** Build all statements for a batch (events first, then refs). */
export const buildRunEvidenceStatements = (batch: {
    readonly events: readonly RunEvidenceEventWrite[];
    readonly refs: readonly RunEvidenceRefWrite[];
}): string[] => [
    ...batch.events.map(buildRunEvidenceEventStatement),
    ...batch.refs.map(buildRunEvidenceRefStatement),
];

/** JSON-encode attrs to a string column value (null when absent/empty). */
const encodeAttrs = (attrs: unknown): string | null => {
    if (attrs === null || attrs === undefined) return null;
    if (typeof attrs === "string") return attrs;
    const json = JSON.stringify(attrs);
    return json === undefined || json === "{}" ? null : json;
};
