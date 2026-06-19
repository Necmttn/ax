import { createHash } from "node:crypto";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { AxConfig } from "@ax/lib/config";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { decodeJsonOrNull } from "@ax/lib/decode";
import type { DbError } from "@ax/lib/errors";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { classifyNoFollow } from "@ax/lib/shared/fs-classify";
import { executeStatementsWith } from "@ax/lib/shared/statement-exec";
import { safeKeyPart } from "@ax/lib/shared/derive-keys";
import {
    recordKeyPart,
    recordRef,
    surrealDate,
    surrealJsonTextOption,
    surrealObject,
    surrealOptionDate,
    surrealOptionInt,
    surrealOptionString,
    surrealString,
} from "@ax/lib/shared/surreal";
import { buildPlanSnapshotStatements, type PlanSnapshotWrite } from "./evidence-writers.ts";
import {
    toPlanSnapshotWrite,
    type NormalizedPlanItem,
    type NormalizedPlanSnapshot,
    type PlanStatus,
} from "./plans.ts";
import { BaseStageStats, IngestContext, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

const MAX_CONTENT_HASH_BYTES = 64 * 1024;
const MAX_PLAN_SIDECAR_BYTES = 64 * 1024;
const MAX_VISIBLE_PLAN_ITEMS = 100;
const MAX_VISIBLE_PLAN_ITEM_CHARS = 500;
const MAX_USAGE_DETAIL_CHARS = 240;

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
    readonly planSnapshotsWritten: number;
    readonly usageEdgesWritten: number;
}

export type ClaudeSidecarUsageAction = "produced" | "read" | "searched" | "inspected";

export interface ClaudeSidecarUsageEdge {
    readonly toolCallKey: string;
    readonly artifactKey: string;
    readonly sessionId: string | null;
    readonly action: ClaudeSidecarUsageAction;
    readonly source: "output_excerpt" | "read_input" | "command_text";
    readonly sidecarKind: ClaudeSidecarKind;
    readonly pathHash: string;
    readonly commandTool: string | null;
    readonly pattern: string | null;
    readonly offset: number | null;
    readonly limit: number | null;
    readonly ts: string;
}

export interface ClaudeToolCallSidecarRow {
    readonly id: string;
    readonly session: string | null;
    readonly name: string | null;
    readonly inputJson: string | null;
    readonly outputExcerpt: string | null;
    readonly commandText: string | null;
    readonly commandNorm: string | null;
    readonly ts: string | null;
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

const normalizePathString = (value: string): string =>
    value.replace(/\\/g, "/").replace(/\/+$/, "");

const stripTrailingPathPunctuation = (value: string): string =>
    value.replace(/[),.;:]+$/g, "");

