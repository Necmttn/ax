import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { AxConfig } from "@ax/lib/config";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { cacheRow, tsParam } from "@ax/lib/duckdb/row";
import { fileWatermark } from "@ax/lib/duckdb/watermark";
import { edgeRowId } from "@ax/lib/stable-id";
import { BaseStageStats, IngestContext, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";
import { decodeJsonOrNull } from "@ax/lib/decode";
import { isNotFound, orAbsent } from "@ax/lib/shared/fs-error";
import {
    extractFileWithSessionId,
    upsertTurnsForSubagents,
    writeToolCallStatementsForSubagents,
    writeToolFileEvidenceForSubagents,
    relateInvocationsForSubagents,
    relateToolCallSkillsForSubagents,
    writePlanSnapshotsForSubagents,
    writeTokenUsageForSubagents,
} from "./transcripts.ts";
import { resolveSkillName } from "@ax/lib/skill-id";

interface SubagentManifest {
    readonly agentId: string;
    readonly parentSessionId: string;
    readonly subagentSessionId: string;
    readonly project: string | null;
    readonly startedAt: string | null;
    readonly endedAt: string | null;
    readonly file: string;
}

/** Parsed content of `agent-<id>.meta.json` - all fields optional. */
interface SubagentMeta {
    readonly agentType?: string;
    readonly description?: string;
    readonly name?: string;
    readonly toolUseId?: string;
}

export interface DeriveClaudeSubagentsOpts {
    readonly onProgress?: (counts: Record<string, number>) => Effect.Effect<void>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

const stringField = (row: Record<string, unknown>, key: string): string | null => {
    const v = row[key];
    return typeof v === "string" && v.length > 0 ? v : null;
};

/**
 * Walk every project dir, find `<sessionId>/subagents/agent-*.jsonl`, parse
 * minimum metadata. Doesn't open the full file - just first + last line for
 * sessionId / agentId / timestamps so the scan stays cheap.
 */
const discover = (
    transcriptsDir: string,
): Effect.Effect<SubagentManifest[], never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const out: SubagentManifest[] = [];
        // Original tolerance: any readdir failure (missing/unreadable) -> skip.
        const projectDirs = yield* fs
            .readDirectory(transcriptsDir)
            .pipe(orAbsent<ReadonlyArray<string>>([]));
        for (const projectDir of projectDirs) {
            const fullProject = path.join(transcriptsDir, projectDir);
            const entries = yield* fs
                .readDirectory(fullProject)
                .pipe(orAbsent<ReadonlyArray<string>>([]));
            for (const entry of entries) {
                if (entry.endsWith(".jsonl")) continue;
                const subagentDir = path.join(fullProject, entry, "subagents");
                const agentFiles = yield* fs
                    .readDirectory(subagentDir)
                    .pipe(orAbsent<ReadonlyArray<string>>([]));
                for (const agentFile of agentFiles) {
                    if (!agentFile.endsWith(".jsonl")) continue;
                    if (!agentFile.startsWith("agent-")) continue;
                    const fullPath = path.join(subagentDir, agentFile);
                    const manifest = yield* parseManifest(fullPath, projectDir);
                    if (manifest) out.push(manifest);
                }
            }
        }
        return out;
    });

const parseManifest = (
    filePath: string,
    projectDir: string,
): Effect.Effect<SubagentManifest | null, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // Original tolerance: any read failure -> null (file vanished/unreadable).
        const text = yield* fs.readFileString(filePath).pipe(orAbsent<string | null>(null));
        if (text === null) return null;
        return buildManifest(text, filePath, projectDir);
    });

const buildManifest = (
    text: string,
    filePath: string,
    projectDir: string,
): SubagentManifest | null => {
    const lines = text.split("\n").filter((l) => l.length > 0);
    if (lines.length === 0) return null;
    const first = decodeJsonOrNull(lines[0] ?? "");
    if (!isRecord(first)) return null;
    const agentId = stringField(first, "agentId");
    const parentSessionId = stringField(first, "sessionId");
    if (!agentId || !parentSessionId) return null;
    const last = decodeJsonOrNull(lines[lines.length - 1] ?? "");
    const startedAt = stringField(first, "timestamp");
    const endedAt = isRecord(last) ? stringField(last, "timestamp") : null;
    return {
        agentId,
        parentSessionId,
        subagentSessionId: `claude-subagent-${agentId}`,
        project: projectDir,
        startedAt,
        endedAt,
        file: filePath,
    };
}

/**
 * Attempt to read `agent-<id>.meta.json` (sibling of the `.jsonl` file).
 * Returns partial/empty object on any failure – callers treat every field optional.
 */
