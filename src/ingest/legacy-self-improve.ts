import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { decodeJsonOrNull } from "../lib/decode.ts";
import type { DbError } from "../lib/errors.ts";
import { AppLayer } from "../lib/layers.ts";
import { recordRef } from "./evidence-writers.ts";
import { surrealJsonOption, surrealObject, surrealOptionDate, surrealOptionString, surrealString } from "../lib/shared/surql.ts";
import { executeStatements } from "../lib/shared/statement-exec.ts";
import { nonEmptyString, safeKeyPart } from "../lib/shared/derive-keys.ts";

type JsonRecord = Record<string, unknown>;

export interface LegacySelfImproveEventShape {
    readonly id: string;
    readonly sessionId: string | null;
    readonly projectSlug: string | null;
    readonly turnIndex: number | null;
    readonly timestamp: string | null;
    readonly type: string;
    readonly snippet: string | null;
    readonly trigger: string | null;
    readonly clusterId: string | null;
    readonly raw: JsonRecord;
}

export interface LegacySelfImproveClusterShape {
    readonly id: string;
    readonly name: string;
    readonly count: number;
    readonly eventIds: readonly string[];
}

export interface LegacySelfImproveRunShape {
    readonly runId: string;
    readonly path: string;
    readonly events: readonly LegacySelfImproveEventShape[];
    readonly clusters: readonly LegacySelfImproveClusterShape[];
    readonly proposalPath: string | null;
    readonly proposalText: string | null;
    readonly spendSamples: readonly number[];
    readonly malformedEvents: number;
}

export interface LegacySelfImproveIngestStats {
    readonly runs: number;
    readonly events: number;
    readonly clusters: number;
    readonly artifacts: number;
    readonly insights: number;
    readonly frictionEvents: number;
    readonly malformedEvents: number;
}

interface LegacySelfImproveIngestOpts {
    readonly rootDir: string | undefined;
}

const sqlFloatOption = (value: number | null | undefined): string =>
    value === null || value === undefined || !Number.isFinite(value) ? "NONE" : String(value);

function defaultLegacySelfImproveDir(): string {
    return (
        process.env.AX_LEGACY_SELF_IMPROVE_DIR ??
        join(homedir(), ".dotfiles", "claude", ".claude", "self-improve")
    );
}

function isRecord(input: unknown): input is JsonRecord {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}

function finiteNumber(input: unknown): number | null {
    if (typeof input !== "number" || !Number.isFinite(input)) return null;
    return input;
}

function shortHash(value: string): string {
    return Bun.hash(value).toString(16).padStart(16, "0");
}

function artifactKey(runId: string, name: string): string {
    return `legacy_self_improve__${safeKeyPart(runId)}__${safeKeyPart(name)}__${shortHash(`${runId}:${name}`).slice(0, 12)}`;
}

function insightKey(runId: string, name: string): string {
    return `legacy_self_improve__${safeKeyPart(runId)}__${safeKeyPart(name)}__${shortHash(`${runId}:${name}`).slice(0, 12)}`;
}

function clusterInsightKey(runId: string, clusterId: string): string {
    return `legacy_self_improve__${safeKeyPart(runId)}__cluster__${safeKeyPart(clusterId).slice(0, 72)}__${shortHash(`${runId}:${clusterId}`).slice(0, 12)}`;
}

function runKey(runId: string): string {
    return `legacy_self_improve__${safeKeyPart(runId)}__${shortHash(runId).slice(0, 12)}`;
}

function normalizeKind(rawKind: string): string {
    const kind = rawKind
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");

    if (kind === "retry") return "tool_retry";
    if (kind === "repeated_edit") return "repeated_edit";
    if (kind === "user_correction") return "user_correction";
    if (kind === "duplicate_question") return "duplicate_question";
    if (kind === "plan_revision") return "plan_revision";
    return kind.length > 0 ? kind : "unknown";
}

