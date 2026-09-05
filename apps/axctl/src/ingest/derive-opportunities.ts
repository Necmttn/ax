/**
 * Derive-Opportunities Stage (Phase C5 + form-aware extension).
 *
 * Each active experiment (proposal.status='accepted', locked_verdict
 * IS NONE) collects `opportunity` rows for every new piece of trigger-
 * matching evidence after experiment.created_at. C6 then aggregates the
 * count + addressed ratio into a `checkpoint` row at t+7/t+30/t+90.
 *
 * Form coverage:
 *  - skill (closure-derived, cites skill_candidate): legacy detector via
 *    later_fixed_by + overlap_files token match.
 *  - skill (retro-derived, no skill_candidate): trigger_pattern fallback,
 *    matches failing tool_call rows for the named tool.
 *  - hook: failing tool_call rows for hook_proposal.target_tool;
 *    was_addressed if a hook_command_invocation carrying the experiment's
 *    COMPLETE `ax:<dedupe_sig>` marker, on the configured event, with a real
 *    effect, correlates to the failing call (exact tool-call identity first,
 *    ±ADDRESSED_WINDOW_MS inside the same session only as a fallback).
 *  - guidance: friction_event rows of kind='correction'; was_addressed if the
 *    OBSERVED artifact's (experiment.artifact_path) mtime is later than the
 *    opportunity's matched_at - file activity, not proof of better behaviour.
 *  - automation/subagent: explicitly skipped pending detectors.
 *
 * Artifact identity comes from what `improve lint` RECORDED (#1133), never from
 * a path guessed off the proposal. An experiment with no recorded artifact /
 * install time has UNAVAILABLE evidence: it contributes no rows, and its stale
 * ones are cleared rather than left to read as "not addressed".
 *
 * Measurement starts at `experiment.scaffolded_at` (the observed install),
 * because acceptance can precede installation by days.
 *
 * The opportunity row is a RELATION (in=experiment, out=evidence record).
 * Edge id = sha-style key over (experimentKey, evidenceKey) so re-derive
 * passes are idempotent; every selected experiment's rows are REBUILT each run
 * so a match the corrected rules drop cannot survive as a stale row.
 */