const escapeRegExp = (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isSidecarKindSegment = (value: string): value is (typeof CLAUDE_SIDECAR_DIRS)[number] =>
    (CLAUDE_SIDECAR_DIRS as readonly string[]).includes(value);

const sidecarKindFromParts = (parts: readonly string[]): ClaudeSidecarKind | null => {
    if (parts[0] === "stats-cache.json") return "stats-cache";
    if (parts[0] && isSidecarKindSegment(parts[0])) return parts[0];
    if (parts[0] && uuidRe.test(parts[0]) && parts[1] && isSidecarKindSegment(parts[1])) return parts[1];
    return null;
};

export interface ClaudeSidecarPathRef {
    readonly project: string;
    readonly relativePath: string;
    readonly kind: ClaudeSidecarKind;
    readonly pathHash: string;
}

export const claudeSidecarPathRefFromPath = (
    input: {
        readonly path: string;
        readonly transcriptsDir: string;
    },
): ClaudeSidecarPathRef | null => {
    const root = `${normalizePathString(input.transcriptsDir)}/`;
    const candidate = stripTrailingPathPunctuation(normalizePathString(input.path));
    if (!candidate.startsWith(root)) return null;
    const relative = normalizeRel(candidate.slice(root.length));
    const [project, ...parts] = relative.split("/").filter(Boolean);
    if (!project || !validProjectSlug(project) || parts.length === 0) return null;
    const kind = sidecarKindFromParts(parts);
    if (!kind) return null;
    const relativePath = normalizeRel(parts.join("/"));
    return {
        project,
        relativePath,
        kind,
        pathHash: sha256(normalizeRel(`${project}/${relativePath}`)),
    };
};

export const extractClaudeSidecarPathRefs = (
    input: {
        readonly text: string | null | undefined;
        readonly transcriptsDir: string;
    },
): ClaudeSidecarPathRef[] => {
    if (!input.text) return [];
    const root = normalizePathString(input.transcriptsDir);
    const pathRe = new RegExp(`${escapeRegExp(root)}/[^\\s"'<>]+`, "g");
    const refs = new Map<string, ClaudeSidecarPathRef>();
    for (const match of input.text.matchAll(pathRe)) {
        const ref = claudeSidecarPathRefFromPath({
            path: match[0] ?? "",
            transcriptsDir: input.transcriptsDir,
        });
        if (ref) refs.set(ref.pathHash, ref);
    }
    return [...refs.values()];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const asRecordArray = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? value.filter(isRecord) : [];

const stringField = (record: Record<string, unknown>, field: string): string | null => {
    const value = record[field];
    return typeof value === "string" ? value : null;
};

const recordField = (record: Record<string, unknown>, field: string): Record<string, unknown> | null => {
    const value = record[field];
    return isRecord(value) ? value : null;
};

const firstNonEmpty = (...values: readonly (string | null | undefined)[]): string | null => {
    for (const value of values) {
        const trimmed = value?.trim();
        if (trimmed && trimmed.length > 0) return trimmed;
    }
    return null;
};

const visiblePlanText = (...values: readonly (string | null | undefined)[]): string | null => {
    const text = firstNonEmpty(...values);
    if (!text) return null;
    return text.length > MAX_VISIBLE_PLAN_ITEM_CHARS
        ? `${text.slice(0, MAX_VISIBLE_PLAN_ITEM_CHARS)}...`
        : text;
};

const normalizeSidecarStatus = (status: string | null | undefined): PlanStatus => {
    const normalized = status?.trim().toLowerCase();
    if (normalized === "completed" || normalized === "done" || normalized === "complete") return "completed";
    if (normalized === "active" || normalized === "in_progress" || normalized === "running") return "in_progress";
    if (normalized === "deleted" || normalized === "abandoned" || normalized === "cancelled" || normalized === "canceled") {
        return "abandoned";
    }
    return "pending";
};

const taskItemFromRecord = (
    record: Record<string, unknown>,
    seq: number,
): NormalizedPlanItem | null => {
    const task = recordField(record, "task") ?? record;
    const externalId = firstNonEmpty(
        stringField(task, "id"),
        stringField(task, "taskId"),
        stringField(task, "task_id"),
    );
    const content = visiblePlanText(
        stringField(task, "subject"),
        stringField(task, "description"),
        stringField(task, "content"),
        stringField(task, "text"),
        stringField(task, "title"),
        externalId,
    );
    if (!content) return null;

    return {
        externalId,
        seq,
        content,
        activeForm: visiblePlanText(stringField(task, "activeForm"), stringField(task, "active_form")),
        status: normalizeSidecarStatus(stringField(task, "status")),
    };
};

const planItemFromRecord = (
    record: Record<string, unknown>,
    seq: number,
): NormalizedPlanItem | null => {
    const content = visiblePlanText(
        stringField(record, "step"),
        stringField(record, "content"),
        stringField(record, "text"),
        stringField(record, "title"),
        stringField(record, "subject"),
        stringField(record, "description"),
    );
    if (!content) return null;

    return {
        externalId: firstNonEmpty(stringField(record, "id"), stringField(record, "taskId"), stringField(record, "task_id")),
        seq,
        content,
        activeForm: visiblePlanText(stringField(record, "activeForm"), stringField(record, "active_form")),
        status: normalizeSidecarStatus(stringField(record, "status")),
    };
};

const jsonTaskRecords = (parsed: unknown): Record<string, unknown>[] => {
    if (Array.isArray(parsed)) return asRecordArray(parsed);
    if (!isRecord(parsed)) return [];
    const task = recordField(parsed, "task");
    if (task) return [task];
    const tasks = asRecordArray(parsed.tasks);
    if (tasks.length > 0) return tasks;
    return [parsed];
};

const jsonPlanRecords = (parsed: unknown): Record<string, unknown>[] => {
    if (Array.isArray(parsed)) return asRecordArray(parsed);
    if (!isRecord(parsed)) return [];
    for (const field of ["plan", "items", "todos", "tasks"]) {
        const records = asRecordArray(parsed[field]);
        if (records.length > 0) return records;
    }
    return [parsed];
};

const markdownPlanItems = (text: string): NormalizedPlanItem[] => {
    const items: NormalizedPlanItem[] = [];
    const lineRe = /^\s*(?:[-*]|\d+[.)])\s+(?:\[([ xX-])\]\s*)?(.+?)\s*$/;
    for (const line of text.split(/\r?\n/)) {
        const match = line.match(lineRe);
        if (!match) continue;
        const content = visiblePlanText(match[2] ?? null);
        if (!content) continue;
        const marker = match[1]?.toLowerCase();
        items.push({
            externalId: null,
            seq: items.length + 1,
            content,
            activeForm: null,
            status: marker === "x" ? "completed" : marker === "-" ? "abandoned" : "pending",
        });
        if (items.length >= MAX_VISIBLE_PLAN_ITEMS) break;
    }
    return items;
};

const sidecarPlanSnapshotFromText = (input: {
    readonly kind: "plans" | "tasks";
    readonly sessionId: string;
    readonly text: string;
    readonly ts: string;
}): NormalizedPlanSnapshot | null => {
    const parsed = decodeJsonOrNull(input.text);
    const items: NormalizedPlanItem[] = [];

    if (input.kind === "tasks") {
        for (const record of jsonTaskRecords(parsed)) {
            const item = taskItemFromRecord(record, items.length + 1);
            if (item) items.push(item);
            if (items.length >= MAX_VISIBLE_PLAN_ITEMS) break;
        }
    } else if (parsed !== null) {
        for (const record of jsonPlanRecords(parsed)) {
            const item = planItemFromRecord(record, items.length + 1);
            if (item) items.push(item);
            if (items.length >= MAX_VISIBLE_PLAN_ITEMS) break;
        }
    } else {
        items.push(...markdownPlanItems(input.text));
    }

    if (items.length === 0) return null;

    return {
        provider: "claude",
        sessionId: input.sessionId,
        source: input.kind === "tasks" ? "claude_sidecar_task" : "claude_sidecar_plan",
        ts: input.ts,
        explanation: input.kind === "tasks" ? "Claude tasks sidecar" : "Claude plans sidecar",
        items,
    };
};

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
        const fs = yield* FileSystem.FileSystem;
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

        const entries = yield* fs.readDirectory(projectRoot).pipe(orAbsent<ReadonlyArray<string>>([]));
        for (const sessionDir of entries) {
            if (!uuidRe.test(sessionDir)) continue;
            const sessionRoot = path.join(projectRoot, sessionDir);
            const sessionRootKind = yield* classifyNoFollow(sessionRoot);
            if (sessionRootKind !== "Directory") continue;
            for (const kind of CLAUDE_SIDECAR_DIRS) {
                const records = yield* walkSidecarDir({
                    kind,
                    project,
                    rootDir: projectRoot,
                    dirPath: path.join(sessionRoot, kind),
                    relativePrefix: normalizeRel(path.join(sessionDir, kind)),
                    observedAt,
                });
                out.push(...records);
            }
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

interface DiscoveredSidecarPlanSnapshot {
    readonly snapshot: NormalizedPlanSnapshot;
    readonly mtime: Date;
    readonly pathHash: string;
}

const readSmallSidecarText = (
    filePath: string,
    size: number,
): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        if (size > MAX_PLAN_SIDECAR_BYTES) return null;
        const fs = yield* FileSystem.FileSystem;
        const bytes = yield* fs.readFile(filePath).pipe(orAbsent<Uint8Array | null>(null));
        if (bytes === null) return null;
        return new TextDecoder().decode(bytes);
    });

