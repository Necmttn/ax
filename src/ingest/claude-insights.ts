import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { decodeJsonOrNull } from "../lib/decode.ts";
import type { DbError } from "../lib/errors.ts";
import { AppLayer } from "../lib/layers.ts";
import { recordRef } from "./evidence-writers.ts";
import { surrealDate, surrealJsonTextOption, surrealObject, surrealOptionDate, surrealOptionRecord, surrealOptionString, surrealSet, surrealString } from "../lib/shared/surql.ts";
import { executeStatements } from "../lib/shared/statement-exec.ts";

type JsonRecord = Record<string, unknown>;

export interface ClaudeInsightRecordShape {
    readonly key: string;
    readonly sessionId: string | null;
    readonly subjectType: string;
    readonly subjectId: string | null;
    readonly kind: string;
    readonly text: string;
    readonly labels: JsonRecord;
    readonly metrics: JsonRecord;
    readonly createdAt: string | null;
}

export interface ClaudeFrictionEventShape {
    readonly key: string;
    readonly sessionId: string | null;
    readonly kind: string;
    readonly text: string | null;
    readonly labels: JsonRecord;
    readonly metrics: JsonRecord;
    readonly raw: JsonRecord;
    readonly ts: string | null;
}

export interface ClaudeInsightConversion {
    readonly insight: ClaudeInsightRecordShape;
    readonly frictionEvents: readonly ClaudeFrictionEventShape[];
}

export interface ClaudeInsightIngestStats {
    readonly facets: number;
    readonly sessionMeta: number;
    readonly malformed: number;
    readonly insights: number;
    readonly frictionEvents: number;
}

export interface ClaudeInsightReadStats {
    readonly facets: number;
    readonly sessionMeta: number;
    readonly malformed: number;
}

export interface ClaudeInsightReadItem {
    readonly sourcePath: string;
    readonly meta: JsonRecord | null;
    readonly conversion: ClaudeInsightConversion;
}

export interface ClaudeInsightReadResult {
    readonly stats: ClaudeInsightReadStats;
    readonly items: readonly ClaudeInsightReadItem[];
}

interface ClaudeInsightIngestOpts {
    readonly usageDir: string | undefined;
}

const passthroughFrictionKinds = new Set([
    "api_error",
    "blocking_bug",
    "buggy_code",
    "data_loss",
    "excessive_changes",
    "external_blocker",
    "environment_blocker",
    "ignored_memory_preference",
    "incomplete_fix",
    "incomplete_scaling",
    "insufficient_context",
    "missed_detail",
    "missed_stop_signal",
    "missing_capability",
    "misunderstood_request",
    "runtime_limit",
    "user_rejected_action",
    "workflow_replay_blocking",
    "wrong_approach",
]);

const numericMetaKeys = new Set([
    "assistant_message_count",
    "duration_minutes",
    "files_modified",
    "git_commits",
    "git_pushes",
    "input_tokens",
    "lines_added",
    "lines_removed",
    "output_tokens",
    "tool_errors",
    "user_interruptions",
    "user_message_count",
]);

const numericMetaMapKeys = new Set([
    "languages",
    "tool_counts",
    "tool_error_categories",
]);

function defaultUsageDir(): string {
    return (
        process.env.AGENTCTL_CLAUDE_USAGE_DIR ??
        join(homedir(), ".claude", "usage-data")
    );
}

function isRecord(input: unknown): input is JsonRecord {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}

