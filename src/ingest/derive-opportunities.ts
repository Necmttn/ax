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
 *    was_addressed if a hook_command_invocation referencing the scaffold's
 *    basename fired within ±ADDRESSED_WINDOW_MS.
 *  - guidance: friction_event rows of kind='correction'; was_addressed if
 *    the target file's mtime is later than the opportunity's matched_at.
 *  - automation/subagent: explicitly skipped pending detectors.
 *
 * The opportunity row is a RELATION (in=experiment, out=evidence record).
 * Edge id = sha-style key over (experimentKey, evidenceKey) so re-derive
 * passes are idempotent.
 */

import { Effect, Schema } from "effect";
import { homedir } from "node:os";
import { statSync } from "node:fs";
import { SurrealClient } from "../lib/db.ts";
import { AppLayer } from "../lib/layers.ts";
import type { DbError } from "../lib/errors.ts";
import { recordRef, surrealDate } from "../lib/shared/surql.ts";
import { surrealLiteral } from "../lib/json.ts";
import { executeStatementsWith } from "../lib/shared/statement-exec.ts";
import { safeKeyPart, recordKeyPart } from "../lib/shared/derive-keys.ts";

export interface DeriveOpportunitiesStats {
    readonly experimentsScanned: number;
    readonly opportunities: number;
    readonly addressed: number;
    readonly bySkillForm: number;
    readonly byHookForm: number;
    readonly byGuidanceForm: number;
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

export const kebabNameFromArtifactPath = (path: string | null): string | null => {
    if (!path) return null;
    const parts = path.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    // .../<kebab-name>/SKILL.md
    const dir = parts[parts.length - 2];
    return dir ?? null;
};

/**
 * Extract the hook script basename from an experiment's artifact_path,
 * e.g. `/Users/x/.claude/hooks/pre-bash-guard.sh` → `pre-bash-guard.sh`.
 * Returns null for empty/non-.sh paths.
 */
export const hookBasenameFromArtifactPath = (path: string | null): string | null => {
    if (!path) return null;
    const last = path.split("/").pop();
    return last && last.endsWith(".sh") ? last : null;
};

/**
 * Parse a skill_proposal.trigger_pattern of the form `tool=<Name>` and
 * return the tool name. Returns null for any other shape.
 */
export const parseSkillTriggerTool = (pattern: string): string | null => {
    const m = /^tool=(.+)$/.exec(pattern.trim());
    return m && m[1] ? m[1].trim() : null;
};

/**
 * Resolve a guidance_proposal.file_target to an absolute filesystem path.
 * - "CLAUDE.md" / "AGENTS.md" → `<home>/.claude/<file>`
 * - "~/foo" → `<home>/foo`
 * - absolute paths returned unchanged
 * - anything else returned unchanged (caller defends against stat failure)
 */
export const resolveGuidanceTargetPath = (target: string, home: string): string => {
    const t = target.trim();
    if (t.startsWith("/")) return t;
    if (t.startsWith("~/")) return `${home}/${t.slice(2)}`;
    if (t === "CLAUDE.md" || t === "AGENTS.md") return `${home}/.claude/${t}`;
    return t;
};

interface ActiveExperimentRow {
    readonly id: string | { tb: string; id: string };
    readonly created_at: string;
    readonly form: string;
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

interface FrictionEventRow {
    readonly id: string | { tb: string; id: string };
    readonly ts: string;
}

interface HookInvocationTsRow {
    readonly ts: string;
}

export const opportunityKey = (experimentKey: string, evidenceKey: string): string =>
    `${safeKeyPart(experimentKey).slice(0, 48)}__${safeKeyPart(evidenceKey).slice(0, 48)}__${Bun.hash(`${experimentKey}:${evidenceKey}`).toString(16).slice(0, 12)}`;

export const parseOverlapFiles = (raw: string | null): string[] => {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
    } catch {
        return [];
    }
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

export const buildOpportunityStatements = (
    experimentKey: string,
    matches: ReadonlyArray<{
        readonly evidenceTable: string;
        readonly evidenceKey: string;
        readonly ts: string;
        readonly addressed?: boolean;
    }>,
): string[] => {
    const stmts: string[] = [];
    for (const m of matches) {
        const edgeKey = opportunityKey(experimentKey, m.evidenceKey);
        const expRef = recordRef("experiment", experimentKey);
        const evRef = recordRef(m.evidenceTable, m.evidenceKey);
        stmts.push(
            `DELETE ${recordRef("opportunity", edgeKey)};`,
            `RELATE ${expRef}->opportunity:\`${edgeKey}\`->${evRef} SET matched_at = ${surrealDate(m.ts)}, was_addressed = ${m.addressed ? "true" : "false"};`,
        );
    }
    return stmts;
};

interface SkillIdRow {
    readonly id: string | { tb: string; id: string };
}

interface InvokedTsRow {
    readonly ts: string;
}

const safeFileMtimeMs = (absPath: string): number | null => {
    try {
        return statSync(absPath).mtimeMs;
    } catch {
        return null;
    }
};

export const deriveOpportunities = (): Effect.Effect<DeriveOpportunitiesStats, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        // Active = accepted proposal + experiment without a locked verdict.
        // Fetch per-form payloads inline so each branch can match against
        // its own evidence shape without a second round-trip.
        const experimentsResult = yield* db.query<[ActiveExperimentRow[]]>(`
            SELECT
                id,
                type::string(created_at) AS created_at,
                artifact_path,
                proposal.form AS form,
                (SELECT out FROM cites_evidence WHERE in = $parent.proposal LIMIT 1)[0].out AS candidate_id,
                (SELECT trigger_pattern FROM skill_proposal WHERE proposal = $parent.proposal LIMIT 1)[0].trigger_pattern AS skill_trigger,
                (SELECT target_tool, event_name FROM hook_proposal WHERE proposal = $parent.proposal LIMIT 1)[0] AS hook_payload,
                (SELECT file_target, suggested_text FROM guidance_proposal WHERE proposal = $parent.proposal LIMIT 1)[0] AS guidance_payload
            FROM experiment
            WHERE proposal.status = 'accepted'
              AND locked_verdict IS NONE;
        `);
        const experiments = experimentsResult?.[0] ?? [];