const readSubagentMeta = (
    jsonlPath: string,
): Effect.Effect<SubagentMeta, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const metaPath = jsonlPath.replace(/\.jsonl$/, ".meta.json");
        const text = yield* fs.readFileString(metaPath).pipe(orAbsent<string | null>(null));
        if (text === null) return {};
        const parsed = decodeJsonOrNull(text);
        if (!isRecord(parsed)) return {};
        const agentType = stringField(parsed, "agentType");
        const description = stringField(parsed, "description");
        const name = stringField(parsed, "name");
        const toolUseId = stringField(parsed, "toolUseId");
        return {
            ...(agentType !== null ? { agentType } : {}),
            ...(description !== null ? { description } : {}),
            ...(name !== null ? { name } : {}),
            ...(toolUseId !== null ? { toolUseId } : {}),
        };
    });

export interface DeriveClaudeSubagentsStats {
    readonly discovered: number;
    readonly missingParent: number;
    readonly written: number;
    readonly skippedExisting: number;
    /** Subagent files skipped because their (mtime,size) matched the watermark. */
    readonly skippedUnchanged: number;
    /** Subagents that inherited repository/checkout/cwd from their parent during this run. */
    readonly repositoryInherited: number;
    /** Existing subagent rows that were backfilled with repository/checkout/cwd from parent. */
    readonly repositoryBackfilled: number;
    readonly activity: {
        readonly turns: number;
        readonly invocations: number;
        readonly toolCalls: number;
        readonly edits: number;
        readonly planSnapshots: number;
    };
}

/**
 * Create one session record + one `spawned` edge per discovered subagent
 * transcript, and ingest the subagent's own turns/tool calls. Idempotent:
 * re-running upserts the session and re-RELATEs.
 */
