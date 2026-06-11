/**
 * `ax retro plan` - register an improvement skeleton coming FROM an
 * external AI agent that just walked `ax retro meta`. The agent has
 * already:
 *   1. read the meta snapshot,
 *   2. reasoned about a candidate improvement (skill / hook / guidance /
 *      automation) with the user,
 *   3. written a plan doc to disk (markdown),
 *   4. gotten explicit user yes.
 *
 * This command takes that approved plan and inserts:
 *   - a `proposal` row (`guidance` / `skill` can be accepted immediately;
 *     `hook` / `automation` stay open until their safety model exists)
 *   - the matching per-form payload row (skill_proposal /
 *     guidance_proposal / hook_proposal / automation_proposal)
 *   - for accepted forms, an `experiment` row pointing at `--plan-path`
 *     (no on-disk scaffold; the plan markdown IS the artifact for the
 *     meta-retro path)
 *
 * The `cites_evidence` edge table doesn't include `retro` in its TO
 * union, so `--evidence-retros=<ids>` is embedded into `proposal.baseline`
 * JSON (same approach derive-retro-proposals.ts uses) rather than as
 * relations.
 */

import { Effect, FileSystem } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { prettyPrint } from "@ax/lib/json";
import {
    recordRef,
    surrealObject,
    surrealOptionString,
    surrealString,
} from "@ax/lib/shared/surql";
import { safeKeyPart } from "@ax/lib/shared/derive-keys";
import { fail as sharedFail, parseCsvFlag } from "./commands/shared.ts";
import { dedupeSig, normalizeTitle } from "../ingest/derive-proposals.ts";
import {
    type InterventionSafetyContract,
    planRetroPlanRegistration,
    type RetroPlanRegistrationPlan,
    validateInterventionFailureMode,
} from "../improve/lifecycle.ts";

export type PlanForm = "skill" | "hook" | "guidance" | "automation";

export interface RetroPlanArgs {
    readonly slug: string;
    readonly form: PlanForm;
    readonly title: string;
    readonly hypothesis: string;
    readonly planPath: string;
    readonly evidenceRetros: readonly string[];
    readonly artifactPath: string | null;
    readonly confidence: "low" | "medium" | "high";
    readonly frequency: number;
    readonly json: boolean;
    readonly safety: InterventionSafetyContract;
    /**
     * When true, register the proposal with status='open' and DO NOT create
     * an experiment row. Lets external agents compose with
     * `ax improve accept --with-agent` afterwards. Even without --leave-open,
     * unsafe forms (hook / automation) stay open until Recovery Path and
     * disable semantics are modeled.
     */
    readonly leaveOpen: boolean;
}

const ALLOWED_FORMS = new Set<PlanForm>([
    "skill",
    "hook",
    "guidance",
    "automation",
]);

const ALLOWED_CONFIDENCE = new Set(["low", "medium", "high"]);

const flagValue = (args: string[], name: string): string | undefined => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit?.split("=").slice(1).join("=");
};

const fail = (message: string): never => sharedFail(`ax retro plan: ${message}`);

/**
 * Parse the CLI argv into a validated RetroPlanArgs. Throws (via
 * `process.exit(2)`) on missing required flags. Pure aside from the
 * filesystem check on plan-path - kept in the parser so the error path
 * is uniform.
 */
export const parseRetroPlanArgs = (
    argv: readonly string[],
    // `checkPlanPath` is accepted for backwards-compatible call sites. The
    // plan-path existence probe now lives in `cmdRetroPlan` (it needs the
    // injected FileSystem); this pure parser does no I/O.
    _options: { readonly checkPlanPath?: boolean } = { checkPlanPath: true },
): RetroPlanArgs => {
    const args = [...argv];
    const slug = flagValue(args, "slug");
    const form = flagValue(args, "form");
    const title = flagValue(args, "title");
    const hypothesis = flagValue(args, "hypothesis");
    const planPath = flagValue(args, "plan-path");
    const evidenceRaw = flagValue(args, "evidence-retros") ?? "";
    const artifactPath = flagValue(args, "artifact-path") ?? null;
    const confidenceRaw = (flagValue(args, "confidence") ?? "medium").toLowerCase();
    const frequencyRaw = flagValue(args, "frequency") ?? "1";
    const json = args.includes("--json");
    const leaveOpen = args.includes("--leave-open");
    const safety: InterventionSafetyContract = {
        recoveryPath: flagValue(args, "recovery-path") ?? null,
        smokeTestCommand: flagValue(args, "smoke-test-command") ?? null,
        disableCommand: flagValue(args, "disable-command") ?? null,
        failureMode: flagValue(args, "failure-mode") ?? null,
    };

    if (!slug) fail("--slug is required");
    if (!form) fail("--form is required (skill|hook|guidance|automation)");
    if (!ALLOWED_FORMS.has(form as PlanForm)) {
        fail(`--form must be one of: skill, hook, guidance, automation (got ${form})`);
    }
    if (!title) fail("--title is required");
    if (!hypothesis) fail("--hypothesis is required");
    if (!planPath) fail("--plan-path is required");
    if (!ALLOWED_CONFIDENCE.has(confidenceRaw)) {
        fail(`--confidence must be one of: low, medium, high (got ${confidenceRaw})`);
    }
    if (safety.failureMode !== null && !validateInterventionFailureMode(safety.failureMode)) {
        fail("--failure-mode must be one of: fail_open, fail_closed");
    }
    const frequency = Math.max(1, Math.floor(Number(frequencyRaw)));
    if (!Number.isFinite(frequency) || frequency <= 0) {
        fail(`--frequency must be a positive integer (got ${frequencyRaw})`);
    }
    const evidenceRetros = parseCsvFlag(evidenceRaw);

    return {
        slug: slug as string,
        form: form as PlanForm,
        title: title as string,
        hypothesis: hypothesis as string,
        planPath: planPath as string,
        evidenceRetros,
        artifactPath,
        confidence: confidenceRaw as "low" | "medium" | "high",
        frequency,
        json,
        safety,
        leaveOpen,
    };
};