const discoverPlanSnapshotFile = (
    args: {
        readonly kind: "plans" | "tasks";
        readonly project: string;
        readonly absolutePath: string;
        readonly relativePath: string;
    },
): Effect.Effect<DiscoveredSidecarPlanSnapshot | null, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const entryKind = yield* classifyNoFollow(args.absolutePath);
        if (entryKind !== "File") return null;
        const fs = yield* FileSystem.FileSystem;
        const stat = yield* fs.stat(args.absolutePath).pipe(orAbsent(null as FileSystem.File.Info | null));
        if (stat === null || stat.type !== "File") return null;
        const sessionId = extractSessionId(args.relativePath);
        if (sessionId === null) return null;
        const text = yield* readSmallSidecarText(args.absolutePath, Number(stat.size));
        if (text === null) return null;
        const mtime = dateFromStatMtime(stat.mtime);
        const snapshot = sidecarPlanSnapshotFromText({
            kind: args.kind,
            sessionId,
            text,
            ts: mtime.toISOString(),
        });
        if (snapshot === null) return null;
        return {
            snapshot,
            mtime,
            pathHash: sha256(normalizeRel(`${args.project}/${args.relativePath}`)),
        };
    });

const walkSidecarPlanDir = (
    args: {
        readonly kind: "plans" | "tasks";
        readonly project: string;
        readonly dirPath: string;
        readonly relativePrefix: string;
    },
): Effect.Effect<DiscoveredSidecarPlanSnapshot[], never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const rootKind = yield* classifyNoFollow(args.dirPath);
        if (rootKind !== "Directory") return [];
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const entries = yield* fs.readDirectory(args.dirPath).pipe(orAbsent<ReadonlyArray<string>>([]));
        const out: DiscoveredSidecarPlanSnapshot[] = [];

        for (const entry of entries) {
            const absolutePath = path.join(args.dirPath, entry);
            const relativePath = normalizeRel(path.join(args.relativePrefix, entry));
            const entryKind = yield* classifyNoFollow(absolutePath);
            if (entryKind === "Directory") {
                const nested = yield* walkSidecarPlanDir({
                    ...args,
                    dirPath: absolutePath,
                    relativePrefix: relativePath,
                });
                out.push(...nested);
                continue;
            }
            if (entryKind !== "File") continue;
            const snapshot = yield* discoverPlanSnapshotFile({
                kind: args.kind,
                project: args.project,
                absolutePath,
                relativePath,
            });
            if (snapshot) out.push(snapshot);
        }

        return out;
    });