function nonEmptyString(input: unknown): string | null {
    if (typeof input !== "string") return null;
    const trimmed = input.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function objectField(input: JsonRecord, field: string): JsonRecord | null {
    const value = input[field];
    return isRecord(value) ? value : null;
}

function finiteNumber(input: unknown): number | null {
    if (typeof input !== "number" || !Number.isFinite(input)) return null;
    return input;
}

function numericMap(input: unknown): JsonRecord | null {
    if (!isRecord(input)) return null;

    const out: JsonRecord = {};
    for (const [key, value] of Object.entries(input)) {
        const numberValue = finiteNumber(value);
        if (numberValue !== null) out[key] = numberValue;
    }

    return Object.keys(out).length > 0 ? out : null;
}

function frictionCounts(input: unknown): Record<string, number> {
    if (!isRecord(input)) return {};

    const out: Record<string, number> = {};
    for (const [rawKey, rawValue] of Object.entries(input)) {
        const key = rawKey.trim();
        const count = finiteNumber(rawValue);
        if (key.length === 0 || count === null || count <= 0) continue;
        out[key] = Math.trunc(count);
    }

    return out;
}

function addDefined(target: JsonRecord, key: string, value: unknown): void {
    if (value === null || value === undefined) return;
    target[key] = value;
}

function normalizeRawKind(rawKind: string): string {
    return rawKind
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
}

export function normalizeFrictionKind(rawKind: string): string {
    const kind = normalizeRawKind(rawKind);
    if (passthroughFrictionKinds.has(kind)) return kind;

    if (kind.includes("token") && kind.includes("limit")) return "runtime_limit";
    if (kind.includes("context") && kind.includes("limit")) return "runtime_limit";
    if (kind.includes("environment")) return "environment_blocker";
    if (
        kind.startsWith("tool_") ||
        kind.includes("tooling") ||
        kind.includes("_tool_")
    ) {
        return "tool_error";
    }
    if (
        kind.includes("external") ||
        kind.includes("blocker") ||
        kind.includes("blocked")
    ) {
        return "external_blocker";
    }

    return "unknown";
}

function sourceKeyPart(sourcePath: string): string {
    const fileName = basename(sourcePath, ".json");
    const clean = normalizeRawKind(fileName);
    if (clean.length > 0) return clean;
    return `source_${Bun.hash(sourcePath).toString(16).padStart(16, "0")}`;
}

function sessionIdentity(
    sourcePath: string,
    facet: JsonRecord,
    meta: JsonRecord | null,
): string | null {
    return (
        nonEmptyString(facet.session_id) ??
        nonEmptyString(meta?.session_id) ??
        sourceKeyPart(sourcePath)
    );
}

function insightText(sourcePath: string, facet: JsonRecord, sessionId: string | null): string {
    return (
        nonEmptyString(facet.brief_summary) ??
        nonEmptyString(facet.underlying_goal) ??
        (sessionId
            ? `Claude insights import for session ${sessionId}`
            : `Claude insights import from ${basename(sourcePath)}`)
    );
}

function metaMetrics(meta: JsonRecord | null): JsonRecord {
    if (meta === null) return {};

    const metrics: JsonRecord = {};
    for (const [key, value] of Object.entries(meta)) {
        if (numericMetaKeys.has(key)) {
            const numberValue = finiteNumber(value);
            if (numberValue !== null) metrics[key] = numberValue;
        } else if (numericMetaMapKeys.has(key)) {
            const mapValue = numericMap(value);
            if (mapValue !== null) metrics[key] = mapValue;
        }
    }

    return metrics;
}

function insightLabels(input: {
    readonly sourcePath: string;
    readonly sessionId: string | null;
    readonly facet: JsonRecord;
    readonly meta: JsonRecord | null;
}): JsonRecord {
    const labels: JsonRecord = {
        source: "claude_insights",
        source_path: input.sourcePath,
    };

    addDefined(labels, "session_id", input.sessionId);
    addDefined(labels, "outcome", nonEmptyString(input.facet.outcome));
    addDefined(labels, "goal_categories", objectField(input.facet, "goal_categories"));
    addDefined(labels, "session_type", nonEmptyString(input.facet.session_type));
    addDefined(labels, "helpfulness", nonEmptyString(input.facet.claude_helpfulness));
    addDefined(
        labels,
        "user_satisfaction_counts",
        objectField(input.facet, "user_satisfaction_counts"),
    );
    addDefined(labels, "primary_success", nonEmptyString(input.facet.primary_success));
    addDefined(labels, "project_path", nonEmptyString(input.meta?.project_path));

    return labels;
}

function metaStartTime(meta: JsonRecord | null): string | null {
    const raw = nonEmptyString(meta?.start_time);
    if (!raw) return null;

    const date = new Date(raw);
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

export function facetToInsightAndFriction(input: {
    readonly sourcePath: string;
    readonly facet: unknown;
    readonly meta?: unknown;
}): ClaudeInsightConversion {
    const facet = isRecord(input.facet) ? input.facet : {};
    const meta = isRecord(input.meta) ? input.meta : null;
    const sessionId = sessionIdentity(input.sourcePath, facet, meta);
    const keyPrefix = sessionId ?? sourceKeyPart(input.sourcePath);
    const counts = frictionCounts(facet.friction_counts);
    const labels = insightLabels({
        sourcePath: input.sourcePath,
        sessionId,
        facet,
        meta,
    });
    const metrics: JsonRecord = {
        friction_counts: counts,
        ...metaMetrics(meta),
    };
    const createdAt = metaStartTime(meta);
    const frictionDetail = nonEmptyString(facet.friction_detail);

    const frictionEvents: ClaudeFrictionEventShape[] = [];
    for (const [rawKind, count] of Object.entries(counts)) {
        const normalizedKind = normalizeFrictionKind(rawKind);
        for (let ordinal = 1; ordinal <= count; ordinal += 1) {
            frictionEvents.push({
                key: `${keyPrefix}__claude_insights__${normalizedKind}__${rawKind}__${ordinal}`,
                sessionId,
                kind: normalizedKind,
                text: frictionDetail,
                labels: {
                    source: "claude_insights",
                    source_path: input.sourcePath,
                    session_id: sessionId,
                    raw_kind: rawKind,
                    normalized_kind: normalizedKind,
                },
                metrics: {
                    raw_count: count,
                    ordinal,
                    ...metaMetrics(meta),
                },
                raw: {
                    source: "claude_insights",
                    source_path: input.sourcePath,
                    raw_kind: rawKind,
                    normalized_kind: normalizedKind,
                    ordinal,
                    count,
                    friction_counts: counts,
                },
                ts: createdAt,
            });
        }
    }

    return {
        insight: {
            key: `${keyPrefix}__claude_insights`,
            sessionId,
            subjectType: sessionId ? "session" : "claude_usage_file",
            subjectId: sessionId ?? input.sourcePath,
            kind: "claude_insights",
            text: insightText(input.sourcePath, facet, sessionId),
            labels,
            metrics,
            createdAt,
        },
        frictionEvents,
    };
}


function sessionEndTime(meta: JsonRecord | null): string | null {
    const startedAt = metaStartTime(meta);
    const duration = finiteNumber(meta?.duration_minutes);
    if (startedAt === null || duration === null) return null;

    return new Date(new Date(startedAt).getTime() + duration * 60_000).toISOString();
}

function sessionPlaceholderStatement(
    sessionId: string,
    meta: JsonRecord | null,
): string {
    const projectPath = nonEmptyString(meta?.project_path);
    const projectName = projectPath ? basename(projectPath) : null;
    const startedAt = metaStartTime(meta);
    const endedAt = sessionEndTime(meta);
    const fields: Array<readonly [string, string]> = [["source", surrealString("claude")]];

    if (projectName) fields.push(["project", surrealOptionString(projectName)]);
    if (projectPath) fields.push(["cwd", surrealOptionString(projectPath)]);
    if (startedAt) fields.push(["started_at", surrealOptionDate(startedAt)]);
    if (endedAt) fields.push(["ended_at", surrealOptionDate(endedAt)]);

    return `UPSERT ${recordRef("session", sessionId)} MERGE ${surrealObject(fields)};`;
}

export function buildClaudeInsightStatements(
    conversion: ClaudeInsightConversion,
    meta?: unknown,
): string[] {
    const statements: string[] = [];
    const metaRecord = isRecord(meta) ? meta : null;
    const insight = conversion.insight;
    const insightRef = recordRef("insight", insight.key);

    if (insight.sessionId) {
        statements.push(sessionPlaceholderStatement(insight.sessionId, metaRecord));
    }

    const insightFields: Array<readonly [string, string]> = [
        ["subject_type", surrealString(insight.subjectType)],
        ["subject_id", surrealOptionString(insight.subjectId)],
        ["kind", surrealOptionString(insight.kind)],
        ["text", surrealString(insight.text)],
        ["labels", surrealJsonTextOption(insight.labels)],
        ["metrics", surrealJsonTextOption(insight.metrics)],
    ];
    if (insight.createdAt) {
        insightFields.push(["created_at", surrealDate(insight.createdAt)]);
    }

    statements.push(
        `UPSERT ${insightRef} MERGE ${surrealObject(insightFields)};`,
    );

    if (insight.sessionId) {
        const sessionRef = recordRef("session", insight.sessionId);
        statements.push(
            `DELETE concerns WHERE in = ${insightRef} AND out = ${sessionRef} AND kind = "session_classification";`,
            `RELATE ${insightRef}->concerns->${sessionRef} SET ${surrealSet([
                ["kind", surrealString("session_classification")],
                ["reason", surrealOptionString("Claude /insights classified this session")],
                ["labels", surrealJsonTextOption({ source: "claude_insights" })],
                ["metrics", surrealJsonTextOption(insight.metrics)],
                ["ts", insight.createdAt ? surrealDate(insight.createdAt) : "time::now()"],
            ])};`,
        );
    }

    for (const event of conversion.frictionEvents) {
        const fields: Array<readonly [string, string]> = [
            ["session", surrealOptionRecord("session", event.sessionId)],
            ["turn", "NONE"],
            ["kind", surrealString(event.kind)],
            ["text", surrealOptionString(event.text)],
            ["labels", surrealJsonTextOption(event.labels)],
            ["metrics", surrealJsonTextOption(event.metrics)],
            ["raw", surrealJsonTextOption(event.raw)],
            ["ts", event.ts ? surrealDate(event.ts) : "time::now()"],
        ];

        statements.push(
            `UPSERT ${recordRef("friction_event", event.key)} MERGE ${surrealObject(fields)};`,
        );
    }

    return statements;
}

async function jsonFiles(dir: string): Promise<string[]> {
    try {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries
            .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
            .map((entry) => join(dir, entry.name))
            .sort((a, b) => a.localeCompare(b));
    } catch {
        return [];
    }
}

async function readJsonRecord(
    filePath: string,
): Promise<{ record: JsonRecord | null; malformed: boolean }> {
    let text: string;
    try {
        text = await readFile(filePath, "utf8");
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[claude-insights] skipping unreadable JSON ${filePath}: ${message}`);
        return { record: null, malformed: true };
    }
    const parsed = decodeJsonOrNull(text);
    if (parsed === null) {
        console.warn(`[claude-insights] skipping malformed JSON ${filePath}`);
        return { record: null, malformed: true };
    }
    if (!isRecord(parsed)) {
        console.warn(`[claude-insights] skipping non-object JSON ${filePath}`);
        return { record: null, malformed: true };
    }
    return { record: parsed, malformed: false };
}

function sessionIdForFile(filePath: string, record: JsonRecord): string {
    return nonEmptyString(record.session_id) ?? basename(filePath, ".json");
}

const queryStatements = (
    statements: readonly string[],
): Effect.Effect<void, DbError, SurrealClient> =>
    executeStatements(statements);

const writeClaudeInsightConversion = (
    conversion: ClaudeInsightConversion,
    meta: JsonRecord | null,
): Effect.Effect<void, DbError, SurrealClient> =>
    queryStatements(buildClaudeInsightStatements(conversion, meta));

export async function readClaudeInsightConversions(
    usageDir: string = defaultUsageDir(),
): Promise<ClaudeInsightReadResult> {
    const facetsDir = join(usageDir, "facets");
    const sessionMetaDir = join(usageDir, "session-meta");
    const [facetFiles, metaFiles] = await Promise.all([
        jsonFiles(facetsDir),
        jsonFiles(sessionMetaDir),
    ]);

    let malformed = 0;
    const metaBySessionId = new Map<string, JsonRecord>();
    let sessionMeta = 0;
    for (const metaPath of metaFiles) {
        const parsed = await readJsonRecord(metaPath);
        if (parsed.malformed) {
            malformed += 1;
            continue;
        }
        if (!parsed.record) continue;
        sessionMeta += 1;
        metaBySessionId.set(sessionIdForFile(metaPath, parsed.record), parsed.record);
        metaBySessionId.set(basename(metaPath, ".json"), parsed.record);
    }

    let facets = 0;
    const items: ClaudeInsightReadItem[] = [];
    for (const facetPath of facetFiles) {
        const parsed = await readJsonRecord(facetPath);
        if (parsed.malformed) {
            malformed += 1;
            continue;
        }
        if (!parsed.record) continue;

        facets += 1;
        const sessionId = sessionIdForFile(facetPath, parsed.record);
        const meta = metaBySessionId.get(sessionId) ?? null;
        const conversion = facetToInsightAndFriction({
            sourcePath: facetPath,
            facet: parsed.record,
            meta,
        });
        items.push({ sourcePath: facetPath, meta, conversion });
    }

    return {
        stats: { facets, sessionMeta, malformed },
        items,
    };
}

export const ingestClaudeInsights = (
    opts: Partial<ClaudeInsightIngestOpts> = {},
): Effect.Effect<ClaudeInsightIngestStats, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const loaded = yield* Effect.promise(() =>
            readClaudeInsightConversions(opts.usageDir ?? defaultUsageDir()),
        );
        let insights = 0;
        let frictionEvents = 0;

        for (const item of loaded.items) {
            yield* writeClaudeInsightConversion(item.conversion, item.meta);
            insights += 1;
            frictionEvents += item.conversion.frictionEvents.length;
        }

        yield* Effect.logDebug("claude insights ingested", {
            facets: loaded.stats.facets,
            sessionMeta: loaded.stats.sessionMeta,
            insights,
            frictionEvents,
            malformed: loaded.stats.malformed,
        });

        return {
            facets: loaded.stats.facets,
            sessionMeta: loaded.stats.sessionMeta,
            malformed: loaded.stats.malformed,
            insights,
            frictionEvents,
        };
    });

if (import.meta.main) {
    await Effect.runPromise(
        ingestClaudeInsights().pipe(
            Effect.provide(AppLayer),
            Effect.scoped,
        ) as Effect.Effect<ClaudeInsightIngestStats>,
    );
}
