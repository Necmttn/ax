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
 *
 * Families that have landed since C1: guidance (Phase C11, harness-derived
 * guardrails), hook (routing), subagent (image-context), guidance/directives,
 * guidance/workflows, and guidance/cache-lens (#868 slice B - auto-minted
 * cache-busting offenders, gated on corroboration/recurrence/materiality/cap;
 * see the "Cache-lens proposals" section below).
 */

import { Effect, FileSystem, Path, Schema } from "effect";
import { cacheRow, jsonParam } from "@ax/lib/duckdb/row";
import type { CacheReadError, CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { Judgment, TextColumn, TimestampColumn, type JudgmentError, type JudgmentService, type SidecarParam } from "@ax/lib/sqlite";
import { judgmentRow } from "../improve/judgment-proposals.ts";
import { jsonRecordField } from "@ax/lib/decode";
import { edgeRowId, stableId } from "@ax/lib/stable-id";
import { safeKeyPart, recordKeyPart } from "@ax/lib/shared/derive-keys";
import type { HarnessLearningCandidate } from "../project/types.ts";
import { fetchDispatchCandidates } from "../queries/dispatch-analytics.ts";
import { fetchImageContext, type ImageContextResult } from "../queries/image-context.ts";
import { fetchCacheLensCandidates, relativeCostDelta, type CacheLensCandidateRow } from "../queries/cache-bust.ts";
import { deriveDirectiveCandidates, scoreDirectiveCandidates, type DirectiveCandidate, type DirectiveTurnRow } from "./directives.ts";
import { fetchWorkflowArcs, type ArcCandidate } from "../queries/workflow-sequences.ts";
import { readConfiguredHooks } from "../hooks/config.ts";
import { hasActiveClaudeRouteDispatch } from "../hooks/installed-guards.ts";
import { HookProviderRegistryDefault } from "../hooks/providers/registry.ts";
import type { ConfiguredHook } from "../hooks/providers/types.ts";

export interface DeriveProposalsStats {
    readonly skillProposals: number;
    readonly guidanceProposals: number;
    readonly routingProposals: number;
    readonly imageContextProposals: number;
    readonly directiveProposals: number;
    readonly workflowProposals: number;
    readonly cacheLensProposals: number;
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

/**
 * One row plus WHICH STORE it belongs in.
 *
 * This derivation straddles both v2 stores and the split is not negotiable:
 * `proposal` and the per-form payload tables are durable judgment (SQLite
 * sidecar - a rejected proposal that a re-derive resurrected as `open` would ask
 * the same dead question forever), while `cites_evidence` is a MINED edge that
 * re-derives from the same transcripts and stays in the DuckDB cache, where
 * `derive-opportunities` reads it back. `store` is explicit rather than inferred
 * from the table name so a new row shape has to state its home - and it is a
 * DISCRIMINATED UNION rather than a tag beside one row type, so each variant
 * carries the value contract its own seam accepts and the write loop cannot
 * hand a sidecar row to the cache.
 */
type ProposalWrite =
    | {
        readonly store: "judgment";
        readonly table: string;
        readonly row: Record<string, SidecarParam>;
    }
    | {
        readonly store: "cache";
        readonly table: string;
        readonly row: Record<string, import("@ax/lib/duckdb/types").DuckDbParam>;
    };

const proposalWrite = (
    row: { readonly proposalKey: string; readonly title: string; readonly hypothesis: string;
        readonly sig: string; readonly frequency: number; readonly confidence: string },
    form: string,
    baseline: unknown,
    exists: boolean,
): ProposalWrite => ({ store: "judgment", table: "proposal", row: judgmentRow(exists ? {
    id: row.proposalKey, form, title: row.title, hypothesis: row.hypothesis, dedupe_sig: row.sig,
    frequency: row.frequency, confidence: row.confidence, updated_at: new Date(),
} : {
    id: row.proposalKey, form, title: row.title, hypothesis: row.hypothesis, dedupe_sig: row.sig,
    frequency: row.frequency, confidence: row.confidence, status: "open", origin: "mined",
    hypothesis_template: null, evidence_query: null, reject_reason: null, baseline: jsonParam(baseline),
    created_at: new Date(), updated_at: new Date(),
}) });

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

// ---------------------------------------------------------------------------
// Workflow proposals (form='guidance', section='workflows') - v1
// Recurring skill-arc sequences (mined by mineArcs) become guidance proposals
// so the agent can codify their best workflows. Reuses GuidanceProposalRow +
// buildGuidanceProposalWrites; section="workflows" discriminates from
// section="directives" proposals in guidance_proposal. Mirrors the directive
// path exactly but with section="workflows". Spec: milestone B (issue #588).
// ---------------------------------------------------------------------------

const WORKFLOW_TITLE_MAX = 130;
const WORKFLOW_PROPOSAL_LIMIT = 20;

const workflowTitle = (steps: readonly string[]): string => {
    const raw = `Workflow: ${steps.join(" → ")}`;
    return raw.length > WORKFLOW_TITLE_MAX ? `${raw.slice(0, WORKFLOW_TITLE_MAX - 1)}…` : raw;
};

export const deriveWorkflowProposalRows = (
    arcs: readonly ArcCandidate[],
    opts?: { readonly minSessions?: number; readonly limit?: number },
): { readonly rows: GuidanceProposalRow[]; readonly skipped: number } => {
    const minSessions = opts?.minSessions ?? 3;
    const limit = opts?.limit ?? WORKFLOW_PROPOSAL_LIMIT;

    let skipped = 0;
    const rows: GuidanceProposalRow[] = [];
    const seenSigs = new Set<string>();

    for (const arc of arcs) {
        if (arc.support < minSessions) { skipped += 1; continue; }
        const title = workflowTitle(arc.steps);
        const normTitle = normalizeTitle(title);
        const sig = dedupeSig("guidance", normTitle);
        if (seenSigs.has(sig)) { skipped += 1; continue; }
        seenSigs.add(sig);

        const confidence: string =
            arc.support >= 5 ? "high" : arc.support >= 3 ? "medium" : "low";

        rows.push({
            proposalKey: proposalKeyFor("workflow", title, sig),
            title,
            hypothesis:
                `This ${arc.steps.length}-skill sequence recurred across ${arc.support} sessions: ` +
                arc.steps.join(" → ") +
                `. Codify it as a workflow in your skills or CLAUDE.md so future sessions follow it automatically.`,
            fileTarget: "CLAUDE.md",
            section: "workflows",
            suggestedText: arc.steps.join(" → "),
            confidence,
            frequency: arc.support,
            sig,
            // Session IDs are not available on ArcCandidate (mineArcs returns only steps+support);
            // include what we have (support count + ordered steps). Full per-session ids
            // would require ArcCandidate to carry them - deferred to a follow-up.
            evidenceSummary: [`support: ${arc.support} sessions`, `steps: ${arc.steps.join(", ")}`],
        });
    }

    rows.sort((a, b) => b.frequency - a.frequency);
    return { rows: rows.slice(0, limit), skipped };
};

export const buildGuidanceProposalWrites = (
    rows: readonly GuidanceProposalRow[],
    existingSigs: ReadonlySet<string> = new Set(),
): ProposalWrite[] => {
    const writes: ProposalWrite[] = [];
    for (const row of rows) {
        writes.push(proposalWrite(row, "guidance", { frequency: row.frequency, evidence: row.evidenceSummary }, existingSigs.has(row.sig)));
        writes.push({ store: "judgment", table: "guidance_proposal", row: judgmentRow({ id: row.proposalKey,
            proposal: row.proposalKey, file_target: row.fileTarget, section: row.section,
            suggested_text: row.suggestedText }) });
    }
    return writes;
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

export const ROUTING_PROPOSAL_TITLE = "Route mechanical subagent dispatches to cheaper models";
export const ROUTING_PROPOSAL_INSTALLED_REASON = "route_dispatch_already_installed";

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

    const title = ROUTING_PROPOSAL_TITLE;
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
 * Build cache write rows for a routing proposal. Mirrors
 * buildGuidanceProposalWrites: insert on first sight, update mutable
 * fields on re-derive. The typed payload carries all four safety gates, so
 * `ax improve accept` can emit the existing manual task brief.
 */
export const buildRoutingProposalWrites = (
    row: RoutingProposalRow,
    existingSigs: ReadonlySet<string> = new Set(),
): ProposalWrite[] => [
    proposalWrite(row, "hook", { frequency: row.frequency }, existingSigs.has(row.sig)),
    { store: "judgment", table: "hook_proposal", row: judgmentRow({
        id: row.proposalKey,
        proposal: row.proposalKey,
        event_name: "PreToolUse",
        target_tool: "Agent",
        hook_command: "bun ~/.ax/hooks/route-dispatch.ts",
        recovery_path: "Remove the route-dispatch hook registration from Claude settings.",
        smoke_test_command: "ax hooks backtest ~/.ax/hooks/route-dispatch.ts --days=7",
        disable_command: "AX_ROUTE_DISPATCH=off",
        failure_mode: "fail_open",
    }) },
];

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
 * Build cache write rows for an image-context proposal. Mirrors
 * buildRoutingProposalWrites: insert on first sight, update mutable
 * fields on re-derive. No typed payload table (subagent form is self-contained).
 */
export const buildImageContextProposalWrites = (
    row: ImageContextProposalRow,
    existingSigs: ReadonlySet<string> = new Set(),
): ProposalWrite[] => [proposalWrite(row, "subagent", { frequency: row.frequency }, existingSigs.has(row.sig))];

// ---------------------------------------------------------------------------
// Cache-lens proposals (form='guidance', section='cache-lens') - slice B of
// #868: auto-mint top cache-busting offenders (native attribution_skill /
// attribution_agent from cache_bust_event) as guidance-form proposals a human
// triages via `ax improve list` / `accept`. Mint is NOT apply - no behavior
// changes from a mint, only a shortlist row.
//
// FOUR guards must ALL pass, operator-approved and not to be weakened:
//   1. Corroboration (±25%) - full Claude transcript cost must agree with
//      independent OTLP claude_code.cost.usage over the offender's comparable
//      ROOT sessions. Zero comparable roots never mint.
//   2. Recurrence - busts across >= 2 distinct SESSIONS in the window. Proxy
//      for ">= 2 ingest windows" - cache_bust_event carries no run id, so a
//      session count is the closest signal available. NOT a UTC-calendar-day
//      count (#943): a UTC-day proxy miscounts for a non-UTC operator - one
//      local workday straddling UTC midnight reads as two days (false pass),
//      and two local workdays sharing a UTC date read as one (false fail).
//   3. Materiality - normalized weekly cost (bust_cost_usd scaled to a 7-day
//      rate) >= $5. A one-off $50 bust in a 90-day window is not worth an
//      operator's triage attention; a steady $6/wk drip is.
//   4. Cap - at most 3 OPEN cache-lens proposals at a time (existing + newly
//      minted this run). Highest-weekly-cost candidates mint first; the rest
//      are skipped (counted in stats), so the shortlist never floods.
// ---------------------------------------------------------------------------

export const CACHE_LENS_CORROBORATION_TOLERANCE = 0.25;
export const CACHE_LENS_MIN_RECURRENCE_SESSIONS = 2;
export const CACHE_LENS_MATERIALITY_WEEKLY_USD = 5;
export const CACHE_LENS_PROPOSAL_CAP = 3;
export const CACHE_LENS_SECTION = "cache-lens";

/** Confidence maps corroboration tightness: the guard already excludes >25%,
 *  so a candidate that reaches mint is always "high" or "medium" - "low"
 *  exists only so the mapping is total (defensive, never observed in mint). */
export const cacheLensConfidence = (deltaPct: number): "high" | "medium" | "low" =>
    deltaPct <= 0.10 ? "high" : deltaPct <= 0.25 ? "medium" : "low";

export interface CacheLensEvaluation {
    readonly weeklyCostUsd: number;
    readonly corroborationDeltaPct: number;
    readonly confidence: "high" | "medium" | "low";
    readonly dominantReason: string;
    readonly dominantReasonPct: number;
}

/**
 * Apply the three per-candidate guards (corroboration, recurrence,
 * materiality - the cap is a cross-candidate concern handled by
 * {@link deriveCacheLensProposalRows}). Returns `null` when ANY guard fails.
 */
export const evaluateCacheLensCandidate = (
    candidate: CacheLensCandidateRow,
    sinceDays: number,
): CacheLensEvaluation | null => {
    // Guard 1: corroboration. Both root totals must be finite and positive.
    // A zero or non-finite independent denominator cannot define a relative delta.
    if (
        candidate.comparableRoots <= 0
        || !Number.isFinite(candidate.comparableEstimatedUsd)
        || candidate.comparableEstimatedUsd <= 0
        || !Number.isFinite(candidate.comparableOtlpUsd)
        || candidate.comparableOtlpUsd <= 0
    ) return null;
    const corroborationDeltaPct = relativeCostDelta(
        candidate.comparableEstimatedUsd,
        candidate.comparableOtlpUsd,
    );
    if (corroborationDeltaPct > CACHE_LENS_CORROBORATION_TOLERANCE) return null;

    // Guard 2: recurrence.
    if (candidate.sessions < CACHE_LENS_MIN_RECURRENCE_SESSIONS) return null;

    // Guard 3: materiality.
    const windowDays = Math.max(1, sinceDays);
    const weeklyCostUsd = (candidate.bustCostUsd * 7) / windowDays;
    if (weeklyCostUsd < CACHE_LENS_MATERIALITY_WEEKLY_USD) return null;

    const sortedReasons = [...candidate.reasonCounts].sort((a, b) => b.count - a.count);
    const dominant = sortedReasons[0];
    const totalReasonCount = sortedReasons.reduce((sum, r) => sum + r.count, 0);
    const dominantReasonPct = dominant && totalReasonCount > 0 ? dominant.count / totalReasonCount : 0;

    return {
        weeklyCostUsd,
        corroborationDeltaPct,
        confidence: cacheLensConfidence(corroborationDeltaPct),
        dominantReason: dominant?.reason ?? "unknown",
        dominantReasonPct,
    };
};

export interface CacheLensProposalRow {
    readonly proposalKey: string;
    readonly title: string;
    readonly hypothesis: string;
    readonly fileTarget: string;
    readonly section: string;
    readonly suggestedText: string;
    readonly confidence: string;
    readonly frequency: number;
    readonly sig: string;
    /** Full provenance JSON - captured into `proposal.baseline` on first mint. */
    readonly baseline: Record<string, unknown>;
}

const cacheLensTitle = (kind: "skill" | "agent", name: string): string =>
    `Trim cache-busting ${kind} ${name}`;

/**
 * Guard-evaluate every candidate, then apply the cap: a candidate whose
 * dedupe_sig already matches an OPEN cache-lens proposal always refreshes
 * (mutable-field update, not a new mint - it does not consume cap capacity,
 * or a passing-then-failing-then-passing offender would get stuck unable to
 * refresh once the cap filled up). Only genuinely NEW candidates draw against
 * `cap - existingOpenSigs.size`, highest weekly cost first.
 */
export const deriveCacheLensProposalRows = (
    candidates: readonly CacheLensCandidateRow[],
    opts: {
        readonly sinceDays: number;
        readonly cap: number;
        readonly existingOpenSigs: ReadonlySet<string>;
    },
): { readonly rows: CacheLensProposalRow[]; readonly skipped: number } => {
    let skipped = 0;
    const scored: Array<{
        readonly candidate: CacheLensCandidateRow;
        readonly evaluation: CacheLensEvaluation;
        readonly title: string;
        readonly sig: string;
    }> = [];
    for (const candidate of candidates) {
        const evaluation = evaluateCacheLensCandidate(candidate, opts.sinceDays);
        if (!evaluation) { skipped += 1; continue; }
        const title = cacheLensTitle(candidate.kind, candidate.name);
        const sig = dedupeSig("guidance", normalizeTitle(title));
        scored.push({ candidate, evaluation, title, sig });
    }
    // Highest weekly cost first - the cap should protect the biggest offenders.
    scored.sort((a, b) => b.evaluation.weeklyCostUsd - a.evaluation.weeklyCostUsd);

    const capacityForNew = Math.max(0, opts.cap - opts.existingOpenSigs.size);
    let mintedNew = 0;
    const rows: CacheLensProposalRow[] = [];
    for (const { candidate, evaluation, title, sig } of scored) {
        const isExisting = opts.existingOpenSigs.has(sig);
        if (!isExisting) {
            if (mintedNew >= capacityForNew) { skipped += 1; continue; }
            mintedNew += 1;
        }
        const weeklyStr = evaluation.weeklyCostUsd.toFixed(2);
        const deltaStr = (evaluation.corroborationDeltaPct * 100).toFixed(1);
        const dominantPctStr = (evaluation.dominantReasonPct * 100).toFixed(0);
        rows.push({
            proposalKey: proposalKeyFor("guidance", title, sig),
            title,
            hypothesis:
                `${candidate.busts} cache busts across ${candidate.sessions} sessions in the last ` +
                `${opts.sinceDays}d attributed to ${candidate.kind} "${candidate.name}" ` +
                `(~$${weeklyStr}/wk at the current rate). Transcript and OTLP cost differ by ${deltaStr}% ` +
                `over ${candidate.comparableRoots} comparable root sessions ` +
                `(${evaluation.confidence} confidence). Dominant cause: ${evaluation.dominantReason} ` +
                `(${dominantPctStr}% of busts). Trim context reloads / large tool output for this ` +
                `${candidate.kind} - see \`ax cost cache\`.`,
            fileTarget: "CLAUDE.md",
            section: CACHE_LENS_SECTION,
            suggestedText:
                `Trim cache-busting behavior for ${candidate.kind} "${candidate.name}" ` +
                `(~$${weeklyStr}/wk, dominant cause: ${evaluation.dominantReason}).`,
            confidence: evaluation.confidence,
            frequency: candidate.busts,
            sig,
            baseline: {
                origin: "cache-lens",
                offenderKind: candidate.kind,
                offenderName: candidate.name,
                windowDays: opts.sinceDays,
                busts: candidate.busts,
                sessions: candidate.sessions,
                weeklyCostUsd: evaluation.weeklyCostUsd,
                corroborationDeltaPct: evaluation.corroborationDeltaPct,
                comparableRoots: candidate.comparableRoots,
                comparableEstimatedUsd: candidate.comparableEstimatedUsd,
                comparableOtlpUsd: candidate.comparableOtlpUsd,
                reasonMix: candidate.reasonCounts,
                confidence: evaluation.confidence,
            },
        });
    }
    return { rows, skipped };
};

/**
 * Build cache-lens writes. Mirrors buildRoutingProposalWrites /
 * buildImageContextProposalWrites (self-contained baseline captured on first
 * sight, mutable fields refreshed on re-derive) plus a `guidance_proposal`
 * payload row like buildGuidanceProposalWrites - section='cache-lens' is the
 * discriminator (same pattern as directives' section='directives').
 */
export const buildCacheLensProposalWrites = (
    rows: readonly CacheLensProposalRow[],
    existingSigs: ReadonlySet<string> = new Set(),
): ProposalWrite[] => {
    const writes: ProposalWrite[] = [];
    for (const row of rows) {
        writes.push(proposalWrite(row, "guidance", row.baseline, existingSigs.has(row.sig)));
        writes.push({ store: "judgment", table: "guidance_proposal", row: judgmentRow({ id: row.proposalKey,
            proposal: row.proposalKey, file_target: row.fileTarget, section: row.section,
            suggested_text: row.suggestedText }) });
    }
    return writes;
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

export const normalizeTitle = (raw: string): string =>
    raw.toLowerCase().trim().replaceAll(/\s+/g, " ");

const sha256Prefix = (value: string, length = 16): string => {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(value);
    return hasher.digest("hex").slice(0, length);
};

export const dedupeSig = (form: string, normalizedTitle: string): string =>
    `${form}__${sha256Prefix(`${form}:${normalizedTitle}`)}`;

export const ROUTING_PROPOSAL_SIG = dedupeSig("hook", normalizeTitle(ROUTING_PROPOSAL_TITLE));

export const supersedeInstalledRoutingProposal = (
    judgment: JudgmentService,
): Effect.Effect<number, JudgmentError> =>
    judgment.exec(
        "UPDATE proposal SET status = 'superseded', reject_reason = ?, updated_at = ? WHERE dedupe_sig = ? AND status = 'open'",
        [ROUTING_PROPOSAL_INSTALLED_REASON, new Date(), ROUTING_PROPOSAL_SIG],
    );

interface ProposalDedupeMigrationRow {
    readonly id: string;
    readonly form: string;
    readonly title: string;
    readonly dedupe_sig: string;
    readonly status: string;
    readonly origin: string;
    readonly baseline: string | null;
    readonly reject_reason: string | null;
}

const decisionRank = (status: string): number => {
    switch (status) {
        case "rejected": return 0;
        case "accepted": return 1;
        case "superseded": return 2;
        default: return 3;
    }
};

const proposalPayloadTable = (form: string): string | null => {
    switch (form) {
        case "skill": return "skill_proposal";
        case "subagent": return "subagent_proposal";
        case "hook": return "hook_proposal";
        case "guidance": return "guidance_proposal";
        case "automation": return "automation_proposal";
        default: return null;
    }
};

const migratedProposalId = (row: ProposalDedupeMigrationRow, sig: string): string => {
    const oldSuffix = row.dedupe_sig.slice(-12);
    if (row.id.endsWith(oldSuffix)) return `${row.id.slice(0, -oldSuffix.length)}${sig.slice(-12)}`;
    if (row.origin !== "agent") return row.id;

    const baseline = parseMetrics(row.baseline);
    if (baseline.source === "retro_meta_plan" && typeof baseline.slug === "string") {
        return stableId("proposal", ["retro_meta", baseline.slug, sig]);
    }
    return stableId("proposal", [sig]);
};

/**
 * One-time transition from Bun.hash proposal signatures to SHA-256.
 *
 * `form` and `title` are the complete signature inputs, so this migration does
 * not depend on reproducing the Bun version that wrote the old value. Proposal
 * ids and signature values change together. The same transaction also
 * changes typed payload ids and all proposal links. It first moves changed ids
 * to unique temporary values, which makes each update safe under unique indexes.
 *
 * A sidecar can already contain logical duplicates if an earlier Bun upgrade
 * changed Bun.hash. The strongest closed decision receives the canonical SHA
 * signature. Other rows receive deterministic legacy suffixes. Thus no decision
 * row or linked experiment is deleted. Open legacy twins without decisions or
 * experiments are removed after re-keying, so old workflow duplicates do not
 * remain in the shortlist. Future derivation sees the canonical signature.
 */
export const migrateProposalDedupeSigs = (
    judgment: JudgmentService,
): Effect.Effect<void, JudgmentError> =>
    Effect.gen(function* () {
        const rows = yield* judgment.rows(Schema.Struct({
            id: TextColumn,
            form: TextColumn,
            title: TextColumn,
            dedupe_sig: TextColumn,
            status: TextColumn,
            origin: TextColumn,
            baseline: Schema.NullOr(TextColumn),
            reject_reason: Schema.NullOr(TextColumn),
        }), "SELECT id, form, title, dedupe_sig, status, origin, baseline, reject_reason FROM proposal");

        const groups = new Map<string, ProposalDedupeMigrationRow[]>();
        for (const row of rows) {
            const desired = dedupeSig(row.form, normalizeTitle(row.title));
            const group = groups.get(desired) ?? [];
            group.push(row);
            groups.set(desired, group);
        }

        const targets = new Map<string, { readonly id: string; readonly sig: string }>();
        for (const [desired, group] of groups) {
            const ordered = [...group].sort((a, b) =>
                Number(migratedProposalId(b, desired) === b.id) - Number(migratedProposalId(a, desired) === a.id) ||
                decisionRank(a.status) - decisionRank(b.status) ||
                Number(b.dedupe_sig === desired) - Number(a.dedupe_sig === desired) ||
                a.id.localeCompare(b.id));
            for (const [index, row] of ordered.entries()) {
                targets.set(row.id, index === 0
                    ? { id: migratedProposalId(row, desired), sig: desired }
                    : { id: row.id, sig: `${desired}__legacy__${sha256Prefix(row.id, 12)}` });
            }
        }

        const changed = rows.filter((row) => {
            const target = targets.get(row.id)!;
            return target.id !== row.id || target.sig !== row.dedupe_sig;
        });
        yield* judgment.transaction((transaction) => Effect.gen(function* () {
            for (const row of changed) {
                const target = targets.get(row.id)!;
                if (target.id !== row.id) {
                    const payloadTable = proposalPayloadTable(row.form);
                    if (payloadTable !== null) {
                        yield* transaction.exec(
                            `UPDATE ${payloadTable} SET id = ? WHERE proposal = ?`,
                            [`__ax_dedupe_migration_tmp_payload__${row.id}`, row.id],
                        );
                    }
                }
                yield* transaction.exec(
                    "UPDATE proposal SET id = ?, dedupe_sig = ? WHERE id = ?",
                    [`__ax_dedupe_migration_tmp_id__${row.id}`, `__ax_dedupe_migration_tmp_sig__${row.id}`, row.id],
                );
            }
            for (const row of changed) {
                const target = targets.get(row.id)!;
                if (target.id !== row.id) {
                    const payloadTable = proposalPayloadTable(row.form);
                    if (payloadTable !== null) {
                        const payloadId = row.origin === "mined"
                            ? target.id
                            : stableId(payloadTable, [target.id]);
                        yield* transaction.exec(
                            `UPDATE ${payloadTable} SET id = ?, proposal = ? WHERE proposal = ?`,
                            [payloadId, target.id, row.id],
                        );
                    }
                    yield* transaction.exec(
                        "UPDATE experiment SET proposal = ? WHERE proposal = ?",
                        [target.id, row.id],
                    );
                }
                yield* transaction.exec(
                    "UPDATE proposal SET id = ?, dedupe_sig = ? WHERE id = ?",
                    [target.id, target.sig, `__ax_dedupe_migration_tmp_id__${row.id}`],
                );
            }

            for (const row of rows) {
                const target = targets.get(row.id)!;
                if (!target.sig.includes("__legacy__") || row.status !== "open" || row.reject_reason !== null) {
                    continue;
                }
                const payloadTable = proposalPayloadTable(row.form);
                if (payloadTable !== null) {
                    yield* transaction.exec(
                        `DELETE FROM ${payloadTable}
                         WHERE proposal = ?
                           AND NOT EXISTS (SELECT 1 FROM experiment WHERE proposal = ?)`,
                        [target.id, target.id],
                    );
                }
                yield* transaction.exec(
                    `DELETE FROM proposal
                     WHERE id = ? AND status = 'open' AND reject_reason IS NULL
                       AND NOT EXISTS (SELECT 1 FROM experiment WHERE proposal = ?)`,
                    [target.id, target.id],
                );
            }
        }));
    });

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
 * Build cache writes for a batch of derived rows. The proposal
 * row is partitioned by whether its dedupe_sig already exists in the DB:
 *  - new sig  : insert a fresh proposal row (baseline captured here).
 *  - existing : refresh the mutable fields; baseline and status untouched.
 *
 * `existingSigs` is the set of dedupe_sig values currently in the proposal
 * table. The caller (`deriveProposals`) fetches it once before computing
 * rows so the partition is consistent within one ingest pass.
 */
export const buildSkillProposalWrites = (
    rows: readonly SkillProposalRow[],
    existingSigs: ReadonlySet<string> = new Set(),
): ProposalWrite[] => {
    const writes: ProposalWrite[] = [];
    for (const row of rows) {
        writes.push(proposalWrite(row, "skill", { frequency: row.frequency, metrics: row.metrics }, existingSigs.has(row.sig)));
        writes.push({ store: "judgment", table: "skill_proposal", row: judgmentRow({ id: row.proposalKey,
            proposal: row.proposalKey, trigger_pattern: row.triggerPattern, suspected_gap: row.suspectedGap,
            proposed_behavior: row.proposedBehavior, expected_impact: row.expectedImpact }) });
        writes.push({ store: "cache", table: "cites_evidence", row: cacheRow({
            id: edgeRowId("cites_evidence", row.proposalKey, row.candidateKey, "skill_candidate"),
            in_id: row.proposalKey, out_id: row.candidateKey, in_table: "proposal",
            out_table: "skill_candidate", count: Number(row.metrics.fix_chain_count ?? row.frequency),
            kind: null, ts: new Date(),
        }) });
    }
    return writes;
};

/**
 * Mine every proposal form from cumulated evidence.
 *
 * All EVIDENCE is read through the lock-held cache writer, never `CacheRead`:
 * `skill_candidate`, `skill`, `turn` and `directive_ngram` are all written by
 * earlier stages of the SAME run, and the published snapshot holds none of it
 * (F1). All JUDGMENT - the proposals themselves and their payload rows - is read
 * from and written to the SQLite sidecar. See {@link ProposalWrite}.
 */
export const deriveProposals = (
    write: CacheWriteService,
    opts: DeriveProposalsOpts = { minFrequency: 3 },
): Effect.Effect<
    DeriveProposalsStats,
    CacheWriteError | CacheReadError | JudgmentError,
    Judgment | import("@ax/lib/process").ProcessService | FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const judgment = yield* Judgment;
        yield* migrateProposalDedupeSigs(judgment);
        const [candidates, skills, existingProposals] = yield* Effect.all([
            write.rows(Schema.Struct({
                id: Schema.String, name: Schema.String, trigger_pattern: Schema.String,
                suspected_gap: Schema.String, proposed_behavior: Schema.String, confidence: Schema.String,
                expected_impact: Schema.NullOr(Schema.String), metrics: Schema.NullOr(Schema.String),
            }), `
SELECT id, name, trigger_pattern, suspected_gap, proposed_behavior, confidence, expected_impact, metrics
FROM skill_candidate`),
            write.rows(Schema.Struct({ name: Schema.String }), "SELECT name FROM skill"),
            judgment.rows(Schema.Struct({ id: TextColumn, dedupe_sig: TextColumn, status: TextColumn,
                baseline: Schema.NullOr(TextColumn), created_at: Schema.NullOr(TimestampColumn) }),
                "SELECT id, dedupe_sig, status, baseline, created_at FROM proposal"),
        ], { concurrency: 3 });

        const existingSkillNames = new Set(skills.map((s) => normalizeTitle(s.name)));
        const existingSigs = new Set(existingProposals.map((p) => p.dedupe_sig));
        const { rows: skillRows, skipped: skillSkipped } =
            deriveSkillProposalRows(candidates, existingSkillNames, opts.minFrequency);
        const skillStmts = buildSkillProposalWrites(skillRows, existingSigs);

        // Phase C11: also derive guidance-form proposals from the harness
        // grounding - project-doctor logic that identifies "you should add a
        // guardrail" candidates; route those into the proposal pipeline as
        // guidance-form proposals.
        //
        // The GROUNDING, not the full report: `learningCandidates` comes from
        // git plus the guidance sources (see `mainBranchLearning`), while the
        // report's other half reads the published DuckDB snapshot. This stage
        // The same lock-held cache writer supplies all current-run data.
        const { buildHarnessGrounding } = yield* Effect.promise(() =>
            import("../project/harness.ts"),
        );
        const harnessGrounding = yield* buildHarnessGrounding();
        const { rows: guidanceRows, skipped: guidanceSkipped } =
            deriveGuidanceProposalRows(harnessGrounding.learningCandidates);
        const guidanceWrites = buildGuidanceProposalWrites(guidanceRows, existingSigs);

        // WHY THERE IS NO `Effect.orElseSucceed` ANYWHERE BELOW. Every read in
        // this stage goes through the lock-held cache writer, whose only error
        // channel is a STORE error - a missing table, a binder error, a decode
        // mismatch. Absent DATA is not an error here: an empty table returns an
        // empty row list. So a fallback could only ever convert a real defect
        // into "no proposals", which is exactly how this stage sat writing
        // nothing into the wrong store for a whole chunk without anyone noticing.
        // Any failure below fails the stage, loudly.

        // Routing proposal (form='hook'): installed CONFIGURATION is the source
        // of truth. Silent Allow verdicts do not create hook-fire evidence.
        const sinceDays = opts.sinceDays ?? 14;
        const dispatchResult = yield* fetchDispatchCandidates(write, { sinceDays });
        // Installed-state suppression is an optional local-config observation.
        // A missing, unreadable, or invalid settings file must not stop ingest.
        const configuredHooks = yield* readConfiguredHooks({ providerFilter: "claude" }).pipe(
            Effect.provide(HookProviderRegistryDefault),
            Effect.orElseSucceed((): ReadonlyArray<ConfiguredHook> => []),
        );
        const routingInstalled = hasActiveClaudeRouteDispatch(configuredHooks);
        if (routingInstalled) {
            yield* supersedeInstalledRoutingProposal(judgment);
        }
        const routingRow = deriveRoutingProposalRow({
            candidateCount: dispatchResult.candidates.length,
            totalEstSavingsUsd: dispatchResult.total_est_savings_usd,
            sinceDays,
            topClasses: dispatchResult.top_classes,
        });
        const routingWrites = routingRow && !routingInstalled
            ? buildRoutingProposalWrites(routingRow, existingSigs)
            : [];

        // Image context proposal (form='subagent'): derive from image-read analytics.
        const imageContextResult: ImageContextResult = yield* fetchImageContext(write, {
            sinceDays,
            limit: 0,
        });
        const imageContextRow = deriveImageContextProposalRow(imageContextResult, sinceDays);
        const imageContextWrites = imageContextRow
            ? buildImageContextProposalWrites(imageContextRow, existingSigs)
            : [];

        // Directive proposals (form='guidance'): mine proactive standing
        // instructions from user turns. Scoped to a fixed 90d window (not
        // ctx.sinceDays) so cross-session recurrence is captured consistently
        // whether this is a --since=1 watcher run or a full ingest.
        // Exclude claude-subagent-source turns: a subagent's first user turn is
        // the dispatch PROMPT ("You are implementing ONE task..."), not a user
        // directive - the other dominant false-positive class from the smoke.
        // The CAST is load-bearing: `CURRENT_TIMESTAMP` is TIMESTAMPTZ, and
        // TIMESTAMPTZ - INTERVAL needs the ICU extension, which the shipped
        // static build does not carry.
        const directiveTurns: ReadonlyArray<DirectiveTurnRow> = yield* write.rows(
            Schema.Struct({ id: Schema.String, session: Schema.String, text_excerpt: Schema.String, ts: Schema.String }), `
SELECT t.id, t.session, t.text_excerpt, CAST(t.ts AS VARCHAR) AS ts
FROM turn t JOIN session s ON s.id = t.session
WHERE t.role = 'user' AND t.text_excerpt IS NOT NULL AND t.text_excerpt != ''
  AND t.ts > CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - INTERVAL '90 days' AND s.source != 'claude-subagent'`);
        const directiveCandidates = deriveDirectiveCandidates(directiveTurns);

        // A5: Load the per-user directive lift table (built by the directive-ngrams
        // stage) and score candidates so the limit in deriveDirectiveProposalRows
        // keeps the highest-signal ones. An EMPTY table is normal (the ngrams
        // stage may not have run yet) and scoring falls back to seed order; a
        // failed query is not, and stops the stage.
        const liftRows = yield* write.rows(
            Schema.Struct({ ngram: Schema.String, lift: Schema.Number }),
            "SELECT ngram, lift FROM directive_ngram WHERE lift > 0",
        );
        const liftMap = new Map<string, number>();
        for (const row of liftRows) liftMap.set(row.ngram, row.lift);
        const directiveLiftMap: ReadonlyMap<string, number> = liftMap;
        const scoredDirectiveCandidates = scoreDirectiveCandidates(directiveCandidates, directiveLiftMap);

        const { rows: directiveRows, skipped: directiveSkipped } =
            deriveDirectiveProposalRows(scoredDirectiveCandidates);
        const directiveWrites = buildGuidanceProposalWrites(directiveRows, existingSigs);

        // Workflow proposals (form='guidance', section='workflows'): derive recurring
        // skill-arc patterns into codification suggestions (milestone B, #588).
        const workflowArcs: ReadonlyArray<ArcCandidate> = yield* fetchWorkflowArcs(write);
        const { rows: workflowRows, skipped: workflowSkipped } =
            deriveWorkflowProposalRows(workflowArcs);
        const workflowWrites = workflowRows.length > 0
            ? buildGuidanceProposalWrites(workflowRows, existingSigs)
            : [];

        // Cache-lens proposals (form='guidance', section='cache-lens'): auto-mint
        // top cache-busting offenders from the SAME run's cache-bust ledger
        // ("cache-bust" is a declared dep below, so cache_bust_event is already
        // populated in the live write service by the time this query runs).
        // The cap needs to know how many section='cache-lens' proposals are
        // ALREADY open so a re-derive of an already-minted offender refreshes
        // for free while a genuinely new offender draws against the remaining
        // capacity - see deriveCacheLensProposalRows.
        const existingCacheLensOpen = yield* judgment.rows(
            Schema.Struct({ dedupe_sig: TextColumn }), `
SELECT p.dedupe_sig AS dedupe_sig
FROM proposal p JOIN guidance_proposal g ON g.proposal = p.id
WHERE p.form = 'guidance' AND g.section = ? AND p.status = 'open'`,
            [CACHE_LENS_SECTION]);
        const existingCacheLensOpenSigs = new Set(existingCacheLensOpen.map((r) => r.dedupe_sig));
        // Evaluation window FLOORED at 14 days, independent of the ingest
        // since-window: a warm `--since=1` run would otherwise evaluate a
        // 1-day window too narrow for the >=2-sessions recurrence guard to
        // reliably see genuine recurrence (minting starved on exactly the
        // runs that dominate) and the x7 weekly extrapolation would rest on a
        // single day's sample. The ledger is cumulative (incremental upserts
        // keyed by ttu.id), so
        // reading 14d back on a warm run is always valid.
        const cacheLensWindowDays = Math.max(sinceDays, 14);
        const cacheLensCandidates = yield* fetchCacheLensCandidates(write, { sinceDays: cacheLensWindowDays });
        const { rows: cacheLensRows, skipped: cacheLensSkipped } = deriveCacheLensProposalRows(cacheLensCandidates, {
            sinceDays: cacheLensWindowDays,
            cap: CACHE_LENS_PROPOSAL_CAP,
            existingOpenSigs: existingCacheLensOpenSigs,
        });
        const cacheLensWrites = buildCacheLensProposalWrites(cacheLensRows, existingSigs);

        const existingBySig = new Map(existingProposals.map((row) => [row.dedupe_sig, row]));
        const writes = [...skillStmts, ...guidanceWrites, ...routingWrites, ...imageContextWrites, ...directiveWrites, ...workflowWrites, ...cacheLensWrites];
        for (const item of writes) {
            if (item.store === "cache") {
                yield* write.put(item.table, item.row);
                continue;
            }
            if (item.table === "proposal") {
                const sig = String(item.row.dedupe_sig);
                const existing = existingBySig.get(sig);
                if (existing) {
                    // Re-derive must not resurrect a rejected proposal as `open`
                    // nor reset the baseline captured when it was accepted.
                    yield* judgment.put(item.table, judgmentRow({ ...item.row, id: existing.id,
                        status: existing.status, baseline: existing.baseline,
                        created_at: existing.created_at ?? new Date() }));
                    continue;
                }
            }
            yield* judgment.put(item.table, item.row);
        }
        return {
            skillProposals: skillRows.length,
            guidanceProposals: guidanceRows.length,
            routingProposals: routingRow && !routingInstalled ? 1 : 0,
            imageContextProposals: imageContextRow ? 1 : 0,
            directiveProposals: directiveRows.length,
            workflowProposals: workflowRows.length,
            cacheLensProposals: cacheLensRows.length,
            skipped: skillSkipped + guidanceSkipped + directiveSkipped + workflowSkipped + cacheLensSkipped,
        };
    });

// ---------------------------------------------------------------------------
// Co-located StageDef
// ---------------------------------------------------------------------------

import { BaseStageStats, IngestContext, sinceDaysFromCtx, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";
import type { ProcessService } from "@ax/lib/process";

export const ProposalsKey = Schema.Literal("proposals");
export type ProposalsKey = typeof ProposalsKey.Type;

/**
 * Proposals stage - derives Skill + Guidance + Routing + Image-Context +
 * Workflow + Cache-Lens Proposals from cumulated evidence. Depends on
 * {@link ClosureKey} + the cache-bust ledger (for cache-lens candidates).
 * Consumed by {@link OpportunitiesKey}, {@link RetroProposalsKey}.
 */
export class ProposalsStats extends BaseStageStats.extend<ProposalsStats>("ProposalsStats")({
    skillProposals: Schema.Number,
    guidanceProposals: Schema.Number,
    routingProposals: Schema.Number,
    imageContextProposals: Schema.Number,
    directiveProposals: Schema.Number,
    workflowProposals: Schema.Number,
    cacheLensProposals: Schema.Number,
}) {}

export const proposalsStage: StageDef<
    ProposalsStats,
    Judgment | ProcessService | FileSystem.FileSystem | Path.Path,
    CacheWriteError | CacheReadError | JudgmentError
> = {
    meta: StageMeta.make({
        // Cache-lens candidates use THIS run's ledger, OTLP metrics, and
        // spawned lineage through the live write service.
        key: "proposals", deps: ["closure", "cache-bust", "otel-spool", "spawned"], tags: ["derive"],
        writes: [{ table: "cites_evidence", mode: "derive" }],
    }),
    run: (ctx: IngestContext, write: CacheWriteService) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const sinceDays = sinceDaysFromCtx(ctx);
            const result = yield* deriveProposals(write, { minFrequency: 3, sinceDays });
            return ProposalsStats.make({
                durationMs: Date.now() - t0,
                summary: `derived ${result.skillProposals} skill proposals, ${result.guidanceProposals} guidance proposals, ${result.routingProposals} routing proposals, ${result.imageContextProposals} image-context proposals, ${result.directiveProposals} directive proposals, ${result.workflowProposals} workflow proposals, ${result.cacheLensProposals} cache-lens proposals`,
                skillProposals: result.skillProposals,
                guidanceProposals: result.guidanceProposals,
                routingProposals: result.routingProposals,
                imageContextProposals: result.imageContextProposals,
                directiveProposals: result.directiveProposals,
                workflowProposals: result.workflowProposals,
                cacheLensProposals: result.cacheLensProposals,
            });
        }),
};