const discoverProjectSidecarPlanSnapshots = (
    transcriptsDir: string,
    project: string,
): Effect.Effect<DiscoveredSidecarPlanSnapshot[], never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        if (!validProjectSlug(project)) return [];
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectRoot = path.join(transcriptsDir, project);
        const rootKind = yield* classifyNoFollow(projectRoot);
        if (rootKind !== "Directory") return [];
        const out: DiscoveredSidecarPlanSnapshot[] = [];
        for (const kind of ["plans", "tasks"] as const) {
            const snapshots = yield* walkSidecarPlanDir({
                kind,
                project,
                dirPath: path.join(projectRoot, kind),
                relativePrefix: kind,
            });
            out.push(...snapshots);
        }
        const entries = yield* fs.readDirectory(projectRoot).pipe(orAbsent<ReadonlyArray<string>>([]));
        for (const sessionDir of entries) {
            if (!uuidRe.test(sessionDir)) continue;
            const sessionRoot = path.join(projectRoot, sessionDir);
            const sessionRootKind = yield* classifyNoFollow(sessionRoot);
            if (sessionRootKind !== "Directory") continue;
            for (const kind of ["plans", "tasks"] as const) {
                const snapshots = yield* walkSidecarPlanDir({
                    kind,
                    project,
                    dirPath: path.join(sessionRoot, kind),
                    relativePrefix: normalizeRel(path.join(sessionDir, kind)),
                });
                out.push(...snapshots);
            }
        }
        return out;
    });