function dateOrNull(value: string | null): string | null {
    if (value === null) return null;
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function parseEvent(input: unknown): LegacySelfImproveEventShape | null {
    if (!isRecord(input)) return null;
    const id = nonEmptyString(input.id);
    const type = nonEmptyString(input.type);
    if (id === null || type === null) return null;
    const turnIndexNumber = finiteNumber(input.turn_index);

    return {
        id,
        type,
        sessionId: nonEmptyString(input.session_id),
        projectSlug: nonEmptyString(input.project_slug),
        turnIndex: turnIndexNumber === null ? null : Math.trunc(turnIndexNumber),
        timestamp: dateOrNull(nonEmptyString(input.timestamp)),
        snippet: nonEmptyString(input.snippet),
        trigger: nonEmptyString(input.trigger),
        clusterId: nonEmptyString(input.cluster_id),
        raw: input,
    };
}

function parseClusters(input: unknown): LegacySelfImproveClusterShape[] {
    if (!isRecord(input)) return [];
    const clusters: LegacySelfImproveClusterShape[] = [];
    for (const [id, rawCluster] of Object.entries(input)) {
        if (!isRecord(rawCluster)) continue;
        const rawEventIds = Array.isArray(rawCluster.event_ids) ? rawCluster.event_ids : [];
        const eventIds = rawEventIds
            .filter((eventId): eventId is string => typeof eventId === "string" && eventId.length > 0);
        clusters.push({
            id,
            name: nonEmptyString(rawCluster.name) ?? id,
            count: Math.trunc(finiteNumber(rawCluster.count) ?? eventIds.length),
            eventIds,
        });
    }
    return clusters.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

function parseSpendSamples(text: string): number[] {
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => Number(line))
        .filter((value) => Number.isFinite(value));
}

function eventTypeCounts(events: readonly LegacySelfImproveEventShape[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const event of events) {
        counts[event.type] = (counts[event.type] ?? 0) + 1;
    }
    return counts;
}

function spendMetrics(samples: readonly number[]): JsonRecord {
    if (samples.length === 0) return { spend_count: 0 };
    const total = samples.reduce((sum, value) => sum + value, 0);
    const max = Math.max(...samples);
    return {
        spend_count: samples.length,
        spend_total: Number(total.toFixed(6)),
        spend_avg: Number((total / samples.length).toFixed(6)),
        spend_max: Number(max.toFixed(6)),
    };
}

function proposalExcerpt(text: string | null): string | null {
    if (text === null) return null;
    const compact = text.replace(/\s+/g, " ").trim();
    return compact.length > 240 ? `${compact.slice(0, 240)}...` : compact;
}

async function readTextIfExists(path: string): Promise<string | null> {
    try {
        return await readFile(path, "utf8");
    } catch {
        return null;
    }
}

async function runDirs(rootDir: string): Promise<string[]> {
    try {
        const entries = await readdir(join(rootDir, "runs"), { withFileTypes: true });
        return entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => join(rootDir, "runs", entry.name))
            .sort((a, b) => a.localeCompare(b));
    } catch {
        return [];
    }
}

export async function readLegacySelfImproveRuns(
    rootDir: string = defaultLegacySelfImproveDir(),
): Promise<LegacySelfImproveRunShape[]> {
    const dirs = await runDirs(rootDir);
    const runs: LegacySelfImproveRunShape[] = [];

    for (const runDir of dirs) {
        const runId = basename(runDir);
        const [eventsText, clustersText, proposalText, spendText] = await Promise.all([
            readTextIfExists(join(runDir, "events.jsonl")),
            readTextIfExists(join(runDir, "clusters.json")),
            readTextIfExists(join(runDir, "proposed-claudemd.md")),
            readTextIfExists(join(runDir, "_spend.log")),
        ]);

        const events: LegacySelfImproveEventShape[] = [];
        let malformedEvents = 0;
        for (const line of eventsText?.split(/\r?\n/) ?? []) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            const decoded = decodeJsonOrNull(trimmed);
            if (decoded === null) {
                malformedEvents += 1;
                continue;
            }
            const parsed = parseEvent(decoded);
            if (parsed) events.push(parsed);
            else malformedEvents += 1;
        }

        let clusters: LegacySelfImproveClusterShape[] = [];
        if (clustersText !== null) {
            const decoded = decodeJsonOrNull(clustersText);
            if (decoded !== null) clusters = parseClusters(decoded);
        }

        runs.push({
            runId,
            path: runDir,
            events,
            clusters,
            proposalPath: proposalText === null ? null : join(runDir, "proposed-claudemd.md"),
            proposalText,
            spendSamples: spendText === null ? [] : parseSpendSamples(spendText),
            malformedEvents,
        });
    }

    return runs;
}

