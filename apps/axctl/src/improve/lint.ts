/**
 * Lint walker for grounded agent files. v0 discovers:
 *   - <root>/AGENTS.md, <root>/CLAUDE.md       → form=guidance
 *   - <root>/skills/<slug>/SKILL.md            → form=skill
 *   - <root>/agents/<slug>.md                  → form=subagent
 *   - <root>/settings.json, <root>/.claude/settings.json → form=hook
 *   - <root>/LaunchAgents/*.plist, <root>/cron/*,
 *     <root>/automations/*                     → form=automation
 *   - <root>/tests/harness/<slug>.md           → form=harness_check
 *
 * The default roots are `process.cwd()` (walking up to the git root) and
 * `~/.claude`. Override via `discoverFiles({ roots: [...] })`.
 */

import { homedir } from "node:os";
import { Effect, FileSystem, Option, type PlatformError } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { posixPath } from "@ax/lib/shared/path";
import { surrealLiteral } from "@ax/lib/json";
import { decodeJsonOrNull } from "@ax/lib/decode";
import {
    parseAutomationMarkers,
    parseHookCommandMarkers,
    parseInlineMarkers,
    parseFrontmatterMarker,
} from "./markers.ts";
import type { DbError } from "@ax/lib/errors";
import { recordRef } from "@ax/lib/shared/surql";
import { recordKeyPart } from "@ax/lib/shared/derive-keys";
import {
    EXPERIMENT_STATUS_TASK_EMITTED,
    planTaskScaffolded,
} from "./lifecycle.ts";

export type LintForm = "guidance" | "skill" | "subagent" | "hook" | "automation" | "harness_check";

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

// existsSync probe → orAbsent(false): a fault means "treat as absent".
const tryAddFile = (
    out: LintTarget[],
    path: string,
    form: LintForm,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        if (yield* fs.exists(path).pipe(orAbsent(false))) out.push({ path, form });
    });

// readDirectory of a possibly-absent dir: missing/unreadable → [] (the original
// guarded with existsSync first, then readdirSync; orAbsent collapses both).
const safeReadDir = (
    dir: string,
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.readDirectory(dir).pipe(orAbsent([] as string[]));
    });

// statSync(full).isDirectory()/isFile() in try/catch→skip. `fs.stat` follows
// symlinks (matching node statSync); a stat fault maps to "Other" so the
// caller's Directory/File predicate skips it, exactly as the original `catch`
// did. (The skills/agents/harness walkers intentionally follow symlinks here -
// the no-follow guard is the realPath dedupe at the end of discoverFiles.)
const statKind = (
    path: string,
): Effect.Effect<"Directory" | "File" | "Other", never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const info = yield* fs.stat(path).pipe(Effect.asSome, orAbsent(Option.none()));
        if (Option.isNone(info)) return "Other";
        return info.value.type === "Directory"
            ? "Directory"
            : info.value.type === "File"
              ? "File"
              : "Other";
    });

const walkSkillsDir = (
    out: LintTarget[],
    skillsDir: string,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        for (const entry of yield* safeReadDir(skillsDir)) {
            const full = posixPath.join(skillsDir, entry);
            if ((yield* statKind(full)) !== "Directory") continue;
            yield* tryAddFile(out, posixPath.join(full, "SKILL.md"), "skill");
        }
    });

const walkAgentsDir = (
    out: LintTarget[],
    agentsDir: string,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        for (const entry of yield* safeReadDir(agentsDir)) {
            if (!entry.endsWith(".md")) continue;
            yield* tryAddFile(out, posixPath.join(agentsDir, entry), "subagent");
        }
    });

const walkFlatFilesDir = (
    out: LintTarget[],
    dir: string,
    form: LintForm,
    predicate: (entry: string) => boolean,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        for (const entry of yield* safeReadDir(dir)) {
            if (!predicate(entry)) continue;
            const full = posixPath.join(dir, entry);
            if ((yield* statKind(full)) !== "File") continue;
            yield* tryAddFile(out, full, form);
        }
    });

const walkHarnessDir = (
    out: LintTarget[],
    harnessDir: string,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        for (const entry of yield* safeReadDir(harnessDir)) {
            if (!entry.endsWith(".md")) continue;
            yield* tryAddFile(out, posixPath.join(harnessDir, entry), "harness_check");
        }
    });