export const deriveClaudeSubagents = (
    write: CacheWriteService,
    opts: DeriveClaudeSubagentsOpts = {},
): Effect.Effect<
    DeriveClaudeSubagentsStats,
    CacheWriteError,
    AxConfig | FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const cfg = yield* AxConfig;
        const fs = yield* FileSystem.FileSystem;
        if (opts.onProgress) yield* opts.onProgress({ phase: 1 });
        const manifests = yield* discover(cfg.paths.transcriptsDir);
        if (opts.onProgress) {
            yield* opts.onProgress({
                phase: 2,
                totalSubagents: manifests.length,
            });
        }

        // Real skill/command catalog, snapshotted once - lets us resolve each
        // invoked name onto the canonical row (see resolveSkillName) instead
        // of minting ghost `scope='unknown'` rows for subagent invocations.
        const catalogRows = yield* write.rows(Schema.Struct({ name: Schema.String }),
            "SELECT name FROM skill WHERE dir_path != '(unknown)'");
        const skillCatalog: ReadonlySet<string> = new Set(
            catalogRows
                .map((row) => row.name)
                .filter((name): name is string => typeof name === "string" && name.length > 0),
        );

        // Skip-unchanged watermark (hypothesis 010, mirrors 006 for Claude
        // transcripts), now via the shared `fileWatermark` seam. Each subagent
        // jsonl is fully re-parsed via extractFileWithSessionId and its
        // turns/tool_calls/invocations re-written on every run, yet the files
        // are almost always unchanged between runs. The seam does ONE indexed
        // read of every source_kind="claude_subagent" (mtime,size) marker; a
        // manifest whose stat still matches its watermark is output-equivalent
        // to a prior run (its rows persist) so we skip parsing+writing it.
        // `AX_REDERIVE_SUBAGENTS=1` forces a full re-derive.
        const wm = yield* fileWatermark(write, {
            sourceKind: "claude_subagent",
            forceEnv: "AX_REDERIVE_SUBAGENTS",
        });

        let written = 0;
        let skippedUnchanged = 0;
        let missingParent = 0;
        let skippedExisting = 0;
        let repositoryInherited = 0;
        let repositoryBackfilled = 0;
        let turnsTotal = 0;
        let invocationsTotal = 0;
        let toolCallsTotal = 0;
        let editsTotal = 0;
        let planSnapshotsTotal = 0;

        for (const [index, m] of manifests.entries()) {
            if (opts.onProgress && (index < 5 || index % 10 === 0)) {
                yield* opts.onProgress({
                    phase: 2,
                    currentSubagent: index + 1,
                    totalSubagents: manifests.length,
                    subagents: written + missingParent + skippedExisting,
                    written,
                    missingParent,
                    skippedExisting,
                    turns: turnsTotal,
                    invocations: invocationsTotal,
                    toolCalls: toolCallsTotal,
                    edits: editsTotal,
                    planSnapshots: planSnapshotsTotal,
                });
            }
            // Skip-unchanged: a subagent file whose on-disk (mtime,size) still
            // matches its persisted watermark was fully derived in a prior run;
            // its session/turns/tool_calls/spawned edge persist, so skipping is
            // output-equivalent. stat is cheap relative to the full re-parse +
            // DB writes below; we reuse it for the watermark write at the end.
            // Original tolerance: bare stat (FOLLOWS) with any error -> null.
            const fileStat = yield* fs.stat(m.file).pipe(
                Effect.map((info) => ({
                    mtimeMs: Option.getOrElse(info.mtime, () => new Date(0)).getTime(),
                    size: Number(info.size),
                })),
                orAbsent<{ mtimeMs: number; size: number } | null>(null),
            );
            if (fileStat && wm.unchanged(m.file, fileStat.mtimeMs, fileStat.size)) {
                skippedUnchanged += 1;
                continue;
            }

            // Confirm parent exists - subagent without its parent is orphaned data.
            // Also fetch repository/checkout/cwd so we can inherit them below.
            const check = yield* write.rows(Schema.Struct({
                id: Schema.String, repository: Schema.NullOr(Schema.String),
                checkout: Schema.NullOr(Schema.String), cwd: Schema.NullOr(Schema.String),
            }), "SELECT id, repository, checkout, cwd FROM session WHERE id = ?", [m.parentSessionId]);
            if (check.length === 0) {
                missingParent += 1;
                continue;
            }
            const parentRow = check[0]!;

            // Run the Claude extractor against the subagent jsonl using the
            // synthetic session id. This produces turns/invocations/tool_calls
            // attributed to the subagent session, so the dashboard can show
            // *what* it did (Bash, Read, Edit calls etc).
            // `extractFileWithSessionId` is now FileSystem-native: a subagent
            // transcript that VANISHED mid-run surfaces a NotFound
            // PlatformError, which we treat as "no usable content" (→ null)
            // so the run continues; other FS failures die as defects.
            const extracted = yield* extractFileWithSessionId(
                m.file,
                m.project ?? "",
                m.subagentSessionId,
            ).pipe(
                Effect.catchTag("PlatformError", (e) =>
                    isNotFound(e) ? Effect.succeed(null) : Effect.die(e),
                ),
            );

            // Read adjacent meta.json for dispatch metadata (agent type, description, etc.).
            // Missing / unparseable file yields {}; all fields remain optional.
            const meta = yield* readSubagentMeta(m.file);

            // Inherit repository/checkout from parent unconditionally (the extractor
            // never sets them). Inherit cwd from parent only if extractor produced none.
            const parentRepository = parentRow.repository;
            const parentCheckout = parentRow.checkout;
            const parentCwd = typeof parentRow.cwd === "string" && parentRow.cwd.length > 0
                ? parentRow.cwd
                : undefined;

            if (!extracted) {
                // No usable content; still record the session+edge so the link
                // shows in the parent's "spawned" list.
                yield* write.put("session", cacheRow({
                    id: m.subagentSessionId, project: m.project,
                    source: "claude-subagent",
                    started_at: tsParam(m.startedAt), ended_at: tsParam(m.endedAt), raw_file: m.file,
                    repository: parentRepository,
                    checkout: parentCheckout,
                    cwd: parentCwd,
                }));
                if (parentRepository !== null) repositoryInherited += 1;
            } else {
                // Force source=claude-subagent at the upsert level (the extractor
                // doesn't track source; it's set on the DB row).
                // cwd: use extracted value if present, else inherit from parent
                const cwdValue = (extracted.session.cwd != null && extracted.session.cwd !== "")
                    ? extracted.session.cwd
                    : parentCwd;
                yield* write.put("session", cacheRow({
                    id: m.subagentSessionId, project: extracted.session.project ?? m.project,
                    cwd: cwdValue,
                    source: "claude-subagent",
                    model: extracted.session.model ?? null,
                    started_at: tsParam(extracted.session.started_at ?? m.startedAt),
                    ended_at: tsParam(extracted.session.ended_at ?? m.endedAt), raw_file: m.file,
                    repository: parentRepository,
                    checkout: parentCheckout,
                }));
                if (parentRepository !== null) repositoryInherited += 1;

                yield* writeTokenUsageForSubagents(write, extracted);
                yield* upsertTurnsForSubagents(write, extracted.turns);
                yield* writeToolCallStatementsForSubagents(write, extracted.toolCalls);
                yield* writeToolFileEvidenceForSubagents(write, extracted.toolCalls);
                const resolvedInvocations = extracted.invocations.map((inv) => ({
                    ...inv,
                    skill: resolveSkillName(inv.skill, skillCatalog) ?? inv.skill,
                }));
                yield* relateInvocationsForSubagents(write, resolvedInvocations);
                const resolvedSkillRelations = extracted.skillRelations.map((rel) => ({
                    ...rel,
                    skillName: resolveSkillName(rel.skillName, skillCatalog) ?? rel.skillName,
                }));
                yield* relateToolCallSkillsForSubagents(write, resolvedSkillRelations);
                yield* writePlanSnapshotsForSubagents(write, extracted.planSnapshots);

                turnsTotal += extracted.turns.length;
                invocationsTotal += extracted.invocations.length;
                toolCallsTotal += extracted.toolCalls.length;
                editsTotal += extracted.edits.length;
                planSnapshotsTotal += extracted.planSnapshots.length;
            }

            // Idempotent RELATE: dedupe first by exact (in,out) pair.
            yield* write.put("spawned", cacheRow({
                id: edgeRowId("spawned", m.parentSessionId, m.subagentSessionId, "Agent"),
                in_id: m.parentSessionId, out_id: m.subagentSessionId,
                ts: tsParam(m.startedAt) ?? new Date(), tool: "Agent", tool_call: null,
                nickname: m.agentId.slice(0, 12), agent_type: meta.agentType ?? null,
                description: meta.description ?? null, agent_name: meta.name ?? null,
                tool_use_id: meta.toolUseId ?? null,
            }));
            written += 1;

            // Record the watermark only after every write for this file
            // succeeded, so a mid-file failure re-processes next run.
            if (fileStat) {
                yield* wm.commit(m.file, fileStat.mtimeMs, fileStat.size);
            }

            if (opts.onProgress && (index < 5 || (index + 1) % 10 === 0 || index + 1 === manifests.length)) {
                yield* opts.onProgress({
                    phase: 2,
                    currentSubagent: index + 1,
                    totalSubagents: manifests.length,
                    subagents: written + missingParent + skippedExisting,
                    written,
                    missingParent,
                    skippedExisting,
                    turns: turnsTotal,
                    invocations: invocationsTotal,
                    toolCalls: toolCallsTotal,
                    edits: editsTotal,
                    planSnapshots: planSnapshotsTotal,
                });
            }
        }

        // ---------------------------------------------------------------------------
        // Backfill: fix existing claude-subagent rows that are missing repository.
        // For each such row, find its parent via the spawned RELATION and copy
        // repository/checkout/cwd. Idempotent: WHERE clause guards against
        // overwriting rows that already have a value.
        // ---------------------------------------------------------------------------
        const backfillRows = yield* write.rows(Schema.Struct({
            id: Schema.String, parent_repository: Schema.NullOr(Schema.String),
            parent_checkout: Schema.NullOr(Schema.String), parent_cwd: Schema.NullOr(Schema.String),
        }), `SELECT child.id, parent.repository AS parent_repository, parent.checkout AS parent_checkout,
                    parent.cwd AS parent_cwd
             FROM session child JOIN spawned sp ON sp.out_id = child.id
             JOIN session parent ON parent.id = sp.in_id
             WHERE child.source = 'claude-subagent' AND child.repository IS NULL`);

        for (const row of backfillRows) {
            const id = row.id;
            const parentRepo = row.parent_repository;
            const parentCk = row.parent_checkout;
            const parentCwdBf = row.parent_cwd;
            if (id == null || parentRepo == null) continue;
            yield* write.exec("UPDATE session SET repository = ?, checkout = ?, cwd = ? WHERE id = ? AND repository IS NULL",
                [parentRepo, parentCk, parentCwdBf, id]);
            repositoryBackfilled += 1;
        }

        return {
            discovered: manifests.length,
            missingParent,
            written,
            skippedExisting,
            skippedUnchanged,
            repositoryInherited,
            repositoryBackfilled,
            activity: {
                turns: turnsTotal,
                invocations: invocationsTotal,
                toolCalls: toolCallsTotal,
                edits: editsTotal,
                planSnapshots: planSnapshotsTotal,
            },
        };
    });

// ---------------------------------------------------------------------------
// Co-located StageDef
// ---------------------------------------------------------------------------

export const SubagentsKey = Schema.Literal("subagents");
export type SubagentsKey = typeof SubagentsKey.Type;

/**
 * Subagents stage - derives parent↔child session links.
 *
 * Depends on: {@link ClaudeKey}, {@link CodexKey}
 * Consumed by: (none - terminal)
 * Tags: derive
 */
export class SubagentsStats extends BaseStageStats.extend<SubagentsStats>("SubagentsStats")({
    subagentLinksWritten: Schema.Number,
}) {}

export const subagentsStage: StageDef<SubagentsStats, AxConfig | FileSystem.FileSystem | Path.Path, CacheWriteError> = {
    meta: StageMeta.make({ key: "subagents", deps: ["claude", "codex"], tags: ["derive"] }),
    run: (_ctx: IngestContext, write) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const result = yield* deriveClaudeSubagents(write);
            return SubagentsStats.make({
                durationMs: Date.now() - t0,
                summary: `wrote ${result.written} subagent links`,
                subagentLinksWritten: result.written,
            });
        }),
};
