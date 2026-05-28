/**
 * Derive-Retro-Proposals Stage: cluster repeating tool-failure signals
 * across `retro` rows and emit `skill`-form proposals.
 *
 * The retro emitter (src/ingest/retro.ts) writes one row per session whose
 * `failed` field contains strings like "Bash failed ×3 · friction kinds:
 * tool_error". This stage parses the `<Tool> failed ×<N>` substring,
 * clusters by (lowercased tool name) across the last N days, and emits a
 * `Pre-<Tool> guard` skill proposal when a tool recurs across ≥2 sessions
 * and ≥2 retros with a total count ≥3.
 *
 * Wedge scope: ONLY the "<Tool> failed ×<N>" shape. Other shapes
 * (corrections, friction kinds, free-text failures) are deliberately
 * out-of-scope for this commit - they'd require their own detectors.
 *
 * Why a separate stage from derive-proposals.ts? The proposals stage
 * reads `skill_candidate` (closure-stage output keyed on fix-chain
 * overlap). Retro-derived candidates come from a different evidence
 * source (per-session friction summaries) and have no fix-chain to cite,
 * so they bypass `skill_candidate` and write directly to `proposal` +
 * `skill_proposal`. The cluster -> proposal map is captured in
 * `proposal.baseline` JSON (tool + retroKeys + sessionKeys) since
 * `cites_evidence` doesn't yet support `retro` in its TO union.
 */

import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { AppLayer } from "../lib/layers.ts";
import type { DbError } from "../lib/errors.ts";
import {
    recordRef,
    surrealObject,
    surrealOptionString,
    surrealString,
} from "../lib/shared/surql.ts";
import { executeStatementsWith } from "../lib/shared/statement-exec.ts";
import { safeKeyPart, recordKeyPart } from "../lib/shared/derive-keys.ts";
import { dedupeSig, normalizeTitle } from "./derive-proposals.ts";

export interface DeriveRetroProposalsStats {
    readonly toolFailureProposals: number;
    readonly correctionProposals: number;
    readonly frictionProposals: number;
    readonly clusters: number;
    readonly skipped: number;
}

/** A single failure mention parsed out of `retro.failed`. */
export interface ParsedToolFailure {
    readonly tool: string;
    readonly count: number;
}

/**
 * Extract every `<Tool> failed ×<N>` substring from a `retro.failed` value.
 *
 * The pattern is anchored on word boundaries and uses an alphanumeric/
 * underscore/hyphen tool-name shape to match the strings the heuristic
 * retro emitter produces (e.g. "Bash failed ×3", "Read failed ×2").
 * Free-text `failed` values that don't include this exact substring
 * yield an empty array - they're out-of-scope for this wedge.
 */
const TOOL_FAILED_RE =
    /\b([A-Za-z_][A-Za-z0-9_-]*)\s+failed\s+×(\d+)\b/g;

export const parseRetroFailed = (
    failed: string | null,
): Array<ParsedToolFailure> => {
    if (failed === null || failed === undefined) return [];
    const out: ParsedToolFailure[] = [];
    // Clone the regex each call - global regex state on a module-level
    // RegExp would leak across calls.
    const re = new RegExp(TOOL_FAILED_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(failed)) !== null) {
        const tool = m[1] ?? "";
        const count = Number(m[2] ?? 0);
        if (tool.length === 0 || !Number.isFinite(count) || count <= 0) continue;
        out.push({ tool, count });
    }
    return out;
};

export interface RetroFailureRow {
    readonly retroKey: string;
    readonly sessionKey: string;
    readonly failed: string | null;
    /** Pre-parsed user-correction count from {@link parseRetroCorrections}. */
    readonly corrections?: number;
    /** Pre-parsed friction kinds from {@link parseRetroFrictionKinds}. */
    readonly frictionKinds?: readonly string[];
}

