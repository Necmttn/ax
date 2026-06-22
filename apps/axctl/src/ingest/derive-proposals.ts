/**
 * Derive-Proposals Stage: turns evidence rows into proposal shortlist rows.
 *
 * Reads skill_candidate (populated by the closure stage) + the skill catalog
 * (to dedupe against existing skills) and writes:
 *   - proposal              (polymorphic shortlist, form=skill)
 *   - skill_proposal        (typed form payload)
 *   - cites_evidence edges  (proposal -> source skill_candidate)
 *
 * C1 scope: skill form only. subagent/hook/guidance/automation forms land
 * in later C1.x commits as their evidence detectors come online.
 *
 * Dedupe: dedupe_sig = hash(form + normalized title) - UNIQUE index on
 * proposal.dedupe_sig prevents the same trigger pattern producing two
 * proposals across re-derive runs.
 *
 * Baseline freezing (post-review fix): the proposal's `baseline` JSON is
 * captured ONLY on first creation. Subsequent re-derive runs UPDATE the
 * mutable fields (frequency, confidence, hypothesis, updated_at) but never
 * touch `baseline` or `status`. This honors the plan's "frozen at
 * created_at, not accept-time" decision so the verdict layer (C6) can
 * compute friction_delta against a stable reference point.
 */

import { Effect, FileSystem, Path, Schema } from "effect";
import { jsonRecordField } from "@ax/lib/decode";
import { SurrealClient } from "@ax/lib/db";
import { AppLayer } from "@ax/lib/layers";
import type { DbError } from "@ax/lib/errors";
import {
    recordRef,
    surrealObject,
    surrealOptionString,
    surrealString,
} from "@ax/lib/shared/surql";
import { executeStatementsWith } from "@ax/lib/shared/statement-exec";
import { safeKeyPart, recordKeyPart } from "@ax/lib/shared/derive-keys";
import type { HarnessLearningCandidate } from "../project/types.ts";
import { fetchDispatchCandidates } from "../queries/dispatch-analytics.ts";
import { fetchImageContext, type ImageContextResult } from "../queries/image-context.ts";
import { deriveDirectiveCandidates, scoreDirectiveCandidates, type DirectiveCandidate, type DirectiveTurnRow } from "./directives.ts";

export interface DeriveProposalsStats {
    readonly skillProposals: number;
    readonly guidanceProposals: number;
    readonly routingProposals: number;
    readonly imageContextProposals: number;
    readonly directiveProposals: number;
    readonly skipped: number;
}

/**
 * Phase C11: convert each HarnessLearningCandidate into a guidance-form
 * proposal. The harness report's learning candidates are the
 * project-doctor-derived "you should add a guardrail" suggestions. They flow
 * into the proposal pipeline as form='guidance', deduped by hash of normalized
 * title.
 */
export interface GuidanceProposalRow {
    readonly proposalKey: string;
    readonly title: string;
    readonly hypothesis: string;
    readonly fileTarget: string;
    readonly section: string;
    readonly suggestedText: string;
    readonly confidence: string;
    readonly frequency: number;
    readonly sig: string;
    readonly evidenceSummary: ReadonlyArray<string>;
}

export const deriveGuidanceProposalRows = (
    candidates: ReadonlyArray<HarnessLearningCandidate>,
): { readonly rows: GuidanceProposalRow[]; readonly skipped: number } => {
    const rows: GuidanceProposalRow[] = [];
    let skipped = 0;
    const seenSigs = new Set<string>();
    for (const c of candidates) {
        if (!c.title || !c.problem) { skipped += 1; continue; }
        const normTitle = normalizeTitle(c.title);
        const sig = dedupeSig("guidance", normTitle);
        if (seenSigs.has(sig)) { skipped += 1; continue; }
        seenSigs.add(sig);
        // Frequency proxy: evidence-summary count + risk-level boost.
        // (Harness-derived candidates don't have a real recurrence count
        // - they're snapshot signals - so we synthesize one.)
        const riskBoost = c.risk.level === "high" ? 3 : c.risk.level === "medium" ? 2 : 1;
        const frequency = Math.max(1, c.evidenceSummary.length) + riskBoost;
        rows.push({
            proposalKey: proposalKeyFor("guidance", c.title, sig),
            title: c.title,
            hypothesis: c.problem,
            fileTarget: defaultGuidanceTargetFor(c.harnessLayer),
            section: c.harnessLayer,
            suggestedText: c.suggestedIntervention || c.pattern,
            confidence: c.confidence,
            frequency,
            sig,
            evidenceSummary: c.evidenceSummary,
        });
    }
    return { rows, skipped };
};

