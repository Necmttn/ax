import { DurableStream, DurableStreamError } from "@durable-streams/client";
import { DurableStreamTestServer } from "@durable-streams/server";
import type { IngestStreamEvent } from "../ingest/stream-events.ts";
import { ingestStreamName, type IngestStreamBus } from "./ingest-stream.ts";

export interface DurableIngestStream extends IngestStreamBus {
    /** Base URL of the running sidecar, e.g. "http://127.0.0.1:58200". */
    readonly baseUrl: string;
    /** Full stream URL the browser subscribes to: `${baseUrl}/${ingestStreamName(runId)}`. */
    streamUrl(runId: string): string;
    /** Stop the embedded Durable Streams sidecar server. */
    stop(): Promise<void>;
}

export interface DurableIngestStreamOptions {
    readonly host?: string; // default "127.0.0.1"
    readonly port?: number; // default 0 (auto-assign)
    readonly dataDir?: string; // omit => in-memory
}

/**
 * Start an embedded Durable Streams sidecar and return a bus that publishes
 * ingest progress to per-run streams.
 *
 * Decision (see `docs/superpowers/research/durable-streams-api.md`): the
 * `@durable-streams/server` package exposes no mountable handler, so we run
 * `DurableStreamTestServer` on its own localhost port (sidecar). The browser
 * dashboard subscribes to `streamUrl(runId)` directly (server sends permissive
 * CORS).
 */
export async function createDurableIngestStream(
    opts?: DurableIngestStreamOptions,
): Promise<DurableIngestStream> {
    const host = opts?.host ?? "127.0.0.1";
    const port = opts?.port ?? 0;
    const server = new DurableStreamTestServer({
        host,
        port,
        ...(opts?.dataDir !== undefined ? { dataDir: opts.dataDir } : {}),
    });
    const baseUrl = await server.start();

    const streamUrl = (runId: string): string => `${baseUrl}/${ingestStreamName(runId)}`;

    // Cache a Promise<DurableStream> per runId so concurrent first-publishes
    // share one create() (avoids CONFLICT_EXISTS races) and later publishes
    // reuse the same handle (no create-per-event).
    //
    // We recover from create() rejecting (the CONFLICT path below) but NOT from
    // a later append() throwing: a failed append leaves the handle cached and it
    // is reused for the rest of the run. That asymmetry is intentional - this is
    // a single short-lived localhost ingest run, so a failed run simply stops
    // publishing rather than trying to heal a dead handle mid-stream.
    const handles = new Map<string, Promise<DurableStream>>();

    const openHandle = (runId: string): Promise<DurableStream> => {
        const existing = handles.get(runId);
        if (existing !== undefined) return existing;
        const url = streamUrl(runId);
        const created = DurableStream.create({ url, contentType: "application/json" }).catch(
            (err: unknown) => {
                // uuid runIds make collisions rare, but if the stream already
                // exists (e.g. a resumed run), connect to it instead.
                if (err instanceof DurableStreamError && err.code === "CONFLICT_EXISTS") {
                    return DurableStream.connect({ url, contentType: "application/json" });
                }
                throw err;
            },
        );
        handles.set(runId, created);
        return created;
    };

    const publish = async (runId: string, event: IngestStreamEvent): Promise<void> => {
        const handle = await openHandle(runId);
        await handle.append(JSON.stringify(event));
        if (event.kind === "run_finished") {
            // EOF so dashboards stop tailing; evict so a future run with the
            // same id (shouldn't happen with uuids) re-creates cleanly.
            handles.delete(runId);
            await handle.close();
        }
    };

    const stop = async (): Promise<void> => {
        // Best-effort close any still-open handles before tearing down the server.
        const pending = [...handles.values()];
        handles.clear();
        await Promise.allSettled(
            pending.map((p) => p.then((h) => h.close()).catch(() => undefined)),
        );
        await server.stop();
    };

    return { baseUrl, streamUrl, publish, stop };
}