const proposalKeyFor = (slug: string, sig: string): string =>
    `retro_meta__${safeKeyPart(slug).slice(0, 40)}__${sig.slice(-12)}`;

export interface PlanBuildResult {
    readonly proposalKey: string;
    /**
     * Experiment key derived from proposalKey + nowMs. NULL when
     * args.leaveOpen is set - no experiment row is created in that mode.
     */
    readonly experimentKey: string | null;
    readonly proposalStatus: RetroPlanRegistrationPlan["proposalStatus"];
    readonly experimentStatus: RetroPlanRegistrationPlan["experimentStatus"];
    readonly safetyMessage: string | null;
    readonly sig: string;
    readonly statements: readonly string[];
}

/**
 * Pure builder: turn validated args into the SurrealQL statements that
 * insert proposal + per-form payload + experiment. Kept pure so the
 * test file can assert on the SQL shape without a DB.
 *
 * cites_evidence edges to retro records are intentionally NOT emitted -
 * the schema's `cites_evidence TO` union does not yet include `retro`.
 * Provenance is captured inside `proposal.baseline` JSON.
 */
export const buildRetroPlanStatements = (
    args: RetroPlanArgs,
    nowMs: number = Date.now(),
): PlanBuildResult => {
    const normTitle = normalizeTitle(args.title);
    const sig = dedupeSig(args.form, normTitle);
    const proposalKey = proposalKeyFor(args.slug, sig);
    const registration = planRetroPlanRegistration({
        form: args.form,
        leaveOpen: args.leaveOpen,
        safetyContract: args.safety,
    });
    const experimentKey = registration.createExperiment ? `${proposalKey}__${nowMs.toString(36)}` : null;

    const proposalRef = recordRef("proposal", proposalKey);

    // Embed frequency snapshot into baseline so the checkpoint verdict math
    // (current_frequency vs baseline.frequency) has a fixed reference point
    // even after derive-retro-proposals re-counts on later passes.
    const baseline = JSON.stringify({
        source: "retro_meta_plan",
        slug: args.slug,
        plan_path: args.planPath,
        evidence_retros: args.evidenceRetros,
        frequency: args.frequency,
    });

    const statements: string[] = [];

    statements.push(
        `CREATE ${proposalRef} CONTENT ${surrealObject([
            ["form", surrealString(args.form)],
            ["title", surrealString(args.title)],
            ["hypothesis", surrealString(args.hypothesis)],
            ["dedupe_sig", surrealString(sig)],
            ["frequency", String(args.frequency)],
            ["confidence", surrealString(args.confidence)],
            ["status", surrealString(registration.proposalStatus)],
            ["baseline", surrealOptionString(baseline)],
            ["updated_at", "time::now()"],
        ])};`,
    );

    const payloadRef = recordRef(`${args.form}_proposal`, proposalKey);
    if (args.form === "skill") {
        statements.push(
            `CREATE ${payloadRef} CONTENT ${surrealObject([
                ["proposal", proposalRef],
                ["trigger_pattern", surrealString(`retro_meta·slug=${args.slug}`)],
                ["suspected_gap", surrealString(args.hypothesis)],
                ["proposed_behavior", surrealString(`see plan: ${args.planPath}`)],
                ["expected_impact", surrealOptionString(null)],
            ])};`,
        );
    } else if (args.form === "guidance") {
        statements.push(
            `CREATE ${payloadRef} CONTENT ${surrealObject([
                ["proposal", proposalRef],
                ["file_target", surrealString("CLAUDE.md")],
                ["section", surrealOptionString(null)],
                ["suggested_text", surrealString(`see plan: ${args.planPath}`)],
            ])};`,
        );
    } else if (args.form === "hook") {
        statements.push(
            `CREATE ${payloadRef} CONTENT ${surrealObject([
                ["proposal", proposalRef],
                ["event_name", surrealString("PreToolUse")],
                ["target_tool", surrealOptionString(null)],
                ["hook_command", surrealString(`see plan: ${args.planPath}`)],
                ["recovery_path", surrealOptionString(args.safety.recoveryPath ?? null)],
                ["smoke_test_command", surrealOptionString(args.safety.smokeTestCommand ?? null)],
                ["disable_command", surrealOptionString(args.safety.disableCommand ?? null)],
                ["failure_mode", surrealOptionString(args.safety.failureMode ?? null)],
            ])};`,
        );
    } else {
        // automation
        statements.push(
            `CREATE ${payloadRef} CONTENT ${surrealObject([
                ["proposal", proposalRef],
                ["trigger_signal", surrealString(`retro_meta·slug=${args.slug}`)],
                ["schedule", surrealOptionString(null)],
                ["action", surrealString(`see plan: ${args.planPath}`)],
                ["recovery_path", surrealOptionString(args.safety.recoveryPath ?? null)],
                ["smoke_test_command", surrealOptionString(args.safety.smokeTestCommand ?? null)],
                ["disable_command", surrealOptionString(args.safety.disableCommand ?? null)],
                ["failure_mode", surrealOptionString(args.safety.failureMode ?? null)],
            ])};`,
        );
    }

    if (experimentKey !== null) {
        const experimentRef = recordRef("experiment", experimentKey);
        statements.push(
            `CREATE ${experimentRef} CONTENT ${surrealObject([
                ["proposal", proposalRef],
                ["artifact_path", surrealString(args.artifactPath ?? args.planPath)],
                ["scaffolded_at", "time::now()"],
                ["status", surrealString(registration.experimentStatus ?? "scaffolded")],
            ])};`,
        );
    }

    return {
        proposalKey,
        experimentKey,
        proposalStatus: registration.proposalStatus,
        experimentStatus: registration.experimentStatus,
        safetyMessage: registration.safetyMessage,
        sig,
        statements,
    };
};

