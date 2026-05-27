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

const collectIds = (target: LintTarget, errors: LintFinding[]): Map<string, string> => {
    const found = new Map<string, string>();
    let content: string;
    try {
        content = readFileSync(target.path, "utf-8");
    } catch {
        return found;
    }
    if (target.form === "guidance") {
        try {
            for (const m of parseInlineMarkers(content)) found.set(m.id, target.path);
        } catch (err) {
            errors.push({
                rule: "marker_parse_error",
                severity: "error",
                path: target.path,
                message: (err as Error).message,
            });
        }
    } else {
        // skill and subagent files both use the frontmatter convention;
        // reconcile path is the same for both (subagent experiments would be
        // handled identically if one existed - acceptProposal rejects subagent
        // form in v0, so no experiments exist for them yet).
        const fm = parseFrontmatterMarker(content);
        if (fm) found.set(fm.id, target.path);
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

        const idToPath = new Map<string, string>();
        for (const t of targets) {
            const found = collectIds(t, errors);
            for (const [id, path] of found) {
                if (idToPath.has(id)) {
                    warnings.push({
                        rule: "id_collision",
                        severity: "warning",
                        path,
                        id,
                        message: `id ${id} also in ${idToPath.get(id)}`,
                    });
                } else {
                    idToPath.set(id, path);
                }
            }
        }

        const db = yield* SurrealClient;

        if (idToPath.size > 0) {
            const idList = [...idToPath.keys()].map(surrealLiteral).join(",");
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
            const byShortId = new Map(rows.map((r) => [r.short_id, r]));

            interface PendingReconcile {
                shortId: string;
                experimentId: string;
                previousStatus: string;
                taskPath: string | null;
            }
            const updates: string[] = [];
            const pending: PendingReconcile[] = [];
            for (const [id, path] of idToPath) {
                const row = byShortId.get(id);
                if (!row) {
                    warnings.push({
                        rule: "orphan_id",
                        severity: "warning",
                        path,
                        id,
                        message: `marker ${id} has no experiment row (consider \`axctl improve forget ${id}\`)`,
                    });
                    continue;
                }
                if (row.locked_verdict === "regressed") {
                    infos.push({
                        rule: "regressed_verdict",
                        severity: "info",
                        path,
                        id,
                        message: `experiment ${id} locked as regressed - consider removing the marker`,
                    });
                }
                if (row.status === "task_emitted") {
                    updates.push(
                        `UPDATE ${row.id} SET status = 'scaffolded', scaffolded_at = time::now(), artifact_path = ${surrealLiteral(path)};`,
                    );
                    pending.push({
                        shortId: id,
                        experimentId: row.id,
                        previousStatus: row.status,
                        taskPath: (row.task_path && existsSync(row.task_path)) ? row.task_path : null,
                    });
                }
            }

            if (updates.length > 0) {
                yield* db.query(updates.join("\n"));
                // DB succeeded - now safe to remove task files and record reconciliation
                for (const p of pending) {
                    let taskDeleted: string | null = null;
                    if (p.taskPath) {
                        try {
                            unlinkSync(p.taskPath);
                            taskDeleted = p.taskPath;
                        } catch {
                            warnings.push({
                                rule: "task_cleanup_failed",
                                severity: "warning",
                                path: p.taskPath,
                                message: `failed to delete task file ${p.taskPath} after DB update`,
                            });
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
        const staleResult = yield* db.query<[ExperimentRow[]]>(`
            SELECT
                type::string(id) AS id,
                proposal.dedupe_sig AS short_id,
                status,
                task_path,
                locked_verdict
            FROM experiment WHERE status = 'task_emitted' AND task_path IS NOT NONE;
        `);
        const staleCutoffMs = Date.now() - (opts.staleDays ?? 7) * 86_400_000;
        for (const row of staleResult?.[0] ?? []) {
            if (idToPath.has(row.short_id)) continue; // marker found this run → not stale
            if (!row.task_path || !existsSync(row.task_path)) continue;
            let mtime: number;
            try { mtime = statSync(row.task_path).mtimeMs; }
            catch { continue; }
            if (mtime < staleCutoffMs) {
                warnings.push({
                    rule: "stale_task",
                    severity: "warning",
                    path: row.task_path,
                    id: row.short_id,
                    message: `task file >${opts.staleDays ?? 7}d old with no marker (consider \`axctl improve reject ${row.short_id}\`)`,
                });
            }
        }

        return { errors, warnings, infos, reconciled };
    });
