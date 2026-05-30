/**
 * Lint walker for grounded agent files. v0 discovers:
 *   - <root>/AGENTS.md, <root>/CLAUDE.md       → form=guidance
 *   - <root>/skills/<slug>/SKILL.md            → form=skill
 *   - <root>/agents/<slug>.md                  → form=subagent  (v1 reads only)
 *
 * The default roots are `process.cwd()` (walking up to the git root) and
 * `~/.claude`. Override via `discoverFiles({ roots: [...] })`.
 */

import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { surrealLiteral } from "../lib/json.ts";
import { parseInlineMarkers, parseFrontmatterMarker } from "./markers.ts";
import type { DbError } from "../lib/errors.ts";
import { recordRef } from "../lib/shared/surql.ts";
import { recordKeyPart } from "../lib/shared/derive-keys.ts";

export type LintForm = "guidance" | "skill" | "subagent";

export interface LintTarget {
    readonly path: string;
    readonly form: LintForm;
}

export interface DiscoverOptions {
    readonly roots?: ReadonlyArray<string>;
}

export interface LintOptions extends DiscoverOptions {
    readonly staleDays?: number;
}

const tryAddFile = (out: LintTarget[], path: string, form: LintForm): void => {
    if (existsSync(path)) out.push({ path, form });
};

const walkSkillsDir = (out: LintTarget[], skillsDir: string): void => {
    if (!existsSync(skillsDir)) return;
    for (const entry of readdirSync(skillsDir)) {
        const full = join(skillsDir, entry);
        try {
            if (!statSync(full).isDirectory()) continue;
        } catch { continue; }
        tryAddFile(out, join(full, "SKILL.md"), "skill");
    }
};

const walkAgentsDir = (out: LintTarget[], agentsDir: string): void => {
    if (!existsSync(agentsDir)) return;
    for (const entry of readdirSync(agentsDir)) {
        if (!entry.endsWith(".md")) continue;
        tryAddFile(out, join(agentsDir, entry), "subagent");
    }
};

export const defaultRoots = (): string[] => [
    process.cwd(),
    join(homedir(), ".claude"),
];

const deleteFileIfPresent = (path: string): boolean => {
    try {
        unlinkSync(path);
        return true;
    } catch {
        return false;
    }
};

const statMtimeMsOrNull = (path: string): number | null => {
    try {
        return statSync(path).mtimeMs;
    } catch {
        return null;
    }
};

export const discoverFiles = (opts: DiscoverOptions = {}): LintTarget[] => {
    const roots = opts.roots ?? defaultRoots();
    const out: LintTarget[] = [];
    const seen = new Set<string>();
    for (const root of roots) {
        for (const name of ["CLAUDE.md", "AGENTS.md"]) {
            tryAddFile(out, join(root, name), "guidance");
        }
        walkSkillsDir(out, join(root, "skills"));
        walkAgentsDir(out, join(root, "agents"));
    }
    return out.filter((t) => {
        if (seen.has(t.path)) return false;
        seen.add(t.path);
        return true;
    });
};

// ---------------------------------------------------------------------------
// lintFiles - marker scan + DB reconcile + task cleanup
// ---------------------------------------------------------------------------

export type LintSeverity = "error" | "warning" | "info";

export interface LintFinding {
    readonly rule: string;
    readonly severity: LintSeverity;
    readonly path: string;
    readonly id?: string;
    readonly message: string;
}

export interface LintReconciliation {
    readonly shortId: string;
    readonly experimentId: string;
    readonly previousStatus: string;
    readonly nextStatus: string;
    readonly taskDeleted: string | null;
}

export interface LintReport {
    readonly errors: LintFinding[];
    readonly warnings: LintFinding[];
    readonly infos: LintFinding[];
    readonly reconciled: LintReconciliation[];
}

interface ExperimentRow {
    readonly id: string;
    readonly short_id: string;
    readonly status: string;
    readonly task_path: string | null;
    readonly locked_verdict: string | null;
}

interface IdTarget {
    readonly path: string;
    /** Explicit experiment record id from `ax_experiment` frontmatter (skill/subagent only). */
    readonly experiment?: string;
}