const defaultGuidanceTargetFor = (layer: string): string => {
    // Project-level harness candidates land in AGENTS.md / CLAUDE.md.
    // The user can move them; this is just a hint for the scaffold.
    if (layer === "boundary" || layer === "verification") return "CLAUDE.md";
    return "AGENTS.md";
};

// ---------------------------------------------------------------------------
// Directive proposals (form='guidance') - v1 MVP of directive mining.
// Proactive standing-instruction user turns (detector in directives.ts) become
// guidance proposals via the existing pipeline. Recurrence = how many times the
// user restated the same directive (the frequency the verdict layer measures).
// Spec: docs/superpowers/specs/2026-06-17-directive-mining-design.md §0.1.
// ---------------------------------------------------------------------------

const DIRECTIVE_TITLE_MAX = 90;
const DIRECTIVE_PROPOSAL_LIMIT = 12;

const directiveTitle = (text: string): string => {
    const oneLine = text.replace(/\s+/g, " ").trim();
    const clipped = oneLine.length > DIRECTIVE_TITLE_MAX
        ? `${oneLine.slice(0, DIRECTIVE_TITLE_MAX - 1)}…`
        : oneLine;
    return `Directive: ${clipped}`;
};

export const deriveDirectiveProposalRows = (
    candidates: ReadonlyArray<DirectiveCandidate>,
    opts: { readonly minFrequency?: number; readonly limit?: number } = {},
): { readonly rows: GuidanceProposalRow[]; readonly skipped: number } => {
    const minFrequency = opts.minFrequency ?? 1;
    const limit = opts.limit ?? DIRECTIVE_PROPOSAL_LIMIT;

    // Group by normalized title so an identically-worded directive restated
    // across turns/sessions accumulates frequency (the recurrence signal).
    const groups = new Map<string, {
        title: string; pattern: string; freq: number; lastTs: string; turnKeys: string[];
    }>();
    for (const c of candidates) {
        const title = directiveTitle(c.text);
        const key = normalizeTitle(title);
        const g = groups.get(key);
        if (g) {
            g.freq += 1;
            if (c.ts > g.lastTs) g.lastTs = c.ts;
            if (g.turnKeys.length < 5) g.turnKeys.push(c.turnKey);
        } else {
            groups.set(key, { title, pattern: c.pattern, freq: 1, lastTs: c.ts, turnKeys: [c.turnKey] });
        }
    }

    let skipped = 0;
    const rows: GuidanceProposalRow[] = [];
    for (const g of groups.values()) {
        if (g.freq < minFrequency) { skipped += 1; continue; }
        const sig = dedupeSig("guidance", normalizeTitle(g.title));
        rows.push({
            proposalKey: proposalKeyFor("guidance", g.title, sig),
            title: g.title,
            hypothesis:
                `Stated as a standing instruction ${g.freq}× (marker: "${g.pattern}"). ` +
                `Codify it in your agent guidance so it's applied without being restated.`,
            fileTarget: "CLAUDE.md",
            section: "directives",
            suggestedText: g.title.replace(/^Directive:\s*/, ""),
            confidence: g.freq >= 3 ? "high" : g.freq >= 2 ? "medium" : "low",
            frequency: g.freq,
            sig,
            evidenceSummary: g.turnKeys.map((k) => `turn:${k}`),
        });
    }
    // Strongest (most-restated, then most-recent) first; cap to avoid a firehose.
    rows.sort((a, b) => b.frequency - a.frequency);
    return { rows: rows.slice(0, limit), skipped };
};