export const defaultRoots = (): string[] => [
    process.cwd(),
    posixPath.join(homedir(), ".claude"),
];

// unlinkSync in try/catch→bool: ANY failure (incl. absence) → false. `fs.remove`
// without force fails on a missing path, so map success→true and orAbsent→false.
const deleteFileIfPresent = (
    path: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.remove(path).pipe(Effect.as(true), orAbsent(false));
    });

// statSync().mtimeMs in try/catch→null: a stat fault or absent mtime → null.
const statMtimeMsOrNull = (
    path: string,
): Effect.Effect<number | null, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const info = yield* fs.stat(path).pipe(Effect.asSome, orAbsent(Option.none()));
        if (Option.isNone(info)) return null;
        return Option.match(info.value.mtime, {
            onNone: () => null,
            onSome: (d) => d.getTime(),
        });
    });

export const discoverFiles = (
    opts: DiscoverOptions = {},
): Effect.Effect<LintTarget[], never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const roots = opts.roots ?? defaultRoots();
        const out: LintTarget[] = [];
        const seen = new Set<string>();
        for (const root of roots) {
            for (const name of ["CLAUDE.md", "AGENTS.md"]) {
                yield* tryAddFile(out, posixPath.join(root, name), "guidance");
            }
            yield* walkSkillsDir(out, posixPath.join(root, "skills"));
            yield* walkAgentsDir(out, posixPath.join(root, "agents"));
            yield* tryAddFile(out, posixPath.join(root, "settings.json"), "hook");
            yield* tryAddFile(out, posixPath.join(root, ".claude", "settings.json"), "hook");
            yield* walkFlatFilesDir(out, posixPath.join(root, "LaunchAgents"), "automation", (entry) => entry.endsWith(".plist"));
            yield* walkFlatFilesDir(out, posixPath.join(root, "cron"), "automation", () => true);
            yield* walkFlatFilesDir(out, posixPath.join(root, "automations"), "automation", () => true);
            yield* walkHarnessDir(out, posixPath.join(root, "tests", "harness"));
        }
        const deduped: LintTarget[] = [];
        for (const t of out) {
            // realpathSync in try/catch→fallback to t.path: a fault means use
            // the raw path as the dedupe key (orAbsent recovers to t.path).
            const key = yield* fs.realPath(t.path).pipe(orAbsent(t.path));
            if (seen.has(key)) continue;
            seen.add(key);
            deduped.push(t);
        }
        return deduped;
    });

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

const collectJsonCommandStrings = (value: unknown, out: string[]): void => {
    if (typeof value === "string") return;
    if (Array.isArray(value)) {
        for (const item of value) collectJsonCommandStrings(item, out);
        return;
    }
    if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        if (typeof record.command === "string") out.push(record.command);
        for (const item of Object.values(record)) collectJsonCommandStrings(item, out);
    }
};

const collectIds = (
    target: LintTarget,
    errors: LintFinding[],
): Effect.Effect<Map<string, IdTarget>, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const found = new Map<string, IdTarget>();
    // readFileSync in try/catch→empty map: an unreadable/missing file yields no
    // markers (any read fault collapses to Option.none → "no content").
    const contentOpt = yield* fs.readFileString(target.path).pipe(
        Effect.asSome,
        orAbsent(Option.none<string>()),
    );
    if (Option.isNone(contentOpt)) {
        return found;
    }
    const content = contentOpt.value;
    if (target.form === "guidance") {
        // Parse fault → a marker_parse_error finding (entries set before the
        // throw are kept, matching the old try/catch).
        yield* Effect.try({
            try: () => {
                // Inline markers (guidance files) carry no explicit experiment id.
                for (const m of parseInlineMarkers(content)) found.set(m.id, { path: target.path });
            },
            catch: (err) => (err as Error).message,
        }).pipe(
            Effect.catch((message) =>
                Effect.sync(() => {
                    errors.push({
                        rule: "marker_parse_error",
                        severity: "error",
                        path: target.path,
                        message,
                    });
                }),
            ),
        );
    } else if (target.form === "hook") {
        yield* Effect.try({
            try: () => {
                const parsed = decodeJsonOrNull(content);
                if (parsed === null) throw new Error("invalid JSON in hook config");
                const commands: string[] = [];
                collectJsonCommandStrings(parsed, commands);
                for (const command of commands) {
                    for (const marker of parseHookCommandMarkers(command)) {
                        found.set(
                            marker.id,
                            marker.experiment === undefined
                                ? { path: target.path }
                                : { path: target.path, experiment: marker.experiment },
                        );
                    }
                }
            },
            catch: (err) => (err instanceof Error ? err.message : String(err)),
        }).pipe(
            Effect.catch((message) =>
                Effect.sync(() => {
                    errors.push({
                        rule: "marker_parse_error",
                        severity: "error",
                        path: target.path,
                        message,
                    });
                }),
            ),
        );
    } else if (target.form === "automation") {
        for (const marker of parseAutomationMarkers(content)) {
            found.set(
                marker.id,
                marker.experiment === undefined
                    ? { path: target.path }
                    : { path: target.path, experiment: marker.experiment },
            );
        }
    } else {
        // Skill and subagent files use frontmatter; may carry ax_experiment.
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
    });

