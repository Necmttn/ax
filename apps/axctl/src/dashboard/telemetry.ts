import { surrealJson, surrealString } from "@ax/lib/shared/surql";

export type IngestEventLevel = "debug" | "info" | "warn" | "error";

export interface IngestEvent {
    readonly type: "ingest_event";
    readonly id: string;
    readonly runId: string;
    readonly source: string;
    readonly stage: string;
    readonly level: IngestEventLevel;
    readonly message: string;
    readonly counts: Record<string, number>;
    readonly ts: string;
}

const sqlIdPart = (value: string): string =>
    value.replace(/[^A-Za-z0-9_:-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 96) || "stage";

export function makeIngestEvent(input: Omit<IngestEvent, "type" | "id" | "ts"> & { readonly ts?: string }): IngestEvent {
    const ts = input.ts ?? new Date().toISOString();
    const id = Bun.hash(`${input.runId}|${input.source}|${input.stage}|${input.message}|${ts}`).toString(16).padStart(16, "0");
    return { type: "ingest_event", id, ts, ...input };
}

export function buildIngestRunStartStatement(input: {
    readonly runId: string;
    readonly command: string;
    readonly sinceDays?: number | null;
}): string {
    const since = input.sinceDays === null || input.sinceDays === undefined ? "NONE" : String(input.sinceDays);
    return `UPSERT ingest_run:\`${input.runId}\` MERGE { command: ${surrealString(input.command)}, status: "running", since_days: ${since}, started_at: time::now(), last_progress_at: time::now() };`;
}

/** Terminal `ingest_run` statuses: "ok" = clean finish, "error" = the run
 *  failed, "partial" = interrupted/timed out with progress saved (re-running
 *  `ax ingest` continues incrementally). "running" is never terminal - a row
 *  stuck there means the process died without finalizing (doctor warns). */
export type IngestRunFinishStatus = "ok" | "error" | "partial";

export function buildIngestRunFinishStatement(input: {
    readonly runId: string;
    readonly status: IngestRunFinishStatus;
    readonly metrics?: unknown;
}): string {
    return `UPDATE ingest_run:\`${input.runId}\` SET status = ${surrealString(input.status)}, ended_at = time::now(), metrics = ${surrealJson(input.metrics ?? {})} RETURN NONE;`;
}

/** Heartbeat on the parent run row: stage start/finish and long-running
 *  provider work loops bump
 *  `last_progress_at` so a genuinely-live "running" run is distinguishable
 *  from one stranded by a crash (doctor's stale-run check, issue #269). */
export function ingestRunHeartbeatStatement(runId: string): string {
    return `UPDATE ingest_run:\`${runId}\` SET last_progress_at = time::now() RETURN NONE;`;
}

export function buildIngestStageStartStatement(input: {
    readonly runId: string;
    readonly source: string;
    readonly stage: string;
}): string {
    const id = `${sqlIdPart(input.runId)}__${sqlIdPart(input.source)}__${sqlIdPart(input.stage)}`;
    return `UPSERT ingest_stage:\`${id}\` MERGE { run: ingest_run:\`${input.runId}\`, source: ${surrealString(input.source)}, stage: ${surrealString(input.stage)}, status: "running", started_at: time::now() }; ${ingestRunHeartbeatStatement(input.runId)}`;
}

export function buildIngestStageFinishStatement(input: {
    readonly runId: string;
    readonly source: string;
    readonly stage: string;
    readonly status: "ok" | "error";
    readonly counts?: Record<string, number>;
    readonly errorText?: string;
}): string {
    const id = `${sqlIdPart(input.runId)}__${sqlIdPart(input.source)}__${sqlIdPart(input.stage)}`;
    const errorText = input.errorText === undefined ? "NONE" : surrealString(input.errorText);
    return `UPDATE ingest_stage:\`${id}\` SET status = ${surrealString(input.status)}, ended_at = time::now(), counts = ${surrealJson(input.counts ?? {})}, error_text = ${errorText} RETURN NONE; ${ingestRunHeartbeatStatement(input.runId)}`;
}

export function buildIngestEventStatement(event: IngestEvent): string {
    return `UPSERT ingest_event:\`${event.id}\` CONTENT { run: ingest_run:\`${event.runId}\`, source: ${surrealString(event.source)}, stage: ${surrealString(event.stage)}, level: ${surrealString(event.level)}, message: ${surrealString(event.message)}, counts: ${surrealJson(event.counts)}, raw: ${surrealJson(event)}, ts: d${surrealString(event.ts)} };`;
}

export type IngestEventSubscriber = (event: IngestEvent) => void;

const subscribers = new Set<IngestEventSubscriber>();

export function addIngestEventSubscriber(subscriber: IngestEventSubscriber): void {
    subscribers.add(subscriber);
}

export function removeIngestEventSubscriber(subscriber: IngestEventSubscriber): void {
    subscribers.delete(subscriber);
}

export function publishIngestEvent(event: IngestEvent): void {
    for (const subscriber of subscribers) {
        subscriber(event);
    }
}