import { Effect, FileSystem, Option, Schema } from "effect";
import { jsonArrayField } from "@ax/lib/decode";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { cacheRow, tsParam } from "@ax/lib/duckdb/row";
import type { CacheReadError, CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import type { Judgment, JudgmentError } from "@ax/lib/sqlite";
import { listStoredProposals } from "../improve/judgment-proposals.ts";
import { parseHookCommandMarkers } from "../improve/markers.ts";
import { REAL_HOOK_EFFECTS } from "./transcripts.ts";
import { safeKeyPart, recordKeyPart } from "@ax/lib/shared/derive-keys";

export interface DeriveOpportunitiesStats {
    readonly experimentsScanned: number;
    readonly opportunities: number;
    readonly addressed: number;
    readonly bySkillForm: number;
    readonly byHookForm: number;
    readonly byGuidanceForm: number;
    /** Experiments whose installed artifact could not be resolved - no recorded
     *  `artifact_path` / `scaffolded_at`, so their evidence is UNAVAILABLE
     *  rather than negative. Their stale rows are cleared, not kept. */
    readonly artifactUnavailable: number;
}

/**
 * Phase C5a (was_addressed detector): resolve the experiment's
 * scaffolded SKILL.md path back to a skill row via the kebab-name in
 * its parent directory, then flip opportunity.was_addressed=true for
 * any opportunity whose matched_at falls within ±1h of an `invoked`
 * edge to that skill. The window is generous because the harness logs
 * tool calls at coarse timestamps and the underlying fix-chain edges
 * land asynchronously.
 */
export const ADDRESSED_WINDOW_MS = 60 * 60 * 1000;

/** Bound the `IN (...)` list of the per-experiment rebuild delete. */
const DELETE_CHUNK = 200;

export const kebabNameFromArtifactPath = (path: string | null): string | null => {
    if (!path) return null;
    const parts = path.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    // .../<kebab-name>/SKILL.md
    const dir = parts[parts.length - 2];
    return dir ?? null;
};

/**
 * The artifact ax OBSERVED being installed - `experiment.artifact_path`, written
 * by `improve lint` (lint.ts) when it reconciles the marker it actually found on
 * disk. A blank/absent value means nothing was reconciled yet: the caller reports
 * unavailable artifact evidence rather than guessing a path from the proposal
 * (a guessed `<basename>.sh` misses python/node/bun/inline hooks, and a bare
 * `CLAUDE.md` expanded to `~/.claude/CLAUDE.md` measures a DIFFERENT file that
 * merely shares a basename).
 */
export const installedArtifactPath = (path: string | null): string | null => {
    const trimmed = path?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : null;
};

/**
 * Does this hook command carry the experiment's installed marker identity?
 *
 * The task template installs `ax:<dedupe_sig>` INSIDE the configured command,
 * and every producer path preserves the command verbatim (progress line,
 * `hook_success` attachment, and the command recovered from a blocked
 * tool_result), so the marker survives into `hook_command_invocation.command`.
 *
 * Identity is COMPLETE-id equality through the shared marker parser, never a
 * SQL substring: `ax:74da7418` and `ax:74da7418ff` are different experiments,
 * and a shell filename that happens to contain the signature is not a marker.
 */
export const commandCarriesMarker = (command: string, dedupeSig: string): boolean => {
    if (dedupeSig.length === 0) return false;
    return parseHookCommandMarkers(command).some((marker) => marker.id === dedupeSig);
};

/** The `hook_command_invocation` columns the hook detector reads. */
export interface HookInvocationFact {
    readonly session: string | null;
    readonly ts: string;
    readonly command: string;
    readonly event_name: string;
    /** ref -> tool_call.id (the row key), when the harness named the call. */
    readonly tool_call: string | null;
    /** The provider's own tool-use id, comparable to `tool_call.call_id`. */
    readonly tool_call_id: string | null;
    readonly effect: string;
    readonly provider_status: string;
}

/** The `tool_call` columns the hook detector correlates against. */
export interface HookOpportunityFact {
    readonly id: string;
    readonly session: string | null;
    readonly call_id: string | null;
    readonly ts: string;
}

/**
 * Is this fire evidence that THIS experiment's hook ran with a real effect?
 *
 * Three independent gates, all required: the installed marker identity, the
 * configured event name, and a real effect. `progress_only` records are a
 * mid-flight status line rather than an outcome, and `no_op`/`unknown`/`allowed`
 * are fires with no observed consequence - none of them is an intervention.
 * A hook that passes SILENTLY is written nowhere by the harness, so it stays
 * unmeasured; presence of the configuration is not evidence that it ran.
 */
export const isCreditableHookInvocation = (
    invocation: HookInvocationFact,
    identity: { readonly dedupeSig: string; readonly eventName: string },
): boolean =>
    invocation.provider_status !== "progress_only"
    && REAL_HOOK_EFFECTS.includes(invocation.effect as (typeof REAL_HOOK_EFFECTS)[number])
    && invocation.event_name === identity.eventName
    && commandCarriesMarker(invocation.command, identity.dedupeSig);

/**
 * Did a creditable fire address this failing tool call?
 *
 * Same session always (a fire in another run says nothing about this one). Then
 * exact tool-call correlation is PREFERRED: when the fire names a call - either
 * the `tool_call` row ref or the provider's `tool_call_id` - it credits that one
 * call and no other. The ±{@link ADDRESSED_WINDOW_MS} window survives only as
 * the fallback for fires the harness recorded without any call identity.
 */
export const hookOpportunityAddressed = (
    call: HookOpportunityFact,
    invocations: readonly HookInvocationFact[],
    windowMs: number = ADDRESSED_WINDOW_MS,
): boolean => {
    const callMs = new Date(call.ts).getTime();
    return invocations.some((invocation) => {
        if (!call.session || !invocation.session || call.session !== invocation.session) return false;
        if (invocation.tool_call !== null) return invocation.tool_call === call.id;
        if (invocation.tool_call_id !== null && call.call_id !== null) {
            return invocation.tool_call_id === call.call_id;
        }
        const fireMs = new Date(invocation.ts).getTime();
        if (!Number.isFinite(callMs) || !Number.isFinite(fireMs)) return false;
        return Math.abs(fireMs - callMs) <= windowMs;
    });
};

/**
 * Parse a skill_proposal.trigger_pattern of the form `tool=<Name>` and
 * return the tool name. Returns null for any other shape.
 */
export const parseSkillTriggerTool = (pattern: string): string | null => {
    const m = /^tool=(.+)$/.exec(pattern.trim());
    return m && m[1] ? m[1].trim() : null;
};

interface ActiveExperimentRow {
    readonly id: string | { tb: string; id: string };
    readonly created_at: string;
    /** When `improve lint` OBSERVED the artifact installed - the earliest time a
     *  measurement can mean anything. Null until lint has reconciled the marker
     *  (acceptance can precede installation by days). */
    readonly scaffolded_at: string | null;
    readonly form: string;
    /** The proposal's `ax:<dedupe_sig>` marker identity, installed inside the
     *  hook command by the task template. */
    readonly dedupe_sig: string;
    readonly candidate_id: string | { tb: string; id: string } | null;
    readonly artifact_path: string | null;
    readonly skill_trigger: string | null;
    readonly hook_payload: {
        readonly target_tool?: string | null;
        readonly event_name?: string | null;
    } | null;
    readonly guidance_payload: {
        readonly file_target?: string | null;
        readonly suggested_text?: string | null;
    } | null;
}

interface LaterFixedByRow {
    readonly id: string | { tb: string; id: string };
    readonly ts: string;
    readonly overlap_files: string | null;
}

interface ToolCallRow {
    readonly id: string | { tb: string; id: string };
    readonly ts: string;
}

interface HookToolCallRow extends ToolCallRow {
    readonly session: string | null;
    readonly call_id: string | null;
}

interface FrictionEventRow {
    readonly id: string | { tb: string; id: string };
    readonly ts: string;
}

export const opportunityKey = (experimentKey: string, evidenceKey: string): string =>
    `${safeKeyPart(experimentKey).slice(0, 48)}__${safeKeyPart(evidenceKey).slice(0, 48)}__${Bun.hash(`${experimentKey}:${evidenceKey}`).toString(16).slice(0, 12)}`;

export const parseOverlapFiles = (raw: string | null): string[] => {
    const parsed = jsonArrayField.decode(raw);
    return parsed ? parsed.filter((s): s is string => typeof s === "string") : [];
};

export const triggerTokensFromCandidate = (candidateKey: string): string[] => {
    // closure.ts derives candidate names like "SurrealDB_schema_change_guardrail";
    // tokens used for path matching are the lowercased word-segments.
    return candidateKey
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((tok) => tok.length >= 4 && tok !== "guardrail" && tok !== "checklist");
};

export const overlapFilesMatch = (
    files: readonly string[],
    tokens: readonly string[],
): boolean => {
    if (tokens.length === 0) return false;
    for (const file of files) {
        const lower = file.toLowerCase();
        for (const tok of tokens) {
            if (lower.includes(tok)) return true;
        }
    }
    return false;
};

export const buildOpportunityRows = (
    experimentKey: string,
    matches: ReadonlyArray<{
        readonly evidenceTable: string;
        readonly evidenceKey: string;
        readonly ts: string;
        readonly addressed?: boolean;
    }>,
): Array<Record<string, import("@ax/lib/duckdb/types").DuckDbParam>> => {
    const rows: Array<Record<string, import("@ax/lib/duckdb/types").DuckDbParam>> = [];
    for (const m of matches) {
        const edgeKey = opportunityKey(experimentKey, m.evidenceKey);
        rows.push(cacheRow({ id: edgeKey, in_id: experimentKey, out_id: m.evidenceKey,
            out_table: m.evidenceTable, matched_at: tsParam(m.ts) ?? new Date(),
            was_addressed: m.addressed ?? false }));
    }
    return rows;
};

interface SkillIdRow {
    readonly id: string | { tb: string; id: string };
}

interface InvokedTsRow {
    readonly ts: string;
}

/**
 * Best-effort file mtime in epoch-ms, or `null` when the file is absent /
 * unreadable. OLD: `statSync` in try/catch returning `null` on ANY fault →
 * `orAbsent` (a missing or unreadable guidance target is "not addressed").
 * `fs.stat` follows symlinks (matching node's `statSync`); `.mtime` is an
 * `Option<Date>`, so a stat that lands but lacks mtime also maps to `null`.
 */
export const safeFileMtimeMs = (
    absPath: string,
): Effect.Effect<number | null, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const info = yield* fs.stat(absPath).pipe(Effect.asSome, orAbsent(Option.none()));
        if (Option.isNone(info)) return null;
        return Option.match(info.value.mtime, {
            onNone: () => null,
            onSome: (d) => d.getTime(),
        });
    });