export const cmdRetroPlan = (
    args: string[],
): Effect.Effect<void, DbError, SurrealClient | FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const parsed = parseRetroPlanArgs(args, { checkPlanPath: false });
        // Plan-path existence probe (moved out of the pure parser): a missing or
        // unreadable file fails the command, matching the original existsSync guard.
        const planExists = yield* fs.exists(parsed.planPath).pipe(orAbsent(false));
        if (!planExists) {
            fail(`--plan-path file not found: ${parsed.planPath}`);
        }
        const built = buildRetroPlanStatements(parsed);

        const db = yield* SurrealClient;

        const existing = yield* db.query<[Array<{ id: unknown; dedupe_sig: string }>]>(
            `SELECT id, dedupe_sig FROM proposal WHERE dedupe_sig = ${surrealString(built.sig)} LIMIT 1;`,
        );
        const hit = (existing?.[0] ?? [])[0];
        if (hit) {
            const existingId = typeof hit.id === "string"
                ? hit.id
                : `proposal:${(hit.id as { id?: string })?.id ?? ""}`;
            console.error(
                `ax retro plan: proposal with dedupe_sig ${built.sig} already exists (${existingId}); refusing to overwrite`,
            );
            process.exit(3);
        }

        yield* db.query(built.statements.join("\n"));

        if (parsed.json || !process.stdout.isTTY) {
            console.log(prettyPrint({
                proposal_id: `proposal:${built.proposalKey}`,
                ...(built.experimentKey === null ? {} : { experiment_id: `experiment:${built.experimentKey}` }),
                dedupe_sig: built.sig,
                form: parsed.form,
                status: built.proposalStatus,
                ...(built.safetyMessage === null ? {} : { message: built.safetyMessage }),
            }));
        } else if (built.experimentKey === null) {
            console.log(
                `proposal proposal:${built.proposalKey} created (status=open) - ${built.safetyMessage ?? `run \`ax improve accept --with-agent ${built.sig}\` to scaffold + enrich`}`,
            );
        } else {
            console.log(`proposal proposal:${built.proposalKey} created (status=accepted)`);
            console.log(`experiment experiment:${built.experimentKey} created (artifact_path=${parsed.artifactPath ?? parsed.planPath})`);
        }
    });
