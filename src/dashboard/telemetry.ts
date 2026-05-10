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

const sqlString = (value: string): string => JSON.stringify(value);
// Encodes a value as a SurrealDB string literal containing compact JSON.
// Single-quotes are used so inner double-quotes don't need escaping.
const sqlJsonOption = (value: unknown): string => {
    const json = JSON.stringify(value);
    // Escape single quotes inside the JSON (rare but possible in string values)
    return `'${json.replace(/'/g, "\\'")}'`;
};

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
    return `UPSERT ingest_run:\`${input.runId}\` MERGE { command: ${sqlString(input.command)}, status: "running", since_days: ${since}, started_at: time::now() };`;
}

export function buildIngestRunFinishStatement(input: {
    readonly runId: string;
    readonly status: "ok" | "error";
    readonly metrics?: unknown;
}): string {
    return `UPDATE ingest_run:\`${input.runId}\` SET status = ${sqlString(input.status)}, ended_at = time::now(), metrics = ${sqlJsonOption(input.metrics ?? {})} RETURN NONE;`;
}

export function buildIngestEventStatement(event: IngestEvent): string {
    return `UPSERT ingest_event:\`${event.id}\` CONTENT { run: ingest_run:\`${event.runId}\`, source: ${sqlString(event.source)}, stage: ${sqlString(event.stage)}, level: ${sqlString(event.level)}, message: ${sqlString(event.message)}, counts: ${sqlJsonOption(event.counts)}, raw: ${sqlJsonOption(event)}, ts: d${sqlString(event.ts)} };`;
}