export const buildGuidanceProposalStatements = (
    rows: readonly GuidanceProposalRow[],
    existingSigs: ReadonlySet<string> = new Set(),
): string[] => {
    const stmts: string[] = [];
    for (const row of rows) {
        const proposalRef = recordRef("proposal", row.proposalKey);
        const payloadRef = recordRef("guidance_proposal", row.proposalKey);
        const baseline = JSON.stringify({
            frequency: row.frequency,
            evidence: row.evidenceSummary,
        });
        const isNew = !existingSigs.has(row.sig);

        if (isNew) {
            stmts.push(
                `CREATE ${proposalRef} CONTENT ${surrealObject([
                    ["form", surrealString("guidance")],
                    ["title", surrealString(row.title)],
                    ["hypothesis", surrealString(row.hypothesis)],
                    ["dedupe_sig", surrealString(row.sig)],
                    ["frequency", String(row.frequency)],
                    ["confidence", surrealString(row.confidence)],
                    ["status", surrealString("open")],
                    ["baseline", surrealOptionString(baseline)],
                    ["updated_at", "time::now()"],
                ])};`,
            );
        } else {
            stmts.push(
                `UPDATE ${proposalRef} SET ${[
                    ["title", surrealString(row.title)],
                    ["hypothesis", surrealString(row.hypothesis)],
                    ["frequency", String(row.frequency)],
                    ["confidence", surrealString(row.confidence)],
                    ["updated_at", "time::now()"],
                ].map(([n, v]) => `${n} = ${v}`).join(", ")};`,
            );
        }

        stmts.push(
            `UPSERT ${payloadRef} MERGE ${surrealObject([
                ["proposal", proposalRef],
                ["file_target", surrealString(row.fileTarget)],
                ["section", surrealOptionString(row.section)],
                ["suggested_text", surrealString(row.suggestedText)],
            ])};`,
        );
    }
    return stmts;
};

// ---------------------------------------------------------------------------
// Routing proposal (form='hook') - model-routing signal from dispatch analytics
// ---------------------------------------------------------------------------

export interface RoutingProposalRow {
    readonly proposalKey: string;
    readonly title: string;
    readonly hypothesis: string;
    readonly confidence: string;
    readonly frequency: number;
    readonly sig: string;
}

/**
 * Derive a single routing-form proposal row from dispatch candidate analytics.
 *
 * Returns null when the signal is too thin (candidateCount < 5 OR
 * totalEstSavingsUsd < 5) so noise doesn't pollute the proposal shortlist.
 *
 * The title is intentionally STABLE across runs; savings figures belong in
 * the hypothesis so dedupe_sig (which hashes the title) accumulates frequency
 * on the same proposal row rather than forking a new one each ingest.
 */
export const deriveRoutingProposalRow = (input: {
    readonly candidateCount: number;
    readonly totalEstSavingsUsd: number;
    readonly sinceDays: number;
    readonly topClasses: ReadonlyArray<{ readonly classId: string; readonly savings_usd: number }>;
}): RoutingProposalRow | null => {
    if (input.candidateCount < 5 || input.totalEstSavingsUsd < 5) return null;

    const title = "Route mechanical subagent dispatches to cheaper models";
    const normTitle = normalizeTitle(title);
    const sig = dedupeSig("hook", normTitle);

    const savings = input.totalEstSavingsUsd.toFixed(2);
    const topStr = input.topClasses
        .slice(0, 3)
        .map((c) => `${c.classId} ($${c.savings_usd.toFixed(2)})`)
        .join(", ");
    const hypothesis =
        `${input.candidateCount} model-less dispatches on fable/opus matched mechanical routing classes` +
        ` in the last ${input.sinceDays}d; est $${savings} redirectable.` +
        (topStr ? ` Top classes: ${topStr}.` : "") +
        ` Apply: ax dispatches compile-routing + route-dispatch hook (ax hooks install).`;

    const confidence: string =
        input.totalEstSavingsUsd >= 50 ? "high" :
        input.totalEstSavingsUsd >= 15 ? "medium" :
        "low";

    return {
        proposalKey: proposalKeyFor("hook", title, sig),
        title,
        hypothesis,
        confidence,
        frequency: input.candidateCount,
        sig,
    };
};

/**
 * Build SurrealQL statements for a routing proposal row. Mirrors
 * buildGuidanceProposalStatements: CREATE on first sight, UPDATE mutable
 * fields on re-derive. No typed payload table (hook form is self-contained).
 */
