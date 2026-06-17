import { createHash } from "node:crypto";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { AxConfig } from "@ax/lib/config";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { classifyNoFollow } from "@ax/lib/shared/fs-classify";
import { executeStatementsWith } from "@ax/lib/shared/statement-exec";
import { safeKeyPart } from "@ax/lib/shared/derive-keys";
import {
    recordRef,
    surrealJsonTextOption,
    surrealObject,
    surrealOptionDate,
    surrealOptionString,
    surrealString,
} from "@ax/lib/shared/surql";
import { BaseStageStats, IngestContext, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

const MAX_CONTENT_HASH_BYTES = 64 * 1024;

export const CLAUDE_SIDECAR_DIRS = [
    "tool-results",
    "file-history",
    "plans",
    "tasks",
    "session-env",
    "shell-snapshots",
    "debug",
] as const;

export type ClaudeSidecarKind = (typeof CLAUDE_SIDECAR_DIRS)[number] | "stats-cache";

export interface ClaudeSidecarArtifact {
    readonly kind: ClaudeSidecarKind;
    readonly project: string;
    readonly safeRelativePath: string;
    readonly pathHash: string;
    readonly size: number;
    readonly mtime: Date;
    readonly contentHash: string | null;
    readonly sessionId: string | null;
    readonly relationIds: Record<string, string>;
    readonly relationAttrs: Record<string, unknown>;
    readonly observedAt: Date;
    readonly excerpt: string | null;
    readonly attrs: Record<string, unknown>;
}

export interface DiscoverClaudeSidecarArtifactsOptions {
    readonly transcriptsDir: string;
    readonly project?: string;
}

export interface IngestClaudeSidecarsStats {
    readonly discovered: number;
    readonly written: number;
}

const sha256 = (input: string | Uint8Array): string =>
    createHash("sha256").update(input).digest("hex");

const normalizeRel = (value: string): string => value.replace(/\\/g, "/").replace(/^\/+/, "");

const validProjectSlug = (value: string): boolean =>
    value.length > 0 &&
    !value.includes("/") &&
    !value.includes("\\") &&
    value !== "." &&
    value !== ".." &&
    !value.includes("..");

const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

const extractSessionId = (relativePath: string): string | null => {
    const match = relativePath.match(uuidRe);
    return match ? match[0] : null;
};

const pathDepth = (relativePath: string): number =>
    normalizeRel(relativePath).split("/").filter(Boolean).length;

const dateFromStatMtime = (mtime: Option.Option<Date>): Date =>
    Option.getOrElse(mtime, () => new Date(0));

const fileContentMetadata = (
    filePath: string,
    size: number,
): Effect.Effect<{
    readonly contentHash: string | null;
    readonly attrs: Record<string, unknown>;
}, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        if (size > MAX_CONTENT_HASH_BYTES) {
            return {
                contentHash: null,
                attrs: {
                    content_hash_skipped: true,
                    excerpt_skipped: true,
                    skip_reason: "file_too_large",
                },
            };
        }

        const fs = yield* FileSystem.FileSystem;
        const bytes = yield* fs.readFile(filePath).pipe(orAbsent<Uint8Array | null>(null));
        if (bytes === null) {
            return {
                contentHash: null,
                attrs: {
                    content_hash_skipped: true,
                    excerpt_skipped: true,
                    skip_reason: "read_failed",
                },
            };
        }

        return {
            contentHash: sha256(bytes),
            attrs: {
                content_hash_skipped: false,
                excerpt_skipped: true,
            },
        };
    });

