/**
 * Shared business logic for the `axctl improve` mutations. Phase C10
 * needed accept/reject/verdict callable from both the CLI handler and the
 * dashboard HTTP endpoint, so the SurrealQL + scaffold orchestration lives
 * here in one place. Each function takes the proposal's `dedupe_sig`
 * (preferred) or full record id and returns a structured result the caller
 * (CLI or HTTP) can render however it likes.
 */

import { Effect } from "effect";
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import { recordRef, surrealString } from "../lib/shared/surql.ts";
import { surrealLiteral } from "../lib/json.ts";
import { recordKeyPart } from "../lib/shared/derive-keys.ts";
import {
    type InterventionSafetyContract,
    PROPOSAL_STATUS_ACCEPTED,
    PROPOSAL_STATUS_REJECTED,
    planAcceptCandidate,
    planLockVerdict,
    planRejectCandidate,
} from "./lifecycle.ts";
import { scaffoldSkill, type ScaffoldResult } from "./skill-scaffold.ts";
import { renderTaskFile, type TaskInput } from "./task-template.ts";

export type ImproveActionStatus =
    | "ok"
    | "not_found"
    | "wrong_status"
    | "unsupported_form"
    | "missing_payload"
    | "scaffold_exists"
    | "verdict_locked"
    | "invalid_verdict";

export interface AcceptResult {
    readonly status: ImproveActionStatus;
    readonly proposal_id?: string;
    readonly experiment_id?: string;
    readonly artifact_path?: string;
    readonly task_path?: string;
    readonly existing_experiment?: {
        readonly id: string;
        readonly artifact_path: string | null;
        readonly scaffolded_at: string | null;
        readonly locked_verdict: string | null;
    };
    readonly message?: string;
    /** Populated only when autoScaffold=true so callers can drive --with-agent enrichment. */
    readonly proposal?: {
        readonly title: string;
        readonly hypothesis: string;
        readonly triggerPattern: string | null;
        readonly proposedBehavior: string;
        readonly baseline: string | null;
    };
}

export interface RejectResult {
    readonly status: ImproveActionStatus;
    readonly proposal_id?: string;
    readonly reason?: string;
    readonly message?: string;
}

export interface VerdictResult {
    readonly status: ImproveActionStatus;
    readonly experiment_id?: string;
    readonly verdict?: string;
    readonly message?: string;
}

interface ProposalRow {
    readonly id: string | { tb: string; id: string };
    readonly form: string;
    readonly title: string;
    readonly hypothesis: string;
    readonly dedupe_sig: string;
    readonly status: string;
    readonly skill_payload?: Record<string, unknown> | null;
}

interface FullProposalRow extends ProposalRow {
    readonly subagent_payload?: {
        readonly bounded_role?: string | null;
        readonly delegation_trigger?: string | null;
        readonly example_task_patterns?: readonly string[] | null;
    } | null;
    readonly guidance_payload?: {
        readonly file_target?: string | null;
        readonly section?: string | null;
        readonly suggested_text?: string | null;
    } | null;
    readonly hook_payload?: {
        readonly event_name?: string | null;
        readonly target_tool?: string | null;
        readonly hook_command?: string | null;
        readonly recovery_path?: string | null;
        readonly smoke_test_command?: string | null;
        readonly disable_command?: string | null;
        readonly failure_mode?: string | null;
    } | null;
    readonly automation_payload?: {
        readonly trigger_signal?: string | null;
        readonly schedule?: string | null;
        readonly action?: string | null;
        readonly recovery_path?: string | null;
        readonly smoke_test_command?: string | null;
        readonly disable_command?: string | null;
        readonly failure_mode?: string | null;
    } | null;
}