export const buildRoutingProposalStatements = (
    row: RoutingProposalRow,
    existingSigs: ReadonlySet<string> = new Set(),
): string[] => {
    const stmts: string[] = [];
    const proposalRef = recordRef("proposal", row.proposalKey);
    const baseline = JSON.stringify({ frequency: row.frequency });
    const isNew = !existingSigs.has(row.sig);

    if (isNew) {
        stmts.push(
            `CREATE ${proposalRef} CONTENT ${surrealObject([
                ["form", surrealString("hook")],
                ["title", surrealString(row.title)],
                ["hypothesis", surrealString(row.hypothesis)],
                ["dedupe_sig", surrealString(row.sig)],
                ["frequency", String(row.frequency)],
                ["confidence", surrealString(row.confidence)],
                ["status", surrealString("open")],
                ["baseline", surrealOptionString(baseline)],
                ["updated_at", "time::now()"],
            ])};`,
        );
    } else {
        stmts.push(
            `UPDATE ${proposalRef} SET ${[
                ["hypothesis", surrealString(row.hypothesis)],
                ["frequency", String(row.frequency)],
                ["confidence", surrealString(row.confidence)],
                ["updated_at", "time::now()"],
            ].map(([n, v]) => `${n} = ${v}`).join(", ")};`,
        );
    }

    return stmts;
};

// ---------------------------------------------------------------------------
// Image context proposal (form='subagent') - isolate heavy visual context signal
// ---------------------------------------------------------------------------

/**
 * Threshold: surface the signal when main-thread image reads are meaningfully high.
 * 20 MB main-thread in the window is roughly 5M est-tokens re-billed across every
 * later turn in those sessions - enough signal that routing visual tasks to a
 * subagent would reduce context pressure.
 */
export const IMAGE_CONTEXT_THRESHOLD_MB = 20;

export interface ImageContextProposalRow {
    readonly proposalKey: string;
    readonly title: string;
    readonly hypothesis: string;
    readonly confidence: string;
    readonly frequency: number;
    readonly sig: string;
}

/**
 * Derive a single image-context proposal row from ImageContextResult.
 *
 * Returns null when main-thread image bytes are below IMAGE_CONTEXT_THRESHOLD_MB
 * (signal too thin). The title is STABLE across runs so dedupe_sig accumulates
 * frequency on the same proposal row across re-derive passes. The hypothesis
 * includes live figures so the recommendation always cites fresh data.
 */
export const deriveImageContextProposalRow = (
    result: ImageContextResult,
    sinceDays: number,
): ImageContextProposalRow | null => {
    const { mainBytes, mainCalls } = result.totals;
    const thresholdBytes = IMAGE_CONTEXT_THRESHOLD_MB * 1024 * 1024;
    if (mainBytes < thresholdBytes) return null;

    const title = "Isolate large-image visual judgment to a subagent";
    const normTitle = normalizeTitle(title);
    const sig = dedupeSig("subagent", normTitle);

    const mainMb = (mainBytes / (1024 * 1024)).toFixed(1);
    const hypothesis =
        `Main-thread image context is ${mainMb} MB over the last ${sinceDays}d (${mainCalls} image reads);` +
        ` route large-image visual judgment to a subagent - see \`ax cost images\` and the` +
        ` efficient-dispatch skill's isolate-heavy-context pattern.`;

    const confidence: string =
        mainBytes >= 50 * 1024 * 1024 ? "high" : "medium";

    return {
        proposalKey: proposalKeyFor("subagent", title, sig),
        title,
        hypothesis,
        confidence,
        frequency: mainCalls,
        sig,
    };
};

/**
 * Build SurrealQL statements for an image-context proposal row. Mirrors
 * buildRoutingProposalStatements: CREATE on first sight, UPDATE mutable
 * fields on re-derive. No typed payload table (subagent form is self-contained).
 */