export const discoverClaudeSidecarPlanSnapshots = (
    opts: DiscoverClaudeSidecarArtifactsOptions,
): Effect.Effect<PlanSnapshotWrite[], never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const projects = opts.project
            ? [opts.project]
            : (yield* fs.readDirectory(opts.transcriptsDir).pipe(orAbsent<ReadonlyArray<string>>([]))).filter(validProjectSlug);
        const discovered: DiscoveredSidecarPlanSnapshot[] = [];

        for (const project of projects) {
            const snapshots = yield* discoverProjectSidecarPlanSnapshots(opts.transcriptsDir, project);
            discovered.push(...snapshots);
        }

        const counts = new Map<string, number>();
        return discovered
            .sort((a, b) =>
                `${a.snapshot.sessionId}\0${a.snapshot.source}\0${a.pathHash}`.localeCompare(
                    `${b.snapshot.sessionId}\0${b.snapshot.source}\0${b.pathHash}`,
                )
            )
            .map((entry) => {
                const countKey = `${entry.snapshot.sessionId}\0${entry.snapshot.source}`;
                const snapshotSeq = (counts.get(countKey) ?? 0) + 1;
                counts.set(countKey, snapshotSeq);
                return toPlanSnapshotWrite({
                    snapshot: entry.snapshot,
                    snapshotSeq,
                    createdAt: entry.mtime.toISOString(),
                    toolCallKey: null,
                });
            });
    });

export const buildClaudeSidecarPlanSnapshotStatements = (
    snapshots: readonly PlanSnapshotWrite[],
): string[] => snapshots.flatMap(buildPlanSnapshotStatements);

const numberField = (record: Record<string, unknown>, field: string): number | null => {
    const value = record[field];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const detailText = (value: string | null | undefined): string | null => {
    const text = value?.trim();
    if (!text) return null;
    return text.length > MAX_USAGE_DETAIL_CHARS
        ? `${text.slice(0, MAX_USAGE_DETAIL_CHARS)}...`
        : text;
};

const SEARCH_COMMANDS = new Set(["rg", "grep", "ag", "ack", "fd"]);
const INSPECT_COMMANDS = new Set(["cat", "bat", "sed", "awk", "head", "tail", "less", "more", "wc", "python", "python3", "node", "bun"]);

const commandWords = (command: string): string[] =>
    [...command.matchAll(/[A-Za-z0-9_.-]+/g)].map((match) => match[0] ?? "");

const commandToolFromText = (command: string | null | undefined): string | null => {
    if (!command) return null;
    const words = commandWords(command);
    for (const word of words) {
        if (SEARCH_COMMANDS.has(word) || INSPECT_COMMANDS.has(word)) return word;
    }
    return words.find((word) => !word.includes("=")) ?? null;
};

const usageActionForCommand = (commandTool: string | null): ClaudeSidecarUsageAction =>
    commandTool && SEARCH_COMMANDS.has(commandTool) ? "searched" : "inspected";

const unquoteShellWord = (value: string): string =>
    ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))
        ? value.slice(1, -1)
        : value;

const extractSearchPattern = (
    command: string | null | undefined,
    commandTool: string | null,
    transcriptsDir: string,
): string | null => {
    if (!command || !commandTool || !SEARCH_COMMANDS.has(commandTool)) return null;
    const words = command.match(/"[^"]*"|'[^']*'|\S+/g)?.map(unquoteShellWord) ?? [];
    const commandIndex = words.findIndex((word) => word === commandTool || word.endsWith(`/${commandTool}`));
    if (commandIndex < 0) return null;
    for (const word of words.slice(commandIndex + 1)) {
        if (word.startsWith("-")) continue;
        if (claudeSidecarPathRefFromPath({ path: word, transcriptsDir })) continue;
        return detailText(word);
    }
    return null;
};

const usageEdgeKey = (edge: ClaudeSidecarUsageEdge): string =>
    sha256([
        edge.toolCallKey,
        edge.artifactKey,
        edge.action,
        edge.source,
        edge.commandTool ?? "",
        edge.pattern ?? "",
        edge.offset?.toString(10) ?? "",
        edge.limit?.toString(10) ?? "",
    ].join("\0"));