        let totalOpportunities = 0;
        let totalAddressed = 0;
        let bySkillForm = 0;
        let byHookForm = 0;
        let byGuidanceForm = 0;
        const allStatements: string[] = [];

        const home = homedir();

        for (const exp of experiments) {
            const experimentKey = recordKeyPart(exp.id, "experiment");
            if (!experimentKey) continue;
            const sinceLiteral = surrealLiteral(exp.created_at);
            const form = exp.form;

            // -------- skill form (legacy: closure-derived via skill_candidate) --------
            const candidateKey = exp.candidate_id ? recordKeyPart(exp.candidate_id, "skill_candidate") : null;
            if (form === "skill" && candidateKey) {
                const tokens = triggerTokensFromCandidate(candidateKey);
                if (tokens.length === 0) continue;

                const fixesResult = yield* db.query<[LaterFixedByRow[]]>(`
                    SELECT id, type::string(ts) AS ts, overlap_files
                    FROM later_fixed_by
                    WHERE ts > d${sinceLiteral};
                `);
                const fixes = fixesResult?.[0] ?? [];
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
                    const skillResult = yield* db.query<[SkillIdRow[]]>(
                        `SELECT id FROM skill WHERE name = ${surrealLiteral(kebab)} LIMIT 1;`,
                    );
                    const skillRow = (skillResult?.[0] ?? [])[0];
                    if (skillRow?.id) {
                        const skillKey = recordKeyPart(skillRow.id, "skill");
                        if (skillKey) {
                            const invokedResult = yield* db.query<[InvokedTsRow[]]>(
                                `SELECT type::string(ts) AS ts FROM invoked WHERE out = ${recordRef("skill", skillKey)} AND ts > d${sinceLiteral};`,
                            );
                            invokedTimestamps = (invokedResult?.[0] ?? [])
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
                allStatements.push(...buildOpportunityStatements(experimentKey, enriched));
                continue;
            }

            // -------- skill form (retro-derived: trigger_pattern fallback) --------
            if (form === "skill" && !candidateKey && exp.skill_trigger) {
                const tool = parseSkillTriggerTool(exp.skill_trigger);
                if (!tool) continue;

                const callsResult = yield* db.query<[ToolCallRow[]]>(`
                    SELECT id, type::string(ts) AS ts
                    FROM tool_call
                    WHERE name = ${surrealLiteral(tool)} AND has_error = true AND ts > d${sinceLiteral};
                `);
                const calls = callsResult?.[0] ?? [];
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
                    const skillResult = yield* db.query<[SkillIdRow[]]>(
                        `SELECT id FROM skill WHERE name = ${surrealLiteral(kebab)} LIMIT 1;`,
                    );
                    const skillRow = (skillResult?.[0] ?? [])[0];
                    if (skillRow?.id) {
                        const skillKey = recordKeyPart(skillRow.id, "skill");
                        if (skillKey) {
                            const invokedResult = yield* db.query<[InvokedTsRow[]]>(
                                `SELECT type::string(ts) AS ts FROM invoked WHERE out = ${recordRef("skill", skillKey)} AND ts > d${sinceLiteral};`,
                            );
                            invokedTimestamps = (invokedResult?.[0] ?? [])
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
                allStatements.push(...buildOpportunityStatements(experimentKey, enriched));
                continue;
            }

            // -------- hook form --------
            if (form === "hook") {
                const tool = exp.hook_payload?.target_tool ?? null;
                if (!tool) continue;

                const callsResult = yield* db.query<[ToolCallRow[]]>(`
                    SELECT id, type::string(ts) AS ts
                    FROM tool_call
                    WHERE name = ${surrealLiteral(tool)} AND has_error = true AND ts > d${sinceLiteral};
                `);
                const calls = callsResult?.[0] ?? [];
                const matches: Array<{ evidenceTable: string; evidenceKey: string; ts: string }> = [];
                for (const c of calls) {
                    const evidenceKey = recordKeyPart(c.id, "tool_call");
                    if (!evidenceKey) continue;
                    matches.push({ evidenceTable: "tool_call", evidenceKey, ts: c.ts });
                }
                if (matches.length === 0) continue;

                // was_addressed: any hook_command_invocation whose command
                // references the scaffold basename, near the failing call.
                const basename = hookBasenameFromArtifactPath(exp.artifact_path);
                let invocationTimestamps: number[] = [];
                if (basename) {
                    const invResult = yield* db.query<[HookInvocationTsRow[]]>(`
                        SELECT type::string(ts) AS ts
                        FROM hook_command_invocation
                        WHERE command CONTAINS ${surrealLiteral(basename)} AND ts > d${sinceLiteral};
                    `);
                    invocationTimestamps = (invResult?.[0] ?? [])
                        .map((r) => new Date(r.ts).getTime())
                        .filter((t) => Number.isFinite(t));
                }
                const enriched = matches.map((m) => {
                    const matchedMs = new Date(m.ts).getTime();
                    const addressed = invocationTimestamps.some(
                        (t) => Math.abs(t - matchedMs) <= ADDRESSED_WINDOW_MS,
                    );
                    if (addressed) totalAddressed += 1;
                    return { ...m, addressed };
                });

                totalOpportunities += matches.length;
                byHookForm += matches.length;
                allStatements.push(...buildOpportunityStatements(experimentKey, enriched));
                continue;
            }

            // -------- guidance form --------
            if (form === "guidance") {
                const target = exp.guidance_payload?.file_target ?? null;
                if (!target) continue;

                // Cheap initial wedge: every recent correction friction_event
                // is one opportunity for the guidance to have prevented.
                const frictionResult = yield* db.query<[FrictionEventRow[]]>(`
                    SELECT id, type::string(ts) AS ts
                    FROM friction_event
                    WHERE kind = 'correction' AND ts > d${sinceLiteral};
                `);
                const events = frictionResult?.[0] ?? [];
                const matches: Array<{ evidenceTable: string; evidenceKey: string; ts: string }> = [];
                for (const ev of events) {
                    const evidenceKey = recordKeyPart(ev.id, "friction_event");
                    if (!evidenceKey) continue;
                    matches.push({ evidenceTable: "friction_event", evidenceKey, ts: ev.ts });
                }
                if (matches.length === 0) continue;

                // was_addressed: target file mtime > matched_at. The file
                // either has been touched post-accept (every later
                // opportunity addressed) or not. Defensive: stat may fail.
                const absPath = resolveGuidanceTargetPath(target, home);
                const mtimeMs = safeFileMtimeMs(absPath);
                const enriched = matches.map((m) => {
                    const matchedMs = new Date(m.ts).getTime();
                    const addressed = mtimeMs !== null && mtimeMs > matchedMs;
                    if (addressed) totalAddressed += 1;
                    return { ...m, addressed };
                });

                totalOpportunities += matches.length;
                byGuidanceForm += matches.length;
                allStatements.push(...buildOpportunityStatements(experimentKey, enriched));
                continue;
            }

            // automation + subagent forms: detectors deferred to follow-up.
        }

        yield* executeStatementsWith(db, allStatements, { chunkSize: 500 });
        return {
            experimentsScanned: experiments.length,
            opportunities: totalOpportunities,
            addressed: totalAddressed,
            bySkillForm,
            byHookForm,
            byGuidanceForm,
        };
    });

if (import.meta.main) {
    await Effect.runPromise(
        deriveOpportunities().pipe(
            Effect.provide(AppLayer),
            Effect.scoped,
        ) as Effect.Effect<DeriveOpportunitiesStats>,
    );
}

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

export const opportunitiesStage: StageDef<OpportunitiesStats, SurrealClient> = {
    meta: StageMeta.make({ key: "opportunities", deps: ["proposals"], tags: ["derive"] }),
    run: (_ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const result = yield* deriveOpportunities();
            return OpportunitiesStats.make({
                durationMs: Date.now() - t0,
                summary: `scanned ${result.experimentsScanned} experiments, derived ${result.opportunities} opportunities`,
                experimentsScanned: result.experimentsScanned,
                opportunities: result.opportunities,
            });
        }),
};