export const buildImageContextProposalStatements = (
    row: ImageContextProposalRow,
    existingSigs: ReadonlySet<string> = new Set(),
): string[] => {
    const stmts: string[] = [];
    const proposalRef = recordRef("proposal", row.proposalKey);
    const baseline = JSON.stringify({ frequency: row.frequency });
    const isNew = !existingSigs.has(row.sig);

    if (isNew) {
        stmts.push(
            `CREATE ${proposalRef} CONTENT ${surrealObject([
                ["form", surrealString("subagent")],
                ["title", surrealString(row.title)],
                ["hypothesis", surrealString(row.hypothesis)],
                ["dedupe_sig", surrealString(row.sig)],
                ["frequency", String(row.frequency)],
                ["confidence", surrealString(row.confidence)],
                ["status", surrealString("open")],
                ["baseline", surrealOptionString(baseline)],
                ["updated_at", "time::now()"],
            ])};`,
        );
    } else {
        stmts.push(
            `UPDATE ${proposalRef} SET ${[
                ["hypothesis", surrealString(row.hypothesis)],
                ["frequency", String(row.frequency)],
                ["confidence", surrealString(row.confidence)],
                ["updated_at", "time::now()"],
            ].map(([n, v]) => `${n} = ${v}`).join(", ")};`,
        );
    }

    return stmts;
};

export interface DeriveProposalsOpts {
    readonly minFrequency: number;
    readonly sinceDays?: number | undefined;
}

interface SkillCandidateRow {
    readonly id: string | { tb: string; id: string };
    readonly name: string;
    readonly trigger_pattern: string;
    readonly suspected_gap: string;
    readonly proposed_behavior: string;
    readonly confidence: string;
    readonly expected_impact?: string | null;
    readonly metrics?: Record<string, unknown> | string | null;
}

interface SkillRow {
    readonly name: string;
}

export const normalizeTitle = (raw: string): string =>
    raw.toLowerCase().trim().replaceAll(/\s+/g, " ");

export const dedupeSig = (form: string, normalizedTitle: string): string =>
    `${form}__${Bun.hash(`${form}:${normalizedTitle}`).toString(16).slice(0, 16)}`;

export const parseMetrics = (
    raw: Record<string, unknown> | string | null | undefined,
): Record<string, unknown> => {
    if (raw === null || raw === undefined) return {};
    if (typeof raw === "string") {
        // Tolerant decode: corrupt or non-object JSON -> {} (the proposal
        // pipeline must never die on one bad metrics column).
        return (jsonRecordField.decode(raw) as Record<string, unknown> | null) ?? {};
    }
    return raw;
};

/**
 * Frequency = `fix_chain_count` only. The legacy code also folded in
 * `risky_session_count` (any session with ≥5 errors / any correction / high
 * pressure) which matched every active dev and produced a top proposal
 * with freq=1072 - pure noise. The closure stage no longer emits that
 * metric; defensive: still read it but never trust it for ranking.
 */
export const skillProposalFrequency = (
    metrics: Record<string, unknown>,
): number => {
    const fix = Number(metrics.fix_chain_count ?? 0);
    return Number.isFinite(fix) ? fix : 0;
};

const proposalKeyFor = (form: string, title: string, sig: string): string =>
    `${form}__${safeKeyPart(title).slice(0, 60)}__${sig.slice(-12)}`;

export interface SkillProposalRow {
    readonly proposalKey: string;
    readonly candidateKey: string;
    readonly title: string;
    readonly hypothesis: string;
    readonly triggerPattern: string;
    readonly suspectedGap: string;
    readonly proposedBehavior: string;
    readonly expectedImpact: string | null;
    readonly confidence: string;
    readonly frequency: number;
    readonly sig: string;
    readonly metrics: Record<string, unknown>;
}