// scaffoldSkill can throw on filesystem errors. Wrapping the try/catch here
// keeps acceptProposal's Effect.gen body free of try/catch (matches the lint
// rule tryCatchInEffectGen enforced on main).
function trySafeScaffold(
    row: ProposalRow,
    payload: NonNullable<ProposalRow["skill_payload"]>,
    opts: AcceptOptions,
): { result: ScaffoldResult } | { error: string } {
    try {
        const result = scaffoldSkill({
            input: {
                title: row.title,
                hypothesis: row.hypothesis,
                proposedBehavior: String(payload.proposed_behavior ?? ""),
                triggerPattern: payload.trigger_pattern == null ? null : String(payload.trigger_pattern),
                expectedImpact: payload.expected_impact == null ? null : String(payload.expected_impact),
                dedupeSig: row.dedupe_sig,
                nowIso: new Date().toISOString(),
            },
            ...(opts.scaffoldBaseDir === undefined ? {} : { baseDir: opts.scaffoldBaseDir }),
            ...(opts.force === undefined ? {} : { force: opts.force }),
        });
        return { result };
    } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
    }
}

const fetchFullProposal = (idLiteral: string) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const result = yield* db.query<[FullProposalRow[]]>(
            `SELECT *,
                (SELECT * FROM skill_proposal WHERE proposal = $parent.id LIMIT 1)[0] AS skill_payload,
                (SELECT * FROM subagent_proposal WHERE proposal = $parent.id LIMIT 1)[0] AS subagent_payload,
                (SELECT * FROM guidance_proposal WHERE proposal = $parent.id LIMIT 1)[0] AS guidance_payload,
                (SELECT * FROM hook_proposal WHERE proposal = $parent.id LIMIT 1)[0] AS hook_payload,
                (SELECT * FROM automation_proposal WHERE proposal = $parent.id LIMIT 1)[0] AS automation_payload
            FROM proposal WHERE dedupe_sig = ${idLiteral} OR id = ${idLiteral} LIMIT 1;`,
        );
        return (result?.[0] ?? [])[0] ?? null;
    });

/** Default directory for .ax/tasks/ task brief files. */
const defaultTaskDir = (): string =>
    process.env.AX_TASK_DIR ?? join(process.cwd(), ".ax", "tasks");

/**
 * Map a full proposal row + experimentId to a TaskInput for renderTaskFile.
 */
const buildTaskInput = (row: FullProposalRow, experimentId: string): TaskInput => {
    const shortId = row.dedupe_sig;
    const proposalId = `proposal:${recordKeyPart(row.id, "proposal") ?? row.dedupe_sig}`;
    if (row.form === "guidance") {
        return {
            form: "guidance",
            experimentId,
            proposalId,
            shortId,
            title: row.title,
            targetPath: row.guidance_payload?.file_target ?? "~/.claude/CLAUDE.md",
            section: row.guidance_payload?.section ?? null,
            suggestedBody: row.guidance_payload?.suggested_text ?? row.hypothesis,
            proposedBehavior: null,
            confidence: "medium",
            frequency: 0,
            evidence: row.hypothesis,
        };
    }
    if (row.form === "subagent") {
        return {
            form: "subagent",
            experimentId,
            proposalId,
            shortId,
            title: row.title,
            targetPath: `~/.claude/agents/${row.dedupe_sig}.md`,
            section: null,
            suggestedBody: [
                row.subagent_payload?.bounded_role ? `Role: ${row.subagent_payload.bounded_role}` : null,
                row.subagent_payload?.delegation_trigger ? `Delegation trigger: ${row.subagent_payload.delegation_trigger}` : null,
                row.hypothesis,
            ].filter((line): line is string => line !== null).join("\n\n"),
            proposedBehavior: null,
            confidence: "medium",
            frequency: 0,
            evidence: row.hypothesis,
        };
    }
    if (row.form === "hook") {
        return {
            form: "hook",
            experimentId,
            proposalId,
            shortId,
            title: row.title,
            targetPath: "~/.claude/settings.json",
            section: row.hook_payload?.event_name ?? "PreToolUse",
            suggestedBody: row.hook_payload?.hook_command ?? `see proposal: ${row.dedupe_sig}`,
            proposedBehavior: row.hook_payload?.target_tool ?? null,
            confidence: "medium",
            frequency: 0,
            evidence: row.hypothesis,
            safety: safetyContractFromPayload(row.hook_payload),
        };
    }
    if (row.form === "automation") {
        return {
            form: "automation",
            experimentId,
            proposalId,
            shortId,
            title: row.title,
            targetPath: `.ax/interventions/${row.dedupe_sig}/AUTOMATION.md`,
            section: row.automation_payload?.schedule ?? null,
            suggestedBody: row.automation_payload?.action ?? `see proposal: ${row.dedupe_sig}`,
            proposedBehavior: row.automation_payload?.trigger_signal ?? null,
            confidence: "medium",
            frequency: 0,
            evidence: row.hypothesis,
            safety: safetyContractFromPayload(row.automation_payload),
        };
    }
    // skill form
    return {
        form: "skill",
        experimentId,
        proposalId,
        shortId,
        title: row.title,
        targetPath: `~/.claude/skills/${row.dedupe_sig}/SKILL.md`,
        section: null,
        suggestedBody: "",
        proposedBehavior: String(row.skill_payload?.proposed_behavior ?? ""),
        confidence: "medium",
        frequency: 0,
        evidence: row.hypothesis,
    };
};