function artifactStatement(input: {
    readonly key: string;
    readonly kind: string;
    readonly title: string;
    readonly path: string;
    readonly raw: unknown;
    readonly content: string;
}): string {
    return `UPSERT ${recordRef("artifact", input.key)} MERGE ${surrealObject([
        ["kind", surrealString(input.kind)],
        ["title", surrealOptionString(input.title)],
        ["uri", surrealOptionString(`file://${input.path}`)],
        ["path", surrealOptionString(input.path)],
        ["content_hash", surrealOptionString(shortHash(input.content))],
        ["raw", surrealJsonOption(input.raw)],
        ["updated_at", "time::now()"],
    ])};`;
}

function hasArtifactStatements(input: {
    readonly runRef: string;
    readonly runKey: string;
    readonly artifactKey: string;
    readonly kind: string;
}): string[] {
    const edgeKey = `${input.runKey}__${input.artifactKey}`;
    return [
        `DELETE ${recordRef("has_artifact", edgeKey)};`,
        `RELATE ${input.runRef}->has_artifact:\`${edgeKey}\`->${recordRef("artifact", input.artifactKey)} SET kind = ${surrealString(input.kind)}, labels = ${surrealJsonOption({ source: "legacy_self_improve" })}, ts = time::now();`,
    ];
}

function derivedFromStatements(input: {
    readonly subjectRef: string;
    readonly subjectKey: string;
    readonly artifactKey: string;
    readonly kind: string;
}): string[] {
    const edgeKey = `${input.subjectKey}__${input.artifactKey}`;
    return [
        `DELETE ${recordRef("derived_from", edgeKey)};`,
        `RELATE ${input.subjectRef}->derived_from:\`${edgeKey}\`->${recordRef("artifact", input.artifactKey)} SET kind = ${surrealString(input.kind)}, labels = ${surrealJsonOption({ source: "legacy_self_improve" })}, ts = time::now();`,
    ];
}