const buildArtifact = (
    input: {
        readonly kind: ClaudeSidecarKind;
        readonly project: string;
        readonly relativePath: string;
        readonly absolutePath: string;
        readonly size: number;
        readonly mtime: Date;
        readonly observedAt: Date;
    },
): Effect.Effect<ClaudeSidecarArtifact, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const identityPath = normalizeRel(`${input.project}/${input.relativePath}`);
        const pathHash = sha256(identityPath);
        const safeRelativePath = normalizeRel(`${input.project}/${input.kind}/${pathHash.slice(0, 16)}`);
        const sessionId = extractSessionId(input.relativePath);
        const content = yield* fileContentMetadata(input.absolutePath, input.size);
        return {
            kind: input.kind,
            project: input.project,
            safeRelativePath,
            pathHash,
            size: Math.trunc(input.size),
            mtime: input.mtime,
            contentHash: content.contentHash,
            sessionId,
            relationIds: sessionId ? { session_id: sessionId } : {},
            relationAttrs: {
                sidecar_kind: input.kind,
                path_hash: pathHash,
                path_depth: pathDepth(input.relativePath),
            },
            observedAt: input.observedAt,
            excerpt: null,
            attrs: content.attrs,
        };
    });

const discoverFile = (
    args: {
        readonly kind: ClaudeSidecarKind;
        readonly project: string;
        readonly absolutePath: string;
        readonly relativePath: string;
        readonly observedAt: Date;
    },
): Effect.Effect<ClaudeSidecarArtifact | null, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const entryKind = yield* classifyNoFollow(args.absolutePath);
        if (entryKind !== "File") return null;
        const stat = yield* fs.stat(args.absolutePath).pipe(orAbsent(null as FileSystem.File.Info | null));
        if (stat === null || stat.type !== "File") return null;
        return yield* buildArtifact({
            kind: args.kind,
            project: args.project,
            absolutePath: args.absolutePath,
            relativePath: normalizeRel(args.relativePath),
            size: Number(stat.size),
            mtime: dateFromStatMtime(stat.mtime),
            observedAt: args.observedAt,
        });
    });

const walkSidecarDir = (
    args: {
        readonly kind: ClaudeSidecarKind;
        readonly project: string;
        readonly rootDir: string;
        readonly dirPath: string;
        readonly relativePrefix: string;
        readonly observedAt: Date;
    },
): Effect.Effect<ClaudeSidecarArtifact[], never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const rootKind = yield* classifyNoFollow(args.dirPath);
        if (rootKind !== "Directory") return [];
        const entries = yield* fs.readDirectory(args.dirPath).pipe(orAbsent<ReadonlyArray<string>>([]));
        const out: ClaudeSidecarArtifact[] = [];

        for (const entry of entries) {
            const absolutePath = path.join(args.dirPath, entry);
            const relativePath = normalizeRel(path.join(args.relativePrefix, entry));
            const entryKind = yield* classifyNoFollow(absolutePath);
            if (entryKind === "Directory") {
                const nested = yield* walkSidecarDir({
                    ...args,
                    dirPath: absolutePath,
                    relativePrefix: relativePath,
                });
                out.push(...nested);
                continue;
            }
            if (entryKind !== "File") continue;

            const stat = yield* fs.stat(absolutePath).pipe(orAbsent(null as FileSystem.File.Info | null));
            if (stat === null || stat.type !== "File") continue;
            out.push(yield* buildArtifact({
                kind: args.kind,
                project: args.project,
                absolutePath,
                relativePath,
                size: Number(stat.size),
                mtime: dateFromStatMtime(stat.mtime),
                observedAt: args.observedAt,
            }));
        }

        return out;
    });

const discoverProjectSidecars = (
    transcriptsDir: string,
    project: string,
    observedAt: Date,
): Effect.Effect<ClaudeSidecarArtifact[], never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        if (!validProjectSlug(project)) return [];
        const path = yield* Path.Path;
        const projectRoot = path.join(transcriptsDir, project);
        const out: ClaudeSidecarArtifact[] = [];

        for (const kind of CLAUDE_SIDECAR_DIRS) {
            const records = yield* walkSidecarDir({
                kind,
                project,
                rootDir: projectRoot,
                dirPath: path.join(projectRoot, kind),
                relativePrefix: kind,
                observedAt,
            });
            out.push(...records);
        }

        const statsCache = yield* discoverFile({
            kind: "stats-cache",
            project,
            absolutePath: path.join(projectRoot, "stats-cache.json"),
            relativePath: "stats-cache.json",
            observedAt,
        });
        if (statsCache) out.push(statsCache);

        return out.sort((a, b) => a.safeRelativePath.localeCompare(b.safeRelativePath));
    });