const safetyContractFromPayload = (
    payload: {
        readonly recovery_path?: string | null;
        readonly smoke_test_command?: string | null;
        readonly disable_command?: string | null;
        readonly failure_mode?: string | null;
    } | null | undefined,
): InterventionSafetyContract => ({
    recoveryPath: payload?.recovery_path ?? null,
    smokeTestCommand: payload?.smoke_test_command ?? null,
    disableCommand: payload?.disable_command ?? null,
    failureMode: payload?.failure_mode ?? null,
});

export interface AcceptOptions {
    readonly sigOrId: string;
    readonly force?: boolean;
    readonly autoScaffold?: boolean;     // skill form only - preserves existing direct-write path
    readonly scaffoldBaseDir?: string;   // forwarded to scaffoldSkill when autoScaffold=true
    readonly taskDir?: string;           // override .ax/tasks/ output dir
}

// ---------------------------------------------------------------------------
// Safety helpers
// ---------------------------------------------------------------------------

const SAFE_SIG = /^[a-z0-9_-]+$/i;

const validateSig = (sig: string): void => {
    if (!SAFE_SIG.test(sig)) {
        throw new Error(`unsafe dedupe_sig for filename: ${sig.slice(0, 40)}...`);
    }
};

// Disambiguates same-millisecond acceptProposal calls within a process run.
// Cross-process collisions for the same proposal are not a concern because
// acceptProposal is short-lived and proposalKey is content-derived.
const KEY_COUNTER = (() => {
    let i = 0;
    return () => (++i).toString(36);
})();