export function buildLegacySelfImproveStatements(
    run: LegacySelfImproveRunShape,
): { readonly statements: string[]; readonly stats: Omit<LegacySelfImproveIngestStats, "runs"> } {
    const statements: string[] = [];
    const key = runKey(run.runId);
    const runRef = recordRef("self_improve_run", key);
    const spend = spendMetrics(run.spendSamples);
    const spendTotal = typeof spend.spend_total === "number" ? spend.spend_total : null;

    statements.push(`UPSERT ${runRef} MERGE ${surrealObject([
        ["run_id", surrealString(run.runId)],
        ["path", surrealString(run.path)],
        ["event_count", run.events.length.toString(10)],
        ["cluster_count", run.clusters.length.toString(10)],
        ["proposal_path", surrealOptionString(run.proposalPath)],
        ["spend_total", sqlFloatOption(spendTotal)],
        ["labels", surrealJsonOption({ source: "legacy_self_improve", imported_as_evidence: true })],
        ["metrics", surrealJsonOption({
            ...spend,
            event_types: eventTypeCounts(run.events),
            malformed_events: run.malformedEvents,
        })],
        ["created_at", "time::now()"],
    ])};`);

    const artifacts: Array<{ key: string; kind: string }> = [];
    const eventsArtifactKey = artifactKey(run.runId, "events.jsonl");
    artifacts.push({ key: eventsArtifactKey, kind: "legacy_self_improve_events" });
    statements.push(artifactStatement({
        key: eventsArtifactKey,
        kind: "legacy_self_improve_events",
        title: `${run.runId} events.jsonl`,
        path: join(run.path, "events.jsonl"),
        content: JSON.stringify(run.events),
        raw: {
            event_count: run.events.length,
            malformed_events: run.malformedEvents,
            event_types: eventTypeCounts(run.events),
        },
    }));

    const clusterArtifactKey = artifactKey(run.runId, "clusters.json");
    artifacts.push({ key: clusterArtifactKey, kind: "legacy_self_improve_clusters" });
    statements.push(artifactStatement({
        key: clusterArtifactKey,
        kind: "legacy_self_improve_clusters",
        title: `${run.runId} clusters.json`,
        path: join(run.path, "clusters.json"),
        content: JSON.stringify(run.clusters),
        raw: { cluster_count: run.clusters.length, top_clusters: run.clusters.slice(0, 20) },
    }));

    if (run.proposalText !== null && run.proposalPath !== null) {
        const proposalArtifactKey = artifactKey(run.runId, "proposed-claudemd.md");
        artifacts.push({ key: proposalArtifactKey, kind: "legacy_self_improve_proposal" });
        statements.push(artifactStatement({
            key: proposalArtifactKey,
            kind: "legacy_self_improve_proposal",
            title: `${run.runId} proposed CLAUDE.md`,
            path: run.proposalPath,
            content: run.proposalText,
            raw: { excerpt: proposalExcerpt(run.proposalText) },
        }));
    }

    const spendArtifactKey = artifactKey(run.runId, "_spend.log");
    artifacts.push({ key: spendArtifactKey, kind: "legacy_self_improve_spend" });
    statements.push(artifactStatement({
        key: spendArtifactKey,
        kind: "legacy_self_improve_spend",
        title: `${run.runId} spend log`,
        path: join(run.path, "_spend.log"),
        content: JSON.stringify(run.spendSamples),
        raw: spend,
    }));

    for (const artifact of artifacts) {
        statements.push(...hasArtifactStatements({
            runRef,
            runKey: key,
            artifactKey: artifact.key,
            kind: artifact.kind,
        }));
    }

    for (const event of run.events) {
        const eventKey = `legacy_self_improve__${safeKeyPart(run.runId)}__event__${safeKeyPart(event.id)}`;
        const eventRef = recordRef("friction_event", eventKey);
        statements.push(`UPSERT ${eventRef} MERGE ${surrealObject([
            ["session", event.sessionId ? recordRef("session", event.sessionId) : "NONE"],
            ["turn", "NONE"],
            ["kind", surrealString(normalizeKind(event.type))],
            ["text", surrealOptionString(event.snippet)],
            ["labels", surrealJsonOption({
                source: "legacy_self_improve",
                run_id: run.runId,
                project_slug: event.projectSlug,
                raw_type: event.type,
                cluster_id: event.clusterId,
                trigger: event.trigger,
            })],
            ["metrics", surrealJsonOption({ turn_index: event.turnIndex })],
            ["raw", surrealJsonOption(event.raw)],
            ["ts", surrealOptionDate(event.timestamp) === "NONE" ? "time::now()" : surrealOptionDate(event.timestamp)],
        ])};`);
        statements.push(...derivedFromStatements({
            subjectRef: eventRef,
            subjectKey: eventKey,
            artifactKey: eventsArtifactKey,
            kind: "legacy_self_improve_event_source",
        }));
    }

    for (const cluster of run.clusters) {
        const key = clusterInsightKey(run.runId, cluster.id);
        const insightRef = recordRef("insight", key);
        statements.push(`UPSERT ${insightRef} MERGE ${surrealObject([
            ["subject_type", surrealString("self_improve_run")],
            ["subject_id", surrealOptionString(run.runId)],
            ["kind", surrealOptionString("legacy_self_improve_cluster")],
            ["text", surrealString(`${cluster.name} (${cluster.count} events)`)],
            ["labels", surrealJsonOption({ source: "legacy_self_improve", run_id: run.runId, cluster_id: cluster.id })],
            ["metrics", surrealJsonOption({ count: cluster.count, event_ids_preview: cluster.eventIds.slice(0, 25) })],
            ["created_at", "time::now()"],
        ])};`);
        statements.push(...derivedFromStatements({
            subjectRef: insightRef,
            subjectKey: key,
            artifactKey: clusterArtifactKey,
            kind: "legacy_self_improve_cluster_source",
        }));
    }

    if (run.proposalText !== null) {
        const key = insightKey(run.runId, "proposal");
        const insightRef = recordRef("insight", key);
        statements.push(`UPSERT ${insightRef} MERGE ${surrealObject([
            ["subject_type", surrealString("self_improve_run")],
            ["subject_id", surrealOptionString(run.runId)],
            ["kind", surrealOptionString("legacy_self_improve_proposal")],
            ["text", surrealString(proposalExcerpt(run.proposalText) ?? "Legacy self-improve proposed guidance")],
            ["labels", surrealJsonOption({ source: "legacy_self_improve", run_id: run.runId, imported_as_evidence: true })],
            ["metrics", surrealJsonOption({ bytes: run.proposalText.length })],
            ["created_at", "time::now()"],
        ])};`);
        statements.push(...derivedFromStatements({
            subjectRef: insightRef,
            subjectKey: key,
            artifactKey: artifactKey(run.runId, "proposed-claudemd.md"),
            kind: "legacy_self_improve_proposal_source",
        }));
    }

    if (run.spendSamples.length > 0) {
        const key = insightKey(run.runId, "spend");
        const insightRef = recordRef("insight", key);
        statements.push(`UPSERT ${insightRef} MERGE ${surrealObject([
            ["subject_type", surrealString("self_improve_run")],
            ["subject_id", surrealOptionString(run.runId)],
            ["kind", surrealOptionString("legacy_self_improve_spend")],
            ["text", surrealString(`Legacy self-improve spend samples: ${run.spendSamples.length}`)],
            ["labels", surrealJsonOption({ source: "legacy_self_improve", run_id: run.runId })],
            ["metrics", surrealJsonOption(spend)],
            ["created_at", "time::now()"],
        ])};`);
        statements.push(...derivedFromStatements({
            subjectRef: insightRef,
            subjectKey: key,
            artifactKey: spendArtifactKey,
            kind: "legacy_self_improve_spend_source",
        }));
    }

    return {
        statements,
        stats: {
            events: run.events.length,
            clusters: run.clusters.length,
            artifacts: artifacts.length,
            insights: run.clusters.length + (run.proposalText === null ? 0 : 1) + (run.spendSamples.length > 0 ? 1 : 0),
            frictionEvents: run.events.length,
            malformedEvents: run.malformedEvents,
        },
    };
}

