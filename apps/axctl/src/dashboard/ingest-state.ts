import type { Layer, ManagedRuntime } from "effect";
import type { IngestRuntimeLayer } from "../ingest/stage/runtime.ts";
import type { DurableIngestStream } from "./ingest-stream-durable.ts";

/**
 * Server-lifetime ingest state, set up once by `serveDashboard` at startup and
 * torn down on shutdown.
 *
 * `runtime` is a LONG-LIVED `ManagedRuntime` (not a throwaway per-request
 * `Effect.runPromise`): `startIngestWorkflow` forks the pipeline onto a
 * detached daemon fiber that MUST outlive the HTTP request that triggered it.
 * A fresh per-request runtime would tear down when the request resolves and
 * kill the daemon mid-run. `stream` is the Durable Streams sidecar the browser
 * subscribes to directly; it is `null` when the sidecar could not start (e.g.
 * the compiled `--compile` binary, which cannot load native lmdb) - the server
 * still boots and live ingest reports unavailable.
 */
export interface ServeIngestState {
    readonly stream: DurableIngestStream | null;
    readonly runtime: ManagedRuntime.ManagedRuntime<
        Layer.Success<typeof IngestRuntimeLayer>,
        Layer.Error<typeof IngestRuntimeLayer>
    >;
}

let state: ServeIngestState | null = null;

export const setServeIngestState = (next: ServeIngestState | null): void => {
    state = next;
};

export const getServeIngestState = (): ServeIngestState | null => state;