const sidecarArtifactMap = (
    artifacts: readonly ClaudeSidecarArtifact[],
): Map<string, ClaudeSidecarArtifact> => {
    const out = new Map<string, ClaudeSidecarArtifact>();
    for (const artifact of artifacts) out.set(artifact.pathHash, artifact);
    return out;
};

export const buildClaudeSidecarUsageEdges = (
    input: {
        readonly rows: readonly ClaudeToolCallSidecarRow[];
        readonly artifacts: readonly ClaudeSidecarArtifact[];
        readonly transcriptsDir: string;
    },
): ClaudeSidecarUsageEdge[] => {
    const artifacts = sidecarArtifactMap(input.artifacts);
    const out = new Map<string, ClaudeSidecarUsageEdge>();

    const push = (
        row: ClaudeToolCallSidecarRow,
        ref: ClaudeSidecarPathRef,
        details: Omit<ClaudeSidecarUsageEdge, "toolCallKey" | "artifactKey" | "sessionId" | "sidecarKind" | "pathHash" | "ts">,
    ) => {
        const artifact = artifacts.get(ref.pathHash);
        if (!artifact) return;
        const toolCallKey = recordKeyPart(row.id, "tool_call");
        if (!toolCallKey) return;
        const sessionId = recordKeyPart(row.session, "session");
        const edge: ClaudeSidecarUsageEdge = {
            toolCallKey,
            artifactKey: claudeSidecarArtifactKey(artifact),
            sessionId,
            sidecarKind: artifact.kind,
            pathHash: artifact.pathHash,
            ts: row.ts ?? artifact.mtime.toISOString(),
            ...details,
        };
        out.set(usageEdgeKey(edge), edge);
    };

    for (const row of input.rows) {
        for (const ref of extractClaudeSidecarPathRefs({ text: row.outputExcerpt, transcriptsDir: input.transcriptsDir })) {
            push(row, ref, {
                action: "produced",
                source: "output_excerpt",
                commandTool: null,
                pattern: null,
                offset: null,
                limit: null,
            });
        }

        const parsedInput = row.inputJson ? decodeJsonOrNull(row.inputJson) : null;
        if (isRecord(parsedInput)) {
            const filePath = firstNonEmpty(
                stringField(parsedInput, "file_path"),
                stringField(parsedInput, "path"),
            );
            for (const ref of extractClaudeSidecarPathRefs({ text: filePath, transcriptsDir: input.transcriptsDir })) {
                push(row, ref, {
                    action: "read",
                    source: "read_input",
                    commandTool: row.name === "Read" ? "Read" : null,
                    pattern: null,
                    offset: numberField(parsedInput, "offset"),
                    limit: numberField(parsedInput, "limit"),
                });
            }
        }

        if (row.commandText) {
            const commandTool = commandToolFromText(row.commandNorm) ?? commandToolFromText(row.commandText);
            for (const ref of extractClaudeSidecarPathRefs({ text: row.commandText, transcriptsDir: input.transcriptsDir })) {
                push(row, ref, {
                    action: usageActionForCommand(commandTool),
                    source: "command_text",
                    commandTool,
                    pattern: extractSearchPattern(row.commandText, commandTool, input.transcriptsDir),
                    offset: null,
                    limit: null,
                });
            }
        }
    }

    return [...out.values()].sort((a, b) =>
        `${a.toolCallKey}\0${a.artifactKey}\0${a.action}\0${a.source}`.localeCompare(
            `${b.toolCallKey}\0${b.artifactKey}\0${b.action}\0${b.source}`,
        )
    );
};