export const deriveSkillProposalRows = (
    candidates: readonly SkillCandidateRow[],
    existingSkillNames: ReadonlySet<string>,
    minFrequency: number,
): { readonly rows: SkillProposalRow[]; readonly skipped: number } => {
    const rows: SkillProposalRow[] = [];
    let skipped = 0;

    for (const candidate of candidates) {
        const metrics = parseMetrics(candidate.metrics);
        const frequency = skillProposalFrequency(metrics);
        if (frequency < minFrequency) { skipped += 1; continue; }

        const normTitle = normalizeTitle(candidate.name);
        if (existingSkillNames.has(normTitle)) { skipped += 1; continue; }

        const sig = dedupeSig("skill", normTitle);
        const candidateKey = recordKeyPart(candidate.id, "skill_candidate");
        if (candidateKey === null) { skipped += 1; continue; }
        rows.push({
            proposalKey: proposalKeyFor("skill", candidate.name, sig),
            candidateKey,
            title: candidate.name,
            hypothesis: candidate.suspected_gap,
            triggerPattern: candidate.trigger_pattern,
            suspectedGap: candidate.suspected_gap,
            proposedBehavior: candidate.proposed_behavior,
            expectedImpact: candidate.expected_impact ?? null,
            confidence: candidate.confidence,
            frequency,
            sig,
            metrics,
        });
    }

    return { rows, skipped };
};

/**
 * Build the SurrealQL statements for a batch of derived rows. The proposal
 * row is partitioned by whether its dedupe_sig already exists in the DB:
 *  - new sig  : insert a fresh proposal row (baseline captured here).
 *  - existing : refresh the mutable fields; baseline and status untouched.
 *
 * `existingSigs` is the set of dedupe_sig values currently in the proposal
 * table. The caller (`deriveProposals`) fetches it once before computing
 * rows so the partition is consistent within one ingest pass.
 */
export const buildSkillProposalStatements = (
    rows: readonly SkillProposalRow[],
    existingSigs: ReadonlySet<string> = new Set(),
): string[] => {
    const stmts: string[] = [];
    for (const row of rows) {
        const proposalRef = recordRef("proposal", row.proposalKey);
        const payloadRef = recordRef("skill_proposal", row.proposalKey);
        const candidateRef = recordRef("skill_candidate", row.candidateKey);
        const edgeKey = `${row.proposalKey}__${row.candidateKey}`;
        const baseline = JSON.stringify({ frequency: row.frequency, metrics: row.metrics });
        const isNew = !existingSigs.has(row.sig);

        if (isNew) {
            stmts.push(
                `CREATE ${proposalRef} CONTENT ${surrealObject([
                    ["form", surrealString("skill")],
                    ["title", surrealString(row.title)],
                    ["hypothesis", surrealString(row.hypothesis)],
                    ["dedupe_sig", surrealString(row.sig)],
                    ["frequency", String(row.frequency)],
                    ["confidence", surrealString(row.confidence)],
                    ["status", surrealString("open")],
                    ["baseline", surrealOptionString(baseline)],
                    ["updated_at", "time::now()"],
                ])};`,
            );
        } else {
            // Refresh mutable fields. Intentionally omits status + baseline.
            stmts.push(
                `UPDATE ${proposalRef} SET ${[
                    ["title", surrealString(row.title)],
                    ["hypothesis", surrealString(row.hypothesis)],
                    ["frequency", String(row.frequency)],
                    ["confidence", surrealString(row.confidence)],
                    ["updated_at", "time::now()"],
                ].map(([name, value]) => `${name} = ${value}`).join(", ")};`,
            );
        }

        stmts.push(
            `UPSERT ${payloadRef} MERGE ${surrealObject([
                ["proposal", proposalRef],
                ["trigger_pattern", surrealString(row.triggerPattern)],
                ["suspected_gap", surrealString(row.suspectedGap)],
                ["proposed_behavior", surrealString(row.proposedBehavior)],
                ["expected_impact", surrealOptionString(row.expectedImpact)],
            ])};`,
            `DELETE ${recordRef("cites_evidence", edgeKey)};`,
            `RELATE ${proposalRef}->cites_evidence:\`${edgeKey}\`->${candidateRef} SET count = ${String(Number(row.metrics.fix_chain_count ?? row.frequency))}, ts = time::now();`,
        );
    }
    return stmts;
};