/**
 * This stage spans BOTH v2 stores, and the split is not incidental.
 *
 * The experiments it scans and their per-form payloads are durable JUDGMENT
 * (SQLite sidecar); every piece of evidence it matches them against, and the
 * `opportunity` rows it writes, are rebuildable graph data (DuckDB cache -
 * `schema.duckdb.sql` owns `opportunity`, and `derive-checkpoints` reads it
 * from there to compute each verdict's addressed ratio). The join between the
 * two happens in JS, because no single engine holds both sides.
 *
 * The reader is the lock-held WRITER, not `CacheRead`: this runs inside ingest,
 * before the snapshot exists, and every row it matches was written by earlier
 * stages of THIS run (F1).
 */
export const deriveOpportunities = (write: CacheWriteService): Effect.Effect<
    DeriveOpportunitiesStats,
    CacheWriteError | CacheReadError | JudgmentError,
    Judgment | FileSystem.FileSystem
> =>
    Effect.gen(function* () {
        // Active = accepted proposal + experiment without a locked verdict.
        // Both live in the sidecar, so this is the sidecar's own reader rather
        // than a join in SQL.
        const stored = yield* listStoredProposals({ limit: 100_000, status: "accepted" });
        const active = stored.filter((proposal) =>
            proposal.experiment !== null && proposal.experiment.locked_verdict === null);

        // The one field that has to cross: `cites_evidence` is a MINED edge and
        // stays in the cache, so the skill_candidate a proposal cites is looked
        // up here and matched to its (sidecar) proposal id in JS.
        const candidateByProposal = new Map<string, string>();
        if (active.length > 0) {
            const proposalIds = active.map((proposal) => proposal.id);
            const citesRaw = yield* write.raw(
                `SELECT in_id, out_id FROM cites_evidence
                 WHERE out_table = 'skill_candidate' AND in_id IN (${proposalIds.map(() => "?").join(", ")})`,
                proposalIds,
            );
            for (const row of citesRaw.rows as Array<Record<string, unknown>>) {
                const owner = typeof row.in_id === "string" ? row.in_id : null;
                const candidate = typeof row.out_id === "string" ? row.out_id : null;
                if (owner && candidate && !candidateByProposal.has(owner)) {
                    candidateByProposal.set(owner, candidate);
                }
            }
        }

        const experiments = active.map((proposal) => {
            const experiment = proposal.experiment!;
            return {
                id: experiment.id,
                created_at: experiment.created_at.toISOString(),
                scaffolded_at: experiment.scaffolded_at?.toISOString() ?? null,
                form: proposal.form,
                dedupe_sig: proposal.dedupe_sig,
                artifact_path: experiment.artifact_path,
                candidate_id: candidateByProposal.get(proposal.id) ?? null,
                skill_trigger: proposal.skill_payload?.trigger_pattern ?? null,
                hook_payload: {
                    target_tool: proposal.hook_payload?.target_tool ?? null,
                    event_name: proposal.hook_payload?.event_name ?? null,
                },
                guidance_payload: {
                    file_target: proposal.guidance_payload?.file_target ?? null,
                    suggested_text: proposal.guidance_payload?.suggested_text ?? null,
                },
            } satisfies ActiveExperimentRow;
        });

        let totalOpportunities = 0;
        let totalAddressed = 0;
        let bySkillForm = 0;
        let byHookForm = 0;
        let byGuidanceForm = 0;
        let artifactUnavailable = 0;
        // Every experiment this run SELECTED gets its derived rows rebuilt, so a
        // `was_addressed` computed by the old matching rules cannot outlive them.
        const rebuiltExperimentKeys: string[] = [];
        const allRows: Array<Record<string, import("@ax/lib/duckdb/types").DuckDbParam>> = [];

        for (const exp of experiments) {
            const experimentKey = recordKeyPart(exp.id, "experiment");
            if (!experimentKey) continue;
            rebuiltExperimentKeys.push(experimentKey);
            const form = exp.form;

            // -------- skill form (legacy: closure-derived via skill_candidate) --------
            const candidateKey = exp.candidate_id ? recordKeyPart(exp.candidate_id, "skill_candidate") : null;
            if (form === "skill" && candidateKey) {
                const tokens = triggerTokensFromCandidate(candidateKey);
                if (tokens.length === 0) continue;

                const fixesResult = yield* write.raw(`
                    SELECT id, CAST(ts AS VARCHAR) AS ts, overlap_files
                    FROM later_fixed_by
                    WHERE ts > ?`, [new Date(exp.created_at)]);
                const fixes = fixesResult.rows as unknown as LaterFixedByRow[];
                const matches: Array<{ evidenceTable: string; evidenceKey: string; ts: string }> = [];
                for (const fix of fixes) {
                    const files = parseOverlapFiles(fix.overlap_files);
                    if (!overlapFilesMatch(files, tokens)) continue;
                    const evidenceKey = recordKeyPart(fix.id, "later_fixed_by");
                    if (!evidenceKey) continue;
                    matches.push({ evidenceTable: "later_fixed_by", evidenceKey, ts: fix.ts });
                }
                if (matches.length === 0) continue;

                // C5a: resolve scaffolded skill, pre-compute invoked edges.
                const kebab = kebabNameFromArtifactPath(exp.artifact_path);
                let invokedTimestamps: number[] = [];
                if (kebab) {
                    const skillResult = yield* write.raw("SELECT id FROM skill WHERE name = ? LIMIT 1", [kebab]);
                    const skillRow = (skillResult.rows as unknown as SkillIdRow[])[0];
                    if (skillRow?.id) {
                        const skillKey = recordKeyPart(skillRow.id, "skill");
                        if (skillKey) {
                            const invokedResult = yield* write.raw("SELECT CAST(ts AS VARCHAR) AS ts FROM invoked WHERE out_id = ? AND ts > ?", [skillKey, new Date(exp.created_at)]);
                            invokedTimestamps = (invokedResult.rows as unknown as InvokedTsRow[])
                                .map((r) => new Date(r.ts).getTime())
                                .filter((t) => Number.isFinite(t));
                        }
                    }
                }
                const enriched = matches.map((m) => {
                    const matchedMs = new Date(m.ts).getTime();
                    const addressed = invokedTimestamps.some(
                        (t) => Math.abs(t - matchedMs) <= ADDRESSED_WINDOW_MS,
                    );
                    if (addressed) totalAddressed += 1;
                    return { ...m, addressed };
                });

                totalOpportunities += matches.length;
                bySkillForm += matches.length;
                allRows.push(...buildOpportunityRows(experimentKey, enriched));
                continue;
            }

            // -------- skill form (retro-derived: trigger_pattern fallback) --------
            if (form === "skill" && !candidateKey && exp.skill_trigger) {
                const tool = parseSkillTriggerTool(exp.skill_trigger);
                if (!tool) continue;

                const callsResult = yield* write.raw(`
                    SELECT id, CAST(ts AS VARCHAR) AS ts
                    FROM tool_call
                    WHERE name = ? AND has_error = true AND ts > ?`, [tool, new Date(exp.created_at)]);
                const calls = callsResult.rows as unknown as ToolCallRow[];
                const matches: Array<{ evidenceTable: string; evidenceKey: string; ts: string }> = [];
                for (const c of calls) {
                    const evidenceKey = recordKeyPart(c.id, "tool_call");
                    if (!evidenceKey) continue;
                    matches.push({ evidenceTable: "tool_call", evidenceKey, ts: c.ts });
                }
                if (matches.length === 0) continue;

                // was_addressed: same scaffold→skill→invoked mechanic as the
                // legacy path. Retro-derived scaffolds also land under a
                // kebab dir, so this kicks in once `axctl improve accept`
                // materialises the SKILL.md.
                const kebab = kebabNameFromArtifactPath(exp.artifact_path);
                let invokedTimestamps: number[] = [];
                if (kebab) {
                    const skillResult = yield* write.raw("SELECT id FROM skill WHERE name = ? LIMIT 1", [kebab]);
                    const skillRow = (skillResult.rows as unknown as SkillIdRow[])[0];
                    if (skillRow?.id) {
                        const skillKey = recordKeyPart(skillRow.id, "skill");
                        if (skillKey) {
                            const invokedResult = yield* write.raw("SELECT CAST(ts AS VARCHAR) AS ts FROM invoked WHERE out_id = ? AND ts > ?", [skillKey, new Date(exp.created_at)]);
                            invokedTimestamps = (invokedResult.rows as unknown as InvokedTsRow[])
                                .map((r) => new Date(r.ts).getTime())
                                .filter((t) => Number.isFinite(t));
                        }
                    }
                }
                const enriched = matches.map((m) => {
                    const matchedMs = new Date(m.ts).getTime();
                    const addressed = invokedTimestamps.some(
                        (t) => Math.abs(t - matchedMs) <= ADDRESSED_WINDOW_MS,
                    );
                    if (addressed) totalAddressed += 1;
                    return { ...m, addressed };
                });

                totalOpportunities += matches.length;
                bySkillForm += matches.length;
                allRows.push(...buildOpportunityRows(experimentKey, enriched));
                continue;
            }

            // -------- hook form --------
            if (form === "hook") {
                const tool = exp.hook_payload?.target_tool ?? null;
                const eventName = exp.hook_payload?.event_name ?? null;
                if (!tool) continue;

                // The identity a fire has to carry to be THIS hook. Without an
                // installed marker + a configured event + an observed install
                // time there is nothing to match on: the hook is UNMEASURED, not
                // unaddressed, so its stale rows go and no new ones land. The
                // executable is never guessed from the proposal - a wrapper, a
                // python/node/bun script and an inline command all look the same
                // from here, and only the marker distinguishes them.
                const installedAt = exp.scaffolded_at;
                if (!eventName || exp.dedupe_sig.length === 0 || installedAt === null) {
                    artifactUnavailable += 1;
                    continue;
                }

                const callsResult = yield* write.raw(`
                    SELECT id, session, call_id, CAST(ts AS VARCHAR) AS ts
                    FROM tool_call
                    WHERE name = ? AND has_error = true AND ts > ?`, [tool, new Date(exp.created_at)]);
                const calls = callsResult.rows as unknown as HookToolCallRow[];
                const matches: Array<{
                    evidenceTable: string;
                    evidenceKey: string;
                    ts: string;
                    call: HookOpportunityFact;
                }> = [];
                for (const c of calls) {
                    const evidenceKey = recordKeyPart(c.id, "tool_call");
                    if (!evidenceKey) continue;
                    matches.push({
                        evidenceTable: "tool_call",
                        evidenceKey,
                        ts: c.ts,
                        call: { id: evidenceKey, session: c.session, call_id: c.call_id, ts: c.ts },
                    });
                }
                if (matches.length === 0) continue;

                // was_addressed: a hook_command_invocation recorded AFTER the
                // install, carrying this experiment's complete marker id, on the
                // configured event, with a real effect. Marker identity is
                // matched in JS through the shared parser - a SQL substring would
                // credit a prefix collision or a filename that merely contains
                // the signature.
                const invResult = yield* write.raw(`
                    SELECT session, CAST(ts AS VARCHAR) AS ts, command, event_name,
                           tool_call, tool_call_id, effect, provider_status
                    FROM hook_command_invocation
                    WHERE ts > ? AND event_name = ? AND provider_status <> 'progress_only'
                      AND effect IN (${REAL_HOOK_EFFECTS.map(() => "?").join(", ")})`,
                    [new Date(installedAt), eventName, ...REAL_HOOK_EFFECTS]);
                const fires = (invResult.rows as unknown as HookInvocationFact[]).filter(
                    (invocation) => isCreditableHookInvocation(invocation, {
                        dedupeSig: exp.dedupe_sig,
                        eventName,
                    }),
                );
                const enriched = matches.map((m) => {
                    const addressed = hookOpportunityAddressed(m.call, fires);
                    if (addressed) totalAddressed += 1;
                    return { evidenceTable: m.evidenceTable, evidenceKey: m.evidenceKey, ts: m.ts, addressed };
                });

                totalOpportunities += matches.length;
                byHookForm += matches.length;
                allRows.push(...buildOpportunityRows(experimentKey, enriched));
                continue;
            }

            // -------- guidance form --------
            if (form === "guidance") {
                // The file lint OBSERVED the marker in, not the proposal's
                // `file_target`. A bare `CLAUDE.md` in a proposal must never be
                // read as `~/.claude/CLAUDE.md`: that is a DIFFERENT file that
                // merely shares a basename, and its mtime says nothing about
                // this experiment. No recorded path (or no observed install
                // time) = unavailable artifact evidence; the user has to run
                // `ax improve lint` in the target repository first.
                const artifactPath = installedArtifactPath(exp.artifact_path);
                const installedAt = exp.scaffolded_at;
                if (artifactPath === null || installedAt === null) {
                    artifactUnavailable += 1;
                    continue;
                }

                // Cheap initial wedge: every correction friction_event AFTER the
                // install is one opportunity for the guidance to have prevented.
                const frictionResult = yield* write.raw(`
                    SELECT id, CAST(ts AS VARCHAR) AS ts
                    FROM friction_event
                    WHERE kind = 'correction' AND ts > ?`, [new Date(installedAt)]);
                const events = frictionResult.rows as unknown as FrictionEventRow[];
                const matches: Array<{ evidenceTable: string; evidenceKey: string; ts: string }> = [];
                for (const ev of events) {
                    const evidenceKey = recordKeyPart(ev.id, "friction_event");
                    if (!evidenceKey) continue;
                    matches.push({ evidenceTable: "friction_event", evidenceKey, ts: ev.ts });
                }
                if (matches.length === 0) continue;

                // was_addressed: the recorded artifact's mtime > matched_at.
                // This is FILE ACTIVITY on the installed guidance file, not
                // proof that behaviour improved - the indicator is kept as-is
                // for this bounded patch, only pointed at the right file.
                // Defensive: stat may fail.
                const mtimeMs = yield* safeFileMtimeMs(artifactPath);
                const enriched = matches.map((m) => {
                    const matchedMs = new Date(m.ts).getTime();
                    const addressed = mtimeMs !== null && mtimeMs > matchedMs;
                    if (addressed) totalAddressed += 1;
                    return { ...m, addressed };
                });

                totalOpportunities += matches.length;
                byGuidanceForm += matches.length;
                allRows.push(...buildOpportunityRows(experimentKey, enriched));
                continue;
            }

            // automation + subagent forms: detectors deferred to follow-up.
        }

        // Rebuild, don't accumulate: an opportunity the corrected identity rules
        // no longer match must DISAPPEAR, and a `was_addressed` computed by the
        // old rules must not stay authoritative. Only the experiments this run
        // selected are cleared - unrelated experiments (and every sidecar
        // judgment) are untouched. Same write service, same held lock, so the
        // delete and the insert land together.
        for (let i = 0; i < rebuiltExperimentKeys.length; i += DELETE_CHUNK) {
            const chunk = rebuiltExperimentKeys.slice(i, i + DELETE_CHUNK);
            yield* write.exec(
                `DELETE FROM opportunity WHERE in_id IN (${chunk.map(() => "?").join(", ")})`,
                chunk,
            );
        }
        yield* write.putMany("opportunity", allRows);
        return {
            experimentsScanned: experiments.length,
            opportunities: totalOpportunities,
            addressed: totalAddressed,
            bySkillForm,
            byHookForm,
            byGuidanceForm,
            artifactUnavailable,
        };
    });