export const acceptProposal = (
    opts: AcceptOptions,
): Effect.Effect<AcceptResult, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const idLiteral = surrealLiteral(opts.sigOrId);
        const row = yield* fetchFullProposal(idLiteral);
        if (!row) return { status: "not_found", message: `no proposal matched ${opts.sigOrId}` };
        const proposalKey = recordKeyPart(row.id, "proposal");
        if (!proposalKey) {
            return { status: "not_found", message: "proposal.id has unexpected shape" };
        }
        const acceptPlan = planAcceptCandidate({
            form: row.form,
            proposalStatus: row.status,
            autoScaffold: Boolean(opts.autoScaffold),
            safetyContract: row.form === "hook"
                ? safetyContractFromPayload(row.hook_payload)
                : row.form === "automation"
                    ? safetyContractFromPayload(row.automation_payload)
                    : null,
        });
        if (acceptPlan.status === "wrong_status") {
            const db = yield* SurrealClient;
            const existingResult = yield* db.query<[Array<Record<string, unknown>>]>(
                `SELECT id, artifact_path, type::string(scaffolded_at) AS scaffolded_at, locked_verdict FROM experiment WHERE proposal = ${recordRef("proposal", proposalKey)} LIMIT 1;`,
            );
            const existing = (existingResult?.[0] ?? [])[0];
            const result: AcceptResult = {
                status: "wrong_status",
                message: acceptPlan.message,
            };
            if (existing) {
                return {
                    ...result,
                    existing_experiment: {
                        id: String(existing.id ?? ""),
                        artifact_path: existing.artifact_path === null ? null : String(existing.artifact_path ?? ""),
                        scaffolded_at: existing.scaffolded_at === null ? null : String(existing.scaffolded_at ?? ""),
                        locked_verdict: existing.locked_verdict === null ? null : String(existing.locked_verdict ?? ""),
                    },
                };
            }
            return result;
        }
        if (acceptPlan.status !== "ok") {
            return {
                status: acceptPlan.status,
                message: acceptPlan.message,
            };
        }
        const experimentStatus = acceptPlan.experimentStatus;

        const experimentKey = `${proposalKey}__${Date.now().toString(36)}_${KEY_COUNTER()}`;
        const experimentId = `experiment:${experimentKey}`;
        const db = yield* SurrealClient;

        // autoScaffold=true && form=skill: legacy direct-write path
        if (opts.autoScaffold && row.form === "skill") {
            validateSig(row.dedupe_sig);
            const payload = row.skill_payload ?? null;
            if (!payload) {
                return { status: "missing_payload", message: "skill_proposal payload missing" };
            }
            const scaffoldOutcome = trySafeScaffold(row, payload, opts);
            if ("error" in scaffoldOutcome) {
                return {
                    status: "missing_payload",
                    message: `scaffold failed: ${scaffoldOutcome.error}`,
                };
            }
            const scaffold: ScaffoldResult = scaffoldOutcome.result;
            if (scaffold.skipped) {
                return {
                    status: "scaffold_exists",
                    message: `existing scaffold at ${scaffold.path} (pass force=true to overwrite)`,
                    artifact_path: scaffold.path,
                };
            }
            yield* db.query(`
                UPDATE ${recordRef("proposal", proposalKey)} SET status = '${PROPOSAL_STATUS_ACCEPTED}', updated_at = time::now();
                UPSERT ${recordRef("experiment", experimentKey)} MERGE {
                    proposal: ${recordRef("proposal", proposalKey)},
                    artifact_path: ${surrealLiteral(scaffold.path)},
                    scaffolded_at: time::now(),
                    status: '${experimentStatus}'
                };
            `);
            return {
                status: "ok",
                proposal_id: `proposal:${proposalKey}`,
                experiment_id: experimentId,
                artifact_path: scaffold.path,
                proposal: {
                    title: row.title,
                    hypothesis: row.hypothesis,
                    triggerPattern: payload.trigger_pattern == null ? null : String(payload.trigger_pattern),
                    proposedBehavior: String(payload.proposed_behavior ?? ""),
                    baseline: typeof (row as unknown as Record<string, unknown>).baseline === "string"
                        ? String((row as unknown as Record<string, unknown>).baseline)
                        : null,
                },
            };
        }

        // Default path for all v0 forms: emit .ax/tasks/<dedupe_sig>.md
        validateSig(row.dedupe_sig);
        const taskDir = opts.taskDir ?? defaultTaskDir();
        const taskPath = join(taskDir, `${row.dedupe_sig}.md`);

        if (existsSync(taskPath) && !opts.force) {
            return {
                status: "scaffold_exists",
                message: `task brief already exists at ${taskPath} (pass force=true to overwrite)`,
                task_path: taskPath,
            };
        }

        const taskInput = buildTaskInput(row, experimentId);
        const taskContent = renderTaskFile(taskInput);

        mkdirSync(taskDir, { recursive: true });
        // Atomic write: stage content in a temp file first, commit to final path only
        // after the DB update succeeds. This avoids orphan task files when the DB
        // query fails after the write.
        const tmpPath = `${taskPath}.tmp.${process.pid}`;
        writeFileSync(tmpPath, taskContent, { encoding: "utf-8" });

        yield* db.query(`
            UPDATE ${recordRef("proposal", proposalKey)} SET status = '${PROPOSAL_STATUS_ACCEPTED}', updated_at = time::now();
            UPSERT ${recordRef("experiment", experimentKey)} MERGE {
                proposal: ${recordRef("proposal", proposalKey)},
                task_path: ${surrealLiteral(taskPath)},
                status: '${experimentStatus}'
            };
        `).pipe(
            Effect.tapError(() => Effect.sync(() => {
                try { unlinkSync(tmpPath); } catch { /* best-effort */ }
            })),
        );

        renameSync(tmpPath, taskPath);

        return {
            status: "ok",
            proposal_id: `proposal:${proposalKey}`,
            experiment_id: experimentId,
            task_path: taskPath,
        };
    });