const queryStatements = (
    statements: readonly string[],
): Effect.Effect<void, DbError, SurrealClient> =>
    executeStatements(statements);

export const ingestLegacySelfImprove = (
    opts: Partial<LegacySelfImproveIngestOpts> = {},
): Effect.Effect<LegacySelfImproveIngestStats, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const runs = yield* Effect.promise(() =>
            readLegacySelfImproveRuns(opts.rootDir ?? defaultLegacySelfImproveDir()),
        );
        const totals: {
            runs: number;
            events: number;
            clusters: number;
            artifacts: number;
            insights: number;
            frictionEvents: number;
            malformedEvents: number;
        } = {
            runs: runs.length,
            events: 0,
            clusters: 0,
            artifacts: 0,
            insights: 0,
            frictionEvents: 0,
            malformedEvents: 0,
        };

        yield* queryStatements([
            `DELETE insight WHERE kind CONTAINS "legacy_self_improve";`,
            `DELETE friction_event WHERE labels CONTAINS "legacy_self_improve";`,
            `DELETE self_improve_run WHERE labels CONTAINS "legacy_self_improve";`,
            `DELETE artifact WHERE kind CONTAINS "legacy_self_improve";`,
            `DELETE has_artifact WHERE kind CONTAINS "legacy_self_improve";`,
            `DELETE derived_from WHERE kind CONTAINS "legacy_self_improve";`,
        ]);

        for (const run of runs) {
            const built = buildLegacySelfImproveStatements(run);
            yield* queryStatements(built.statements);
            totals.events += built.stats.events;
            totals.clusters += built.stats.clusters;
            totals.artifacts += built.stats.artifacts;
            totals.insights += built.stats.insights;
            totals.frictionEvents += built.stats.frictionEvents;
            totals.malformedEvents += built.stats.malformedEvents;
        }

        yield* Effect.logDebug("legacy self-improve artifacts ingested", totals);
        return totals;
    });

if (import.meta.main) {
    await Effect.runPromise(
        ingestLegacySelfImprove().pipe(
            Effect.provide(AppLayer),
            Effect.scoped,
        ) as Effect.Effect<LegacySelfImproveIngestStats>,
    );
}