// ---------------------------------------------------------------------------
// Co-located StageDef
// ---------------------------------------------------------------------------

import { BaseStageStats, IngestContext, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

export const OpportunitiesKey = Schema.Literal("opportunities");
export type OpportunitiesKey = typeof OpportunitiesKey.Type;

/**
 * Opportunities stage - derives experiment-loop Opportunity records from
 * accepted proposals + evidence. Depends on {@link ProposalsKey}.
 */
export class OpportunitiesStats extends BaseStageStats.extend<OpportunitiesStats>("OpportunitiesStats")({
    experimentsScanned: Schema.Number,
    opportunities: Schema.Number,
}) {}

export const opportunitiesStage: StageDef<
    OpportunitiesStats,
    Judgment | FileSystem.FileSystem,
    CacheWriteError | CacheReadError | JudgmentError
> = {
    meta: StageMeta.make({ key: "opportunities", deps: ["proposals"], tags: ["derive"], writes: [{ table: "opportunity", mode: "derive" }] }),
    run: (_ctx: IngestContext, write: CacheWriteService) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const result = yield* deriveOpportunities(write);
            const unavailable = result.artifactUnavailable > 0
                ? `, ${result.artifactUnavailable} without installed-artifact evidence (run \`ax improve lint\` in the target repo)`
                : "";
            return OpportunitiesStats.make({
                durationMs: Date.now() - t0,
                summary: `scanned ${result.experimentsScanned} experiments, derived ${result.opportunities} opportunities${unavailable}`,
                experimentsScanned: result.experimentsScanned,
                opportunities: result.opportunities,
            });
        }),
};