const queryClaudeToolCallRowsForSessions = (
    db: SurrealClientShape,
    sessionIds: readonly string[],
): Effect.Effect<ClaudeToolCallSidecarRow[], DbError> =>
    Effect.gen(function* () {
        if (sessionIds.length === 0) return [];
        const rows: ClaudeToolCallSidecarRow[] = [];
        for (let i = 0; i < sessionIds.length; i += 100) {
            const chunk = sessionIds.slice(i, i + 100);
            const refs = chunk.map((sessionId) => recordRef("session", sessionId)).join(", ");
            const [result] = yield* db.query<[ClaudeToolCallSidecarRow[]]>(`
SELECT type::string(id) AS id,
       type::string(session) AS session,
       name,
       input_json AS inputJson,
       output_excerpt AS outputExcerpt,
       command_text AS commandText,
       command_norm AS commandNorm,
       type::string(ts) AS ts
FROM tool_call
WHERE session IN [${refs}];
`);
            rows.push(...(result ?? []));
        }
        return rows;
    });

const discoverClaudeSidecarUsageEdges = (
    input: {
        readonly db: SurrealClientShape;
        readonly transcriptsDir: string;
        readonly artifacts: readonly ClaudeSidecarArtifact[];
    },
): Effect.Effect<ClaudeSidecarUsageEdge[], DbError> =>
    Effect.gen(function* () {
        const sessionIds = [
            ...new Set(input.artifacts.map((artifact) => artifact.sessionId).filter((sessionId): sessionId is string => !!sessionId)),
        ];
        const rows = yield* queryClaudeToolCallRowsForSessions(input.db, sessionIds);
        return buildClaudeSidecarUsageEdges({
            rows,
            artifacts: input.artifacts,
            transcriptsDir: input.transcriptsDir,
        });
    });

export const buildClaudeSidecarUsageStatements = (
    edges: readonly ClaudeSidecarUsageEdge[],
): string[] =>
    edges.map((edge) =>
        `RELATE ${recordRef("tool_call", edge.toolCallKey)}->${recordRef("used_sidecar_artifact", usageEdgeKey(edge))}->${recordRef("claude_sidecar_artifact", edge.artifactKey)} SET ${[
            `session = ${edge.sessionId ? recordRef("session", edge.sessionId) : "NONE"}`,
            `action = ${surrealString(edge.action)}`,
            `source = ${surrealString(edge.source)}`,
            `sidecar_kind = ${surrealString(edge.sidecarKind)}`,
            `path_hash = ${surrealString(edge.pathHash)}`,
            `command_tool = ${surrealOptionString(edge.commandTool)}`,
            `pattern = ${surrealOptionString(edge.pattern)}`,
            `offset = ${surrealOptionInt(edge.offset)}`,
            `limit = ${surrealOptionInt(edge.limit)}`,
            `ts = ${surrealDate(edge.ts)}`,
        ].join(", ")};`
    );

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
        const planSnapshots = yield* discoverClaudeSidecarPlanSnapshots({
            transcriptsDir: cfg.paths.transcriptsDir,
            ...(project === undefined ? {} : { project }),
        });
        const usageEdges = yield* discoverClaudeSidecarUsageEdges({
            db,
            transcriptsDir: cfg.paths.transcriptsDir,
            artifacts: records,
        });
        const statements = [
            ...buildClaudeSidecarStatements(records),
            ...buildClaudeSidecarUsageStatements(usageEdges),
            ...buildClaudeSidecarPlanSnapshotStatements(planSnapshots),
        ];
        yield* executeStatementsWith(db, statements, { chunkSize: 500, label: "claudeSidecars" });
        return {
            discovered: records.length,
            written: records.length,
            planSnapshotsWritten: planSnapshots.length,
            usageEdgesWritten: usageEdges.length,
        };
    });

export class ClaudeSidecarsStats extends BaseStageStats.extend<ClaudeSidecarsStats>("ClaudeSidecarsStats")({
    artifactsDiscovered: Schema.Number,
    artifactsWritten: Schema.Number,
    planSnapshotsWritten: Schema.Number,
    usageEdgesWritten: Schema.Number,
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
                summary: `ingested ${result.written} Claude sidecar artifacts, ${result.usageEdgesWritten} sidecar usage edges, and ${result.planSnapshotsWritten} sidecar plan snapshots`,
                artifactsDiscovered: result.discovered,
                artifactsWritten: result.written,
                planSnapshotsWritten: result.planSnapshotsWritten,
                usageEdgesWritten: result.usageEdgesWritten,
            });
        }),
};