export interface RejectOptions {
    readonly sigOrId: string;
    readonly reason?: string;
}

export const rejectProposal = (
    opts: RejectOptions,
): Effect.Effect<RejectResult, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const idLiteral = surrealLiteral(opts.sigOrId);
        const row = yield* fetchFullProposal(idLiteral);
        if (!row) return { status: "not_found", message: `no proposal matched ${opts.sigOrId}` };
        const rejectPlan = planRejectCandidate({
            proposalStatus: row.status,
            ...(opts.reason === undefined ? {} : { reason: opts.reason }),
        });
        if (rejectPlan.status === "wrong_status") {
            return { status: "wrong_status", message: rejectPlan.message };
        }
        const proposalKey = recordKeyPart(row.id, "proposal");
        if (!proposalKey) return { status: "not_found", message: "proposal.id unexpected" };
        const db = yield* SurrealClient;
        yield* db.query(
            `UPDATE ${recordRef("proposal", proposalKey)} SET status = '${PROPOSAL_STATUS_REJECTED}', reject_reason = ${surrealString(rejectPlan.reason)}, updated_at = time::now();`,
        );
        return {
            status: "ok",
            proposal_id: `proposal:${proposalKey}`,
            reason: rejectPlan.reason,
        };
    });

export interface SetVerdictOptions {
    readonly sigOrId: string;
    readonly verdict: string;
}

export const setVerdict = (
    opts: SetVerdictOptions,
): Effect.Effect<VerdictResult, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const verdictPlan = planLockVerdict({
            requestedVerdict: opts.verdict,
            lockedVerdict: null,
        });
        if (verdictPlan.status === "invalid_verdict") {
            return {
                status: "invalid_verdict",
                message: verdictPlan.message,
            };
        }
        const idLiteral = surrealLiteral(opts.sigOrId);
        const db = yield* SurrealClient;
        const result = yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT id, locked_verdict, (SELECT id FROM checkpoint WHERE experiment = $parent.id ORDER BY observed_at DESC LIMIT 1)[0].id AS latest_checkpoint
            FROM experiment WHERE proposal.dedupe_sig = ${idLiteral} OR id = ${idLiteral} LIMIT 1;`,
        );
        const row = (result?.[0] ?? [])[0];
        if (!row) {
            return { status: "not_found", message: `no experiment matched ${opts.sigOrId}` };
        }
        const lockPlan = planLockVerdict({
            requestedVerdict: opts.verdict,
            lockedVerdict: row.locked_verdict == null ? null : String(row.locked_verdict),
        });
        if (lockPlan.status !== "ok") {
            return { status: lockPlan.status, message: lockPlan.message };
        }
        const lockedVerdict = lockPlan.verdict;
        const experimentId = String(row.id ?? "");
        const stmts = [`UPDATE ${experimentId} SET locked_verdict = ${surrealString(lockedVerdict)};`];
        const latestCp = row.latest_checkpoint;
        if (latestCp) {
            stmts.push(`UPDATE ${String(latestCp)} SET user_verdict = ${surrealString(lockedVerdict)};`);
        }
        yield* db.query(stmts.join(""));
        return { status: "ok", experiment_id: experimentId, verdict: lockedVerdict };
    });