export const discoverClaudeSidecarArtifacts = (
    opts: DiscoverClaudeSidecarArtifactsOptions,
): Effect.Effect<ClaudeSidecarArtifact[], never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const observedAt = new Date();
        const projects = opts.project
            ? [opts.project]
            : (yield* fs.readDirectory(opts.transcriptsDir).pipe(orAbsent<ReadonlyArray<string>>([]))).filter(validProjectSlug);
        const out: ClaudeSidecarArtifact[] = [];

        for (const project of projects) {
            const projectRoot = path.join(opts.transcriptsDir, project);
            const entryKind = yield* classifyNoFollow(projectRoot);
            if (entryKind !== "Directory") continue;
            const stat = yield* fs.stat(projectRoot).pipe(orAbsent(null as FileSystem.File.Info | null));
            if (stat === null || stat.type !== "Directory") continue;
            const records = yield* discoverProjectSidecars(opts.transcriptsDir, project, observedAt);
            out.push(...records);
        }

        return out.sort((a, b) => a.safeRelativePath.localeCompare(b.safeRelativePath));
    });

export const claudeSidecarArtifactKey = (record: Pick<ClaudeSidecarArtifact, "pathHash">): string =>
    safeKeyPart(record.pathHash);

const intLiteral = (value: number): string =>
    Number.isFinite(value) ? Math.trunc(value).toString(10) : "0";

export const buildClaudeSidecarStatements = (
    records: readonly ClaudeSidecarArtifact[],
): string[] =>
    records.map((record) =>
        `UPSERT ${recordRef("claude_sidecar_artifact", claudeSidecarArtifactKey(record))} CONTENT ${surrealObject([
            ["kind", surrealString(record.kind)],
            ["project", surrealString(record.project)],
            ["safe_relative_path", surrealString(record.safeRelativePath)],
            ["path_hash", surrealString(record.pathHash)],
            ["size", intLiteral(record.size)],
            ["mtime", surrealOptionDate(record.mtime)],
            ["content_hash", surrealOptionString(record.contentHash)],
            ["session", record.sessionId ? recordRef("session", record.sessionId) : "NONE"],
            ["relation_ids_json", surrealJsonTextOption(record.relationIds)],
            ["relation_attrs_json", surrealJsonTextOption(record.relationAttrs)],
            ["observed_at", surrealOptionDate(record.observedAt)],
            ["excerpt", surrealOptionString(record.excerpt)],
            ["attrs_json", surrealJsonTextOption(record.attrs)],
        ])};`
    );

export const ingestClaudeSidecars = (
    project?: string,
): Effect.Effect<
    IngestClaudeSidecarsStats,
    DbError,
    SurrealClient | AxConfig | FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const cfg = yield* AxConfig;
        const db = yield* SurrealClient;
        const records = yield* discoverClaudeSidecarArtifacts({
            transcriptsDir: cfg.paths.transcriptsDir,
            ...(project === undefined ? {} : { project }),
        });
        const statements = buildClaudeSidecarStatements(records);
        yield* executeStatementsWith(db, statements, { chunkSize: 500, label: "claudeSidecars" });
        return {
            discovered: records.length,
            written: statements.length,
        };
    });

export class ClaudeSidecarsStats extends BaseStageStats.extend<ClaudeSidecarsStats>("ClaudeSidecarsStats")({
    artifactsDiscovered: Schema.Number,
    artifactsWritten: Schema.Number,
}) {}

export const claudeSidecarsStage: StageDef<
    ClaudeSidecarsStats,
    SurrealClient | AxConfig | FileSystem.FileSystem | Path.Path
> = {
    meta: StageMeta.make({ key: "claude-sidecars", deps: ["claude", "subagents"], tags: ["ingest"] }),
    run: (ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const result = yield* ingestClaudeSidecars(ctx.claudeProject);
            return ClaudeSidecarsStats.make({
                durationMs: Date.now() - t0,
                summary: `ingested ${result.written} Claude sidecar artifacts`,
                artifactsDiscovered: result.discovered,
                artifactsWritten: result.written,
            });
        }),
};