export const deriveProposals = (
    opts: DeriveProposalsOpts = { minFrequency: 3 },
): Effect.Effect<DeriveProposalsStats, DbError, SurrealClient | import("@ax/lib/process").ProcessService | FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const [candidates, skills, existingProposals] = yield* Effect.all([
            db.query<[SkillCandidateRow[]]>(`
SELECT id, name, trigger_pattern, suspected_gap, proposed_behavior, confidence, expected_impact, metrics
FROM skill_candidate;`).pipe(Effect.map((rows) => rows?.[0] ?? [])),
            db.query<[SkillRow[]]>(`SELECT name FROM skill;`).pipe(Effect.map((rows) => rows?.[0] ?? [])),
            db.query<[Array<{ dedupe_sig: string }>]>(`SELECT dedupe_sig FROM proposal;`).pipe(Effect.map((rows) => rows?.[0] ?? [])),
        ], { concurrency: 3 });

        const existingSkillNames = new Set(skills.map((s) => normalizeTitle(s.name)));
        const existingSigs = new Set(existingProposals.map((p) => p.dedupe_sig));
        const { rows: skillRows, skipped: skillSkipped } =
            deriveSkillProposalRows(candidates, existingSkillNames, opts.minFrequency);
        const skillStmts = buildSkillProposalStatements(skillRows, existingSigs);

        // Phase C11: also derive guidance-form proposals from the harness
        // report. buildProjectHarnessReport is project-doctor logic that
        // identifies "you should add a guardrail" candidates; route those
        // into the proposal pipeline as guidance-form proposals.
        const { buildProjectHarnessReport } = yield* Effect.promise(() =>
            import("../project/harness.ts"),
        );
        const harnessReport = yield* buildProjectHarnessReport();
        const { rows: guidanceRows, skipped: guidanceSkipped } =
            deriveGuidanceProposalRows(harnessReport.learningCandidates);
        const guidanceStmts = buildGuidanceProposalStatements(guidanceRows, existingSigs);

        // Routing proposal (form='hook'): derive from dispatch candidate analytics.
        // Query failure is tolerated - if dispatch data isn't available the stage
        // still writes skill + guidance proposals successfully.
        const sinceDays = opts.sinceDays ?? 14;
        const dispatchResult = yield* Effect.orElseSucceed(
            fetchDispatchCandidates({ sinceDays }).pipe(
                Effect.map((r) => ({
                    candidateCount: r.candidates.length,
                    totalEstSavingsUsd: r.total_est_savings_usd,
                    topClasses: r.top_classes,
                } as {
                    candidateCount: number;
                    totalEstSavingsUsd: number;
                    topClasses: ReadonlyArray<{ classId: string; savings_usd: number }>;
                } | null)),
            ),
            () => null as {
                candidateCount: number;
                totalEstSavingsUsd: number;
                topClasses: ReadonlyArray<{ classId: string; savings_usd: number }>;
            } | null,
        );
        const routingRow = dispatchResult
            ? deriveRoutingProposalRow({
                candidateCount: dispatchResult.candidateCount,
                totalEstSavingsUsd: dispatchResult.totalEstSavingsUsd,
                sinceDays,
                topClasses: dispatchResult.topClasses,
            })
            : null;
        const routingStmts = routingRow
            ? buildRoutingProposalStatements(routingRow, existingSigs)
            : [];

        // Image context proposal (form='subagent'): derive from image-read analytics.
        // Query failure is tolerated - same pattern as the routing proposal.
        const imageContextResult = yield* Effect.orElseSucceed(
            fetchImageContext({ sinceDays, limit: 0 }),
            () => null as ImageContextResult | null,
        );
        const imageContextRow = imageContextResult
            ? deriveImageContextProposalRow(imageContextResult, sinceDays)
            : null;
        const imageContextStmts = imageContextRow
            ? buildImageContextProposalStatements(imageContextRow, existingSigs)
            : [];

        // Directive proposals (form='guidance'): mine proactive standing
        // instructions from user turns. Scoped to a fixed 90d window (not
        // ctx.sinceDays) so cross-session recurrence is captured consistently
        // whether this is a --since=1 watcher run or a full ingest. Tolerant:
        // a query failure leaves the other proposal forms unaffected.
        // Exclude claude-subagent-source turns: a subagent's first user turn is
        // the dispatch PROMPT ("You are implementing ONE task..."), not a user
        // directive - the other dominant false-positive class from the smoke.
        const directiveTurns = yield* Effect.orElseSucceed(
            db.query<[DirectiveTurnRow[]]>(`
SELECT type::string(id) AS id, type::string(session) AS session, text_excerpt, type::string(ts) AS ts
FROM turn
WHERE role = "user" AND text_excerpt != NONE AND text_excerpt != ""
  AND ts > time::now() - 90d AND session.source != "claude-subagent";`)
                .pipe(Effect.map((rows) => rows?.[0] ?? [])),
            () => [] as DirectiveTurnRow[],
        );
        const directiveCandidates = deriveDirectiveCandidates(directiveTurns);

        // A5: Load the per-user directive lift table (built by the directive-ngrams
        // stage) and score candidates so the limit in deriveDirectiveProposalRows
        // keeps the highest-signal ones. Tolerant: if the table is empty or the
        // query fails, scoring falls back to seed order (v1 ordering preserved).
        const directiveLiftMap = yield* Effect.orElseSucceed(
            db.query<[Array<{ ngram: string; lift: number }>]>(`
SELECT ngram, lift FROM directive_ngram WHERE lift > 0;`)
                .pipe(Effect.map((rows) => {
                    const map = new Map<string, number>();
                    for (const r of rows?.[0] ?? []) {
                        map.set(r.ngram, r.lift);
                    }
                    return map as ReadonlyMap<string, number>;
                })),
            () => new Map<string, number>() as ReadonlyMap<string, number>,
        );
        const scoredDirectiveCandidates = scoreDirectiveCandidates(directiveCandidates, directiveLiftMap);

        const { rows: directiveRows, skipped: directiveSkipped } =
            deriveDirectiveProposalRows(scoredDirectiveCandidates);
        const directiveStmts = buildGuidanceProposalStatements(directiveRows, existingSigs);

        yield* executeStatementsWith(db, [...skillStmts, ...guidanceStmts, ...routingStmts, ...imageContextStmts, ...directiveStmts], { chunkSize: 500 });
        return {
            skillProposals: skillRows.length,
            guidanceProposals: guidanceRows.length,
            routingProposals: routingRow ? 1 : 0,
            imageContextProposals: imageContextRow ? 1 : 0,
            directiveProposals: directiveRows.length,
            skipped: skillSkipped + guidanceSkipped + directiveSkipped,
        };
    });