export const lintFiles = (
    opts: LintOptions = {},
): Effect.Effect<LintReport, DbError | PlatformError.PlatformError, SurrealClient | FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const targets = yield* discoverFiles(opts);
        const errors: LintFinding[] = [];
        const warnings: LintFinding[] = [];
        const infos: LintFinding[] = [];
        const reconciled: LintReconciliation[] = [];

        // idToTarget: short_id → { path, experiment? }
        const idToTarget = new Map<string, IdTarget>();
        for (const t of targets) {
            const found = yield* collectIds(t, errors);
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
                nextStatus: string;
                taskPath: string | null;
            }
            const updates: string[] = [];
            const pending: PendingReconcile[] = [];

            const reconcileRow = (
                id: string,
                tgt: IdTarget,
                row: ExperimentRow,
            ): Effect.Effect<void, never, FileSystem.FileSystem> =>
                Effect.gen(function* () {
                const plan = planTaskScaffolded({
                    experimentStatus: row.status,
                    lockedVerdict: row.locked_verdict,
                });
                if (plan.regressed) {
                    infos.push({
                        rule: "regressed_verdict",
                        severity: "info",
                        path: tgt.path,
                        id,
                        message: `experiment ${id} locked as regressed - consider removing the marker`,
                    });
                }
                if (plan.status === "scaffold") {
                    // Use recordRef to build the UPDATE target consistently with
                    // actions.ts (which always wraps record IDs via recordRef rather
                    // than interpolating the raw type::string id).
                    const key = recordKeyPart(row.id, "experiment");
                    const updateTarget = key ? recordRef("experiment", key) : row.id;
                    updates.push(
                        `UPDATE ${updateTarget} SET status = '${plan.nextStatus}', scaffolded_at = time::now(), artifact_path = ${surrealLiteral(tgt.path)};`,
                    );
                    // existsSync probe → orAbsent(false).
                    const taskPresent = row.task_path
                        ? yield* fs.exists(row.task_path).pipe(orAbsent(false))
                        : false;
                    pending.push({
                        shortId: id,
                        experimentId: row.id,
                        previousStatus: row.status,
                        nextStatus: plan.nextStatus,
                        taskPath: taskPresent ? row.task_path : null,
                    });
                }
                });

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
                    yield* reconcileRow(id, tgt, row);
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
                    yield* reconcileRow(id, tgt, row);
                }
            }

            if (updates.length > 0) {
                yield* db.query(updates.join("\n"));
                // DB succeeded - now safe to remove task files and record reconciliation
                for (const p of pending) {
                    let taskDeleted: string | null = null;
                    if (p.taskPath) {
                        const deleted = yield* deleteFileIfPresent(p.taskPath);
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
                        nextStatus: p.nextStatus,
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
            WHERE status = '${EXPERIMENT_STATUS_TASK_EMITTED}'
              AND task_path IS NOT NONE
              AND created_at < d"${staleCutoff}";
        `);
        for (const row of staleResult?.[0] ?? []) {
            if (idToTarget.has(row.short_id)) continue; // marker found this run → not stale
            if (!row.task_path) continue;
            // existsSync probe → orAbsent(false).
            const present = yield* fs.exists(row.task_path).pipe(orAbsent(false));
            if (!present) continue;
            // JS-side mtime cross-check: the task file may have been touched
            // (e.g. by the agent) after the experiment was created, so we still
            // verify the file is actually old before emitting the warning.
            const mtime = yield* statMtimeMsOrNull(row.task_path);
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