/**
 * Extract the leading "<N> user correction(s)" count from a `retro.failed`
 * string. Returns 0 if the pattern isn't present.
 *
 * Picks the FIRST `<N> user correction` match (the retro emitter only ever
 * writes one such phrase per session, but be defensive). Plural "(s)" is
 * optional - we accept both "1 user correction" and "5 user correction(s)".
 */
const CORRECTIONS_RE = /(\d+)\s+user\s+correction(?:\(s\)|s)?\b/i;

export const parseRetroCorrections = (failed: string | null): number => {
    if (failed === null || failed === undefined) return 0;
    const m = CORRECTIONS_RE.exec(failed);
    if (!m) return 0;
    const n = Number(m[1] ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Extract friction-kind tokens from the "friction kinds: a, b, c" segment
 * of `retro.failed`. Each kind is lower-snake (e.g. "tool_error",
 * "user_correction") and any trailing `·`-separated segment is dropped.
 * Returns [] when the pattern isn't present.
 */
const FRICTION_KINDS_RE = /friction\s+kinds?\s*:\s*([^·]*)/i;
const FRICTION_KIND_TOKEN_RE = /^[a-z][a-z0-9_]*$/;

export const parseRetroFrictionKinds = (failed: string | null): string[] => {
    if (failed === null || failed === undefined) return [];
    const m = FRICTION_KINDS_RE.exec(failed);
    if (!m) return [];
    const raw = (m[1] ?? "").trim();
    if (raw.length === 0) return [];
    const out: string[] = [];
    for (const part of raw.split(",")) {
        const tok = part.trim().toLowerCase();
        if (tok.length === 0) continue;
        if (!FRICTION_KIND_TOKEN_RE.test(tok)) continue;
        out.push(tok);
    }
    return out;
};

export interface RetroCluster {
    readonly tool: string;
    readonly toolLower: string;
    readonly totalCount: number;
    readonly retroKeys: readonly string[];
    readonly sessionKeys: readonly string[];
}

interface MutableCluster {
    tool: string;
    toolLower: string;
    totalCount: number;
    retroKeys: Set<string>;
    sessionKeys: Set<string>;
}

export interface ClusterRetroToolFailuresOpts {
    readonly minSessions: number;
    readonly minRetros: number;
    readonly minTotalCount: number;
}

/**
 * Group parsed failures across retros by (lowercased tool name).
 *
 * The cased name preserved on the cluster is the FIRST one seen - so
 * a mix of "Bash" and "bash" mentions both land in one cluster and
 * the rendered proposal title uses whichever variant arrived first
 * (deterministic given input order).
 *
 * Clusters are sorted by descending totalCount so the caller can take
 * the head N if it wants to cap output.
 */
export const clusterRetroToolFailures = (
    rows: readonly RetroFailureRow[],
    opts: ClusterRetroToolFailuresOpts,
): RetroCluster[] => {
    const byTool = new Map<string, MutableCluster>();
    for (const row of rows) {
        const mentions = parseRetroFailed(row.failed);
        for (const mention of mentions) {
            const toolLower = mention.tool.toLowerCase();
            let cluster = byTool.get(toolLower);
            if (!cluster) {
                cluster = {
                    tool: mention.tool,
                    toolLower,
                    totalCount: 0,
                    retroKeys: new Set<string>(),
                    sessionKeys: new Set<string>(),
                };
                byTool.set(toolLower, cluster);
            }
            cluster.totalCount += mention.count;
            cluster.retroKeys.add(row.retroKey);
            cluster.sessionKeys.add(row.sessionKey);
        }
    }
    const out: RetroCluster[] = [];
    for (const cluster of byTool.values()) {
        if (cluster.sessionKeys.size < opts.minSessions) continue;
        if (cluster.retroKeys.size < opts.minRetros) continue;
        if (cluster.totalCount < opts.minTotalCount) continue;
        out.push({
            tool: cluster.tool,
            toolLower: cluster.toolLower,
            totalCount: cluster.totalCount,
            retroKeys: [...cluster.retroKeys],
            sessionKeys: [...cluster.sessionKeys],
        });
    }
    out.sort((a, b) => b.totalCount - a.totalCount);
    return out;
};

export interface RetroCorrectionCluster {
    readonly totalCorrections: number;
    readonly retroKeys: readonly string[];
    readonly sessionKeys: readonly string[];
}

export interface RetroFrictionCluster {
    readonly kind: string;
    /** Distinct retros mentioning this kind. */
    readonly totalCount: number;
    readonly retroKeys: readonly string[];
    readonly sessionKeys: readonly string[];
}

export interface ClusterRetroCorrectionsOpts {
    readonly minSessions: number;
    readonly minTotalCorrections: number;
}

/**
 * Aggregate the per-row `corrections` count across distinct sessions.
 * Returns a single cluster (or null) - we don't try to cluster by topic
 * here, just by recurrence.
 *
 * Threshold: ≥minSessions distinct sessions and ≥minTotalCorrections summed
 * corrections. The caller pre-parses `corrections` via
 * {@link parseRetroCorrections} so this stays pure.
 */
export const clusterRetroCorrections = (
    rows: readonly RetroFailureRow[],
    opts: ClusterRetroCorrectionsOpts,
): RetroCorrectionCluster | null => {
    let totalCorrections = 0;
    const retroKeys = new Set<string>();
    const sessionKeys = new Set<string>();
    for (const row of rows) {
        const n = row.corrections ?? parseRetroCorrections(row.failed);
        if (n <= 0) continue;
        totalCorrections += n;
        retroKeys.add(row.retroKey);
        sessionKeys.add(row.sessionKey);
    }
    if (sessionKeys.size < opts.minSessions) return null;
    if (totalCorrections < opts.minTotalCorrections) return null;
    return {
        totalCorrections,
        retroKeys: [...retroKeys],
        sessionKeys: [...sessionKeys],
    };
};

interface MutableFrictionCluster {
    kind: string;
    retroKeys: Set<string>;
    sessionKeys: Set<string>;
}

export interface ClusterRetroFrictionKindsOpts {
    readonly minSessions: number;
    readonly minRetros: number;
}

/**
 * Group rows by friction-kind token. One cluster per kind, sorted by
 * descending totalCount (== distinct retros mentioning the kind). Each
 * kind must hit both thresholds (sessions, retros) to survive.
 *
 * `totalCount` is intentionally `retroKeys.size`, not a sum of mentions -
 * the retro emitter only emits one friction-kinds string per session, so
 * "how many retros mentioned this" is the right ranking signal.
 */
export const clusterRetroFrictionKinds = (
    rows: readonly RetroFailureRow[],
    opts: ClusterRetroFrictionKindsOpts,
): RetroFrictionCluster[] => {
    const byKind = new Map<string, MutableFrictionCluster>();
    for (const row of rows) {
        const kinds = row.frictionKinds ?? parseRetroFrictionKinds(row.failed);
        for (const kind of kinds) {
            let cluster = byKind.get(kind);
            if (!cluster) {
                cluster = {
                    kind,
                    retroKeys: new Set<string>(),
                    sessionKeys: new Set<string>(),
                };
                byKind.set(kind, cluster);
            }
            cluster.retroKeys.add(row.retroKey);
            cluster.sessionKeys.add(row.sessionKey);
        }
    }
    const out: RetroFrictionCluster[] = [];
    for (const c of byKind.values()) {
        if (c.sessionKeys.size < opts.minSessions) continue;
        if (c.retroKeys.size < opts.minRetros) continue;
        out.push({
            kind: c.kind,
            totalCount: c.retroKeys.size,
            retroKeys: [...c.retroKeys],
            sessionKeys: [...c.sessionKeys],
        });
    }
    out.sort((a, b) => b.totalCount - a.totalCount);
    return out;
};

export interface RetroSkillProposalRow {
    readonly proposalKey: string;
    readonly title: string;
    readonly hypothesis: string;
    readonly triggerPattern: string;
    readonly suspectedGap: string;
    readonly proposedBehavior: string;
    readonly expectedImpact: string | null;
    readonly confidence: string;
    readonly frequency: number;
    readonly sig: string;
    readonly tool: string;
    readonly retroKeys: readonly string[];
    readonly sessionKeys: readonly string[];
}

const confidenceFor = (totalCount: number): string =>
    totalCount >= 10 ? "high" : totalCount >= 5 ? "medium" : "low";

const proposalKeyFor = (tool: string, sig: string): string =>
    `skill__retro__${safeKeyPart(tool).slice(0, 40)}__${sig.slice(-12)}`;

/**
 * Turn each cluster into a proposal row. A cluster whose normalized
 * title collides with an existing skill is skipped - we'd rather
 * surface "you have a guard already; it isn't firing" via the verdict
 * pipeline than emit a confusing duplicate.
 */
export const deriveRetroProposalRows = (
    clusters: readonly RetroCluster[],
    existingSkillNames: ReadonlySet<string>,
): { readonly rows: RetroSkillProposalRow[]; readonly skipped: number } => {
    const rows: RetroSkillProposalRow[] = [];
    let skipped = 0;
    for (const cluster of clusters) {
        const title = `Pre-${cluster.tool} guard`;
        const normTitle = normalizeTitle(title);
        if (existingSkillNames.has(normTitle)) { skipped += 1; continue; }
        const sig = dedupeSig("skill", normTitle);
        rows.push({
            proposalKey: proposalKeyFor(cluster.tool, sig),
            title,
            hypothesis: `${cluster.tool} failed ${cluster.totalCount} time(s) across ${cluster.sessionKeys.length} sessions; guard the call before invoking.`,
            triggerPattern: `tool=${cluster.tool}`,
            suspectedGap: `repeated ${cluster.tool} failures without a pre-call validation`,
            proposedBehavior: `validate ${cluster.tool} preconditions before invocation; on miss, surface a corrective message`,
            expectedImpact: `reduce ${cluster.tool} failure rate`,
            confidence: confidenceFor(cluster.totalCount),
            frequency: cluster.totalCount,
            sig,
            tool: cluster.tool,
            retroKeys: cluster.retroKeys,
            sessionKeys: cluster.sessionKeys,
        });
    }
    return { rows, skipped };
};

/**
 * Build the SurrealQL statements for a batch of derived rows.
 *
 * Mirrors {@link buildSkillProposalStatements} in derive-proposals.ts:
 * a fresh dedupe_sig becomes a `CREATE proposal` with frozen baseline +
 * status='open'; an existing sig becomes a minimal `UPDATE` of mutable
 * fields only. The `skill_proposal` payload is UPSERT-ed in both paths.
 *
 * Unlike the skill_candidate-sourced version, this writer does NOT emit
 * `cites_evidence` edges - the `retro` table isn't in the
 * `cites_evidence TO` union yet. Provenance is captured in the
 * `baseline` JSON instead (`tool`, `retroKeys`, `sessionKeys`).
 */
export const buildRetroSkillProposalStatements = (
    rows: readonly RetroSkillProposalRow[],
    existingSigs: ReadonlySet<string> = new Set(),
): string[] => {
    const stmts: string[] = [];
    for (const row of rows) {
        const proposalRef = recordRef("proposal", row.proposalKey);
        const payloadRef = recordRef("skill_proposal", row.proposalKey);
        const baseline = JSON.stringify({
            tool: row.tool,
            frequency: row.frequency,
            retroKeys: row.retroKeys,
            sessionKeys: row.sessionKeys,
        });
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
        );
    }
    return stmts;
};

/**
 * Correction-pressure guidance proposal: when a user keeps correcting
 * Claude across multiple sessions, that's signal of a missing rule in
 * CLAUDE.md / AGENTS.md. The proposal's `fileTarget` is hardcoded to
 * CLAUDE.md (the project-level guidance file); the user can move it.
 */
export interface RetroGuidanceProposalRow {
    readonly proposalKey: string;
    readonly title: string;
    readonly hypothesis: string;
    readonly fileTarget: string;
    readonly section: string;
    readonly suggestedText: string;
    readonly confidence: string;
    readonly frequency: number;
    readonly sig: string;
    readonly retroKeys: readonly string[];
    readonly sessionKeys: readonly string[];
}

const correctionConfidenceFor = (totalCorrections: number): string =>
    totalCorrections >= 10 ? "high" : totalCorrections >= 5 ? "medium" : "low";

const correctionProposalKey = (sig: string): string =>
    `guidance__retro_corrections__${sig.slice(-12)}`;

export const deriveRetroCorrectionProposalRows = (
    cluster: RetroCorrectionCluster | null,
): {
    readonly rows: RetroGuidanceProposalRow[];
    readonly skipped: number;
} => {
    if (cluster === null) return { rows: [], skipped: 0 };
    const title = "Reduce recurring user corrections";
    const normTitle = normalizeTitle(title);
    const sig = dedupeSig("guidance", normTitle);
    return {
        rows: [{
            proposalKey: correctionProposalKey(sig),
            title,
            hypothesis: `${cluster.totalCorrections} corrections across ${cluster.sessionKeys.length} sessions; gap in CLAUDE.md likely.`,
            fileTarget: "CLAUDE.md",
            section: "Corrections",
            suggestedText: `Address recurring user corrections (${cluster.totalCorrections} across ${cluster.sessionKeys.length} sessions) - review recent transcripts and codify the missing rule.`,
            confidence: correctionConfidenceFor(cluster.totalCorrections),
            frequency: cluster.totalCorrections,
            sig,
            retroKeys: cluster.retroKeys,
            sessionKeys: cluster.sessionKeys,
        }],
        skipped: 0,
    };
};

/**
 * Mirror of {@link buildRetroSkillProposalStatements} but emits `form="guidance"`
 * + `guidance_proposal` payload. Baseline JSON encodes
 * `kind:"corrections"` so the verdict layer can recognize the source.
 */
export const buildRetroCorrectionGuidanceStatements = (
    rows: readonly RetroGuidanceProposalRow[],
    existingSigs: ReadonlySet<string> = new Set(),
): string[] => {
    const stmts: string[] = [];
    for (const row of rows) {
        const proposalRef = recordRef("proposal", row.proposalKey);
        const payloadRef = recordRef("guidance_proposal", row.proposalKey);
        const baseline = JSON.stringify({
            kind: "corrections",
            totalCorrections: row.frequency,
            retroKeys: row.retroKeys,
            sessionKeys: row.sessionKeys,
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

/**
 * One skill proposal per recurring friction kind. The skill title encodes
 * the kind so a `command_failed` cluster and a `tool_error` cluster won't
 * collide via dedupe_sig.
 */
export interface RetroFrictionSkillProposalRow {
    readonly proposalKey: string;
    readonly title: string;
    readonly hypothesis: string;
    readonly triggerPattern: string;
    readonly suspectedGap: string;
    readonly proposedBehavior: string;
    readonly expectedImpact: string | null;
    readonly confidence: string;
    readonly frequency: number;
    readonly sig: string;
    readonly kind: string;
    readonly retroKeys: readonly string[];
    readonly sessionKeys: readonly string[];
}

const frictionProposalKey = (kind: string, sig: string): string =>
    `skill__retro_friction__${safeKeyPart(kind).slice(0, 40)}__${sig.slice(-12)}`;

export const deriveRetroFrictionSkillRows = (
    clusters: readonly RetroFrictionCluster[],
    existingSkillNames: ReadonlySet<string>,
): {
    readonly rows: RetroFrictionSkillProposalRow[];
    readonly skipped: number;
} => {
    const rows: RetroFrictionSkillProposalRow[] = [];
    let skipped = 0;
    for (const cluster of clusters) {
        const title = `Address recurring ${cluster.kind} friction`;
        const normTitle = normalizeTitle(title);
        if (existingSkillNames.has(normTitle)) { skipped += 1; continue; }
        const sig = dedupeSig("skill", normTitle);
        rows.push({
            proposalKey: frictionProposalKey(cluster.kind, sig),
            title,
            hypothesis: `${cluster.kind} friction appeared in ${cluster.sessionKeys.length} sessions`,
            triggerPattern: `friction_kind=${cluster.kind}`,
            suspectedGap: `recurring ${cluster.kind} signals across sessions without a guard`,
            proposedBehavior: `detect ${cluster.kind} pre-conditions and intervene before the friction surfaces`,
            expectedImpact: `reduce ${cluster.kind} occurrence rate`,
            confidence: confidenceFor(cluster.totalCount),
            frequency: cluster.totalCount,
            sig,
            kind: cluster.kind,
            retroKeys: cluster.retroKeys,
            sessionKeys: cluster.sessionKeys,
        });
    }
    return { rows, skipped };
};

export const buildRetroFrictionSkillStatements = (
    rows: readonly RetroFrictionSkillProposalRow[],
    existingSigs: ReadonlySet<string> = new Set(),
): string[] => {
    const stmts: string[] = [];
    for (const row of rows) {
        const proposalRef = recordRef("proposal", row.proposalKey);
        const payloadRef = recordRef("skill_proposal", row.proposalKey);
        const baseline = JSON.stringify({
            kind: row.kind,
            frequency: row.frequency,
            retroKeys: row.retroKeys,
            sessionKeys: row.sessionKeys,
        });
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
                ["trigger_pattern", surrealString(row.triggerPattern)],
                ["suspected_gap", surrealString(row.suspectedGap)],
                ["proposed_behavior", surrealString(row.proposedBehavior)],
                ["expected_impact", surrealOptionString(row.expectedImpact)],
            ])};`,
        );
    }
    return stmts;
};

export interface DeriveRetroProposalsOpts {
    readonly sinceDays?: number | undefined;
    readonly minSessions?: number;
    readonly minRetros?: number;
    readonly minTotalCount?: number;
    readonly minTotalCorrections?: number;
}

interface RetroFetchRow {
    readonly id: string | { tb: string; id: string };
    readonly session: string | { tb: string; id: string } | null;
    readonly failed: string | null;
}

interface SkillNameRow {
    readonly name: string;
}

interface ProposalSigRow {
    readonly dedupe_sig: string;
}

export const deriveRetroProposals = (
    opts: DeriveRetroProposalsOpts = {},
): Effect.Effect<DeriveRetroProposalsStats, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const sinceDays = opts.sinceDays ?? 30;
        const minSessions = opts.minSessions ?? 2;
        const minRetros = opts.minRetros ?? 2;
        const minTotalCount = opts.minTotalCount ?? 3;
        const minTotalCorrections = opts.minTotalCorrections ?? 3;
        const db = yield* SurrealClient;

        const [retros, skills, existingProposals] = yield* Effect.all([
            db.query<[RetroFetchRow[]]>(
                `SELECT id, session, failed FROM retro WHERE failed != NONE AND created_at > time::now() - ${sinceDays}d;`,
            ).pipe(Effect.map((rows) => rows?.[0] ?? [])),
            db.query<[SkillNameRow[]]>(`SELECT name FROM skill;`).pipe(
                Effect.map((rows) => rows?.[0] ?? []),
            ),
            db.query<[ProposalSigRow[]]>(`SELECT dedupe_sig FROM proposal;`).pipe(
                Effect.map((rows) => rows?.[0] ?? []),
            ),
        ], { concurrency: 3 });

        const failureRows: RetroFailureRow[] = [];
        for (const r of retros) {
            const retroKey = recordKeyPart(r.id, "retro");
            const sessionKey = r.session ? recordKeyPart(r.session, "session") : null;
            if (!retroKey || !sessionKey) continue;
            failureRows.push({
                retroKey,
                sessionKey,
                failed: r.failed,
                // Pre-parse here so the pure cluster functions don't re-scan
                // the raw string twice per row.
                corrections: parseRetroCorrections(r.failed),
                frictionKinds: parseRetroFrictionKinds(r.failed),
            });
        }

        const clusters = clusterRetroToolFailures(failureRows, {
            minSessions,
            minRetros,
            minTotalCount,
        });
        const correctionCluster = clusterRetroCorrections(failureRows, {
            minSessions,
            minTotalCorrections,
        });
        const frictionClusters = clusterRetroFrictionKinds(failureRows, {
            minSessions,
            minRetros,
        });
        const existingSkillNames = new Set(
            skills.map((s) => normalizeTitle(s.name)),
        );
        const existingSigs = new Set(
            existingProposals.map((p) => p.dedupe_sig),
        );
        const { rows: toolRows, skipped: toolSkipped } =
            deriveRetroProposalRows(clusters, existingSkillNames);
        const { rows: correctionRows, skipped: correctionSkipped } =
            deriveRetroCorrectionProposalRows(correctionCluster);
        const { rows: frictionRows, skipped: frictionSkipped } =
            deriveRetroFrictionSkillRows(frictionClusters, existingSkillNames);

        const stmts = [
            ...buildRetroSkillProposalStatements(toolRows, existingSigs),
            ...buildRetroCorrectionGuidanceStatements(correctionRows, existingSigs),
            ...buildRetroFrictionSkillStatements(frictionRows, existingSigs),
        ];
        yield* executeStatementsWith(db, stmts, { chunkSize: 500 });
        return {
            toolFailureProposals: toolRows.length,
            correctionProposals: correctionRows.length,
            frictionProposals: frictionRows.length,
            clusters: clusters.length + frictionClusters.length + (correctionCluster ? 1 : 0),
            skipped: toolSkipped + correctionSkipped + frictionSkipped,
        };
    });

if (import.meta.main) {
    await Effect.runPromise(
        deriveRetroProposals().pipe(
            Effect.provide(AppLayer),
            Effect.scoped,
        ) as Effect.Effect<DeriveRetroProposalsStats>,
    );
}

// ---------------------------------------------------------------------------
// Co-located StageDef
// ---------------------------------------------------------------------------

import { Schema } from "effect";
import { BaseStageStats, IngestContext, sinceDaysFromCtx, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

export const RetroProposalsKey = Schema.Literal("retro-proposals");
export type RetroProposalsKey = typeof RetroProposalsKey.Type;

/**
 * Retro-proposals stage - clusters per-session retro `failed` strings into
 * skill-form proposals. Depends on {@link ProposalsKey}.
 */
export class RetroProposalsStats extends BaseStageStats.extend<RetroProposalsStats>("RetroProposalsStats")({
    toolFailureProposals: Schema.Number,
    clusters: Schema.Number,
}) {}

export const retroProposalsStage: StageDef<RetroProposalsStats, SurrealClient> = {
    meta: StageMeta.make({ key: "retro-proposals", deps: ["proposals"], tags: ["derive", "retro"] }),
    run: (ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const sinceDays = sinceDaysFromCtx(ctx);
            const result = yield* deriveRetroProposals({ sinceDays });
            return RetroProposalsStats.make({
                durationMs: Date.now() - t0,
                summary: `derived ${result.toolFailureProposals} tool-failure proposals from ${result.clusters} clusters`,
                toolFailureProposals: result.toolFailureProposals,
                clusters: result.clusters,
            });
        }),
};