if (import.meta.main) {
    await Effect.runPromise(
        deriveProposals().pipe(
            Effect.provide(AppLayer),
            Effect.scoped,
        ) as Effect.Effect<DeriveProposalsStats>,
    );
}

// ---------------------------------------------------------------------------
// Co-located StageDef
// ---------------------------------------------------------------------------

import { BaseStageStats, IngestContext, sinceDaysFromCtx, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";
import type { ProcessService } from "@ax/lib/process";

export const ProposalsKey = Schema.Literal("proposals");
export type ProposalsKey = typeof ProposalsKey.Type;

/**
 * Proposals stage - derives Skill + Guidance + Routing + Image-Context Proposals from cumulated evidence.
 * Depends on {@link ClosureKey}. Consumed by {@link OpportunitiesKey}, {@link RetroProposalsKey}.
 */
export class ProposalsStats extends BaseStageStats.extend<ProposalsStats>("ProposalsStats")({
    skillProposals: Schema.Number,
    guidanceProposals: Schema.Number,
    routingProposals: Schema.Number,
    imageContextProposals: Schema.Number,
    directiveProposals: Schema.Number,
}) {}

export const proposalsStage: StageDef<ProposalsStats, SurrealClient | ProcessService | FileSystem.FileSystem | Path.Path> = {
    meta: StageMeta.make({ key: "proposals", deps: ["closure"], tags: ["derive"] }),
    run: (ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const sinceDays = sinceDaysFromCtx(ctx);
            const result = yield* deriveProposals({ minFrequency: 3, sinceDays });
            return ProposalsStats.make({
                durationMs: Date.now() - t0,
                summary: `derived ${result.skillProposals} skill proposals, ${result.guidanceProposals} guidance proposals, ${result.routingProposals} routing proposals, ${result.imageContextProposals} image-context proposals, ${result.directiveProposals} directive proposals`,
                skillProposals: result.skillProposals,
                guidanceProposals: result.guidanceProposals,
                routingProposals: result.routingProposals,
                imageContextProposals: result.imageContextProposals,
                directiveProposals: result.directiveProposals,
            });
        }),
};
