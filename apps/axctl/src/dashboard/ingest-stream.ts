import type { IngestStreamEvent } from "../ingest/stream-events.ts";

/** The stream name for a run. Keep this the single source of truth. */
export const ingestStreamName = (runId: string): string => `ingest:${runId}`;

/**
 * Producer-side seam. The server-side ingest workflow publishes progress here;
 * the concrete backing (Durable Streams) is provided by `ingest-stream-durable.ts`.
 * Keeping this an interface lets the local Durable-Streams-in-Bun backing be
 * swapped for a hosted/Durable-Objects backend later without touching producers.
 */
export interface IngestStreamBus {
    publish(runId: string, event: IngestStreamEvent): Promise<void>;
}

/** Test/dev impl: keeps events in memory, no transport. */
export class InMemoryIngestStreamBus implements IngestStreamBus {
    private readonly streams = new Map<string, IngestStreamEvent[]>();
    async publish(runId: string, event: IngestStreamEvent): Promise<void> {
        const list = this.streams.get(runId) ?? [];
        list.push(event);
        this.streams.set(runId, list);
    }
    history(runId: string): readonly IngestStreamEvent[] {
        return this.streams.get(runId) ?? [];
    }
}