const collectIds = (target: LintTarget, errors: LintFinding[]): Map<string, IdTarget> => {
    const found = new Map<string, IdTarget>();
    let content: string;
    try {
        content = readFileSync(target.path, "utf-8");
    } catch {
        return found;
    }
    if (target.form === "guidance") {
        try {
            // Inline markers (guidance files) carry no explicit experiment id.
            for (const m of parseInlineMarkers(content)) found.set(m.id, { path: target.path });
        } catch (err) {
            errors.push({
                rule: "marker_parse_error",
                severity: "error",
                path: target.path,
                message: (err as Error).message,
            });
        }
    } else {
        // Skill and subagent files use frontmatter; may carry ax_experiment.
        // (subagent experiments don't exist yet in v0 but the path is identical.)
        const fm = parseFrontmatterMarker(content);
        if (fm) {
            found.set(
                fm.id,
                fm.experiment === undefined
                    ? { path: target.path }
                    : { path: target.path, experiment: fm.experiment },
            );
        }
    }
    return found;
};

export const lintFiles = (
    opts: LintOptions = {},
): Effect.Effect<LintReport, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const targets = discoverFiles(opts);
        const errors: LintFinding[] = [];
        const warnings: LintFinding[] = [];
        const infos: LintFinding[] = [];
        const reconciled: LintReconciliation[] = [];

        // idToTarget: short_id → { path, experiment? }
        const idToTarget = new Map<string, IdTarget>();
        for (const t of targets) {
            const found = collectIds(t, errors);
            for (const [id, tgt] of found) {
                if (idToTarget.has(id)) {
                    warnings.push({
                        rule: "id_collision",
                        severity: "warning",
                        path: tgt.path,
                        id,
                        message: `id ${id} also in ${idToTarget.get(id)!.path}`,
                    });
                } else {
                    idToTarget.set(id, tgt);
                }
            }
        }

        const db = yield* SurrealClient;

        if (idToTarget.size > 0) {
            // Partition targets into two groups:
            //   - explicitIds: have ax_experiment → query by exact experiment record id
            //   - dedupeIds:   no ax_experiment    → query by proposal.dedupe_sig batch
            const explicitEntries: Array<[string, IdTarget & { experiment: string }]> = [];
            const dedupeIds: string[] = [];
            for (const [id, tgt] of idToTarget) {
                if (tgt.experiment) {
                    explicitEntries.push([id, tgt as IdTarget & { experiment: string }]);
                } else {
                    dedupeIds.push(id);
                }
            }

            // --- Query 1: exact-experiment lookup (frontmatter ax_experiment) ---
            const byExperimentId = new Map<string, ExperimentRow>();
            if (explicitEntries.length > 0) {
                const expIdList = explicitEntries
                    .map(([, tgt]) => tgt.experiment)
                    .map(surrealLiteral)
                    .join(",");
                const expResult = yield* db.query<[ExperimentRow[]]>(`
                    SELECT
                        type::string(id) AS id,
                        proposal.dedupe_sig AS short_id,
                        status,
                        task_path,
                        locked_verdict
                    FROM experiment WHERE type::string(id) IN [${expIdList}];
                `);
                for (const r of expResult?.[0] ?? []) byExperimentId.set(r.id, r);
            }

            // --- Query 2: dedupe_sig batch (inline guidance markers) ---
            // When >1 experiment row exists for the same dedupe_sig (re-accept
            // after reject, etc.), we cannot know which row was intended → emit
            // multi_experiment_ambiguous and skip reconcile for that id.
            const byShortId = new Map<string, ExperimentRow>();
            const ambiguousShortIds = new Set<string>();
            if (dedupeIds.length > 0) {
                const idList = dedupeIds.map(surrealLiteral).join(",");
                const result = yield* db.query<[ExperimentRow[]]>(`
                    SELECT
                        type::string(id) AS id,
                        proposal.dedupe_sig AS short_id,
                        status,
                        task_path,
                        locked_verdict
                    FROM experiment WHERE proposal.dedupe_sig IN [${idList}];
                `);
                const rows: ExperimentRow[] = result?.[0] ?? [];
                for (const r of rows) {
                    if (byShortId.has(r.short_id)) {
                        // Second row for the same short_id → ambiguous
                        ambiguousShortIds.add(r.short_id);
                    } else {
                        byShortId.set(r.short_id, r);
                    }
                }
            }

            interface PendingReconcile {
                shortId: string;
                experimentId: string;
                previousStatus: string;
                taskPath: string | null;
            }
            const updates: string[] = [];
            const pending: PendingReconcile[] = [];

            const reconcileRow = (id: string, tgt: IdTarget, row: ExperimentRow): void => {
                if (row.locked_verdict === "regressed") {
                    infos.push({
                        rule: "regressed_verdict",
                        severity: "info",
                        path: tgt.path,
                        id,
                        message: `experiment ${id} locked as regressed - consider removing the marker`,
                    });
                }
                if (row.status === "task_emitted") {
                    // Use recordRef to build the UPDATE target consistently with
                    // actions.ts (which always wraps record IDs via recordRef rather
                    // than interpolating the raw type::string id).
                    const key = recordKeyPart(row.id, "experiment");
                    const updateTarget = key ? recordRef("experiment", key) : row.id;
                    updates.push(
                        `UPDATE ${updateTarget} SET status = 'scaffolded', scaffolded_at = time::now(), artifact_path = ${surrealLiteral(tgt.path)};`,
                    );
                    pending.push({
                        shortId: id,
                        experimentId: row.id,
                        previousStatus: row.status,
                        taskPath: (row.task_path && existsSync(row.task_path)) ? row.task_path : null,
                    });
                }
            };

            for (const [id, tgt] of idToTarget) {
                if (tgt.experiment) {
                    // Frontmatter-specified experiment: look up by exact record id.
                    const row = byExperimentId.get(tgt.experiment);
                    if (!row) {
                        warnings.push({
                            rule: "orphan_id",
                            severity: "warning",
                            path: tgt.path,
                            id,
                            message: `marker ${id} has no experiment row (consider \`axctl improve forget ${id}\`)`,
                        });
                        continue;
                    }
                    reconcileRow(id, tgt, row);
                } else {
                    // Inline guidance marker: use dedupe_sig batch result.
                    if (ambiguousShortIds.has(id)) {
                        warnings.push({
                            rule: "multi_experiment_ambiguous",
                            severity: "warning",
                            path: tgt.path,
                            id,
                            message: `multiple experiment rows match dedupe_sig ${id}; specify ax_experiment in the skill frontmatter or clean up manually`,
                        });
                        continue;
                    }
                    const row = byShortId.get(id);
                    if (!row) {
                        warnings.push({
                            rule: "orphan_id",
                            severity: "warning",
                            path: tgt.path,
                            id,
                            message: `marker ${id} has no experiment row (consider \`axctl improve forget ${id}\`)`,
                        });
                        continue;
                    }
                    reconcileRow(id, tgt, row);
                }
            }

            if (updates.length > 0) {
                yield* db.query(updates.join("\n"));
                // DB succeeded - now safe to remove task files and record reconciliation
                for (const p of pending) {
                    let taskDeleted: string | null = null;
                    if (p.taskPath) {
                        const deleted = deleteFileIfPresent(p.taskPath);
                        if (!deleted) {
                            warnings.push({
                                rule: "task_cleanup_failed",
                                severity: "warning",
                                path: p.taskPath,
                                message: `failed to delete task file ${p.taskPath} after DB update`,
                            });
                        } else {
                            taskDeleted = p.taskPath;
                        }
                    }
                    reconciled.push({
                        shortId: p.shortId,
                        experimentId: p.experimentId,
                        previousStatus: p.previousStatus,
                        nextStatus: "scaffolded",
                        taskDeleted,
                    });
                }
            }
        }

        // Stale-task scan: always runs regardless of whether markers were found.
        // Warns about task_emitted experiments whose task file is >staleDays old
        // and whose short_id was NOT seen as a marker this run.
        // The date predicate is pushed into SurrealQL so only rows older than
        // staleDays round-trip to JS (avoiding a linear statSync-per-row scan).
        const staleDays = opts.staleDays ?? 7;
        const staleCutoff = new Date(Date.now() - staleDays * 86_400_000).toISOString();
        const staleResult = yield* db.query<[ExperimentRow[]]>(`
            SELECT
                type::string(id) AS id,
                proposal.dedupe_sig AS short_id,
                status,
                task_path,
                locked_verdict
            FROM experiment
            WHERE status = 'task_emitted'
              AND task_path IS NOT NONE
              AND created_at < d"${staleCutoff}";
        `);
        for (const row of staleResult?.[0] ?? []) {
            if (idToTarget.has(row.short_id)) continue; // marker found this run → not stale
            if (!row.task_path || !existsSync(row.task_path)) continue;
            // JS-side mtime cross-check: the task file may have been touched
            // (e.g. by the agent) after the experiment was created, so we still
            // verify the file is actually old before emitting the warning.
            const mtime = statMtimeMsOrNull(row.task_path);
            if (mtime === null) continue;
            const staleCutoffMs = Date.now() - staleDays * 86_400_000;
            if (mtime < staleCutoffMs) {
                warnings.push({
                    rule: "stale_task",
                    severity: "warning",
                    path: row.task_path,
                    id: row.short_id,
                    message: `task file >${staleDays}d old with no marker (consider \`axctl improve reject ${row.short_id}\`)`,
                });
            }
        }

        return { errors, warnings, infos, reconciled };
    });
