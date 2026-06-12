/**
 * Handler for the live group's JSON endpoint: POST /api/ingest triggers an
 * in-process ingest run streaming progress to the Durable Streams sidecar.
 * SSE /api/events and binary /api/image stay raw legacy routes permanently.
 *
 * The detached daemon fiber `startIngestWorkflow` forks runs inside the
 * contract web handler's server-lifetime scope, so it outlives the request
 * (and is interrupted when the handler is disposed at shutdown) - same
 * lifecycle the legacy row got from the server runtime.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { AxApi, IngestTriggerResult, ServiceUnavailableError } from "@ax/lib/shared/api-contract";
import { IngestRuntimeLayer } from "../../ingest/stage/runtime.ts";
import { ingestStreamName } from "../ingest-stream.ts";
import { startIngestWorkflow } from "../ingest-workflow.ts";
import { ContractServeInfo } from "./system.ts";

export const LiveGroupLive = HttpApiBuilder.group(AxApi, "live", (handlers) =>
    handlers
        .handle("ingestTrigger", ({ payload }) =>
            Effect.gen(function* () {
                const info = yield* ContractServeInfo;
                const stream = info.ingestStream;
                if (stream === null) {
                    // The sidecar failed to start (e.g. the compiled single-file
                    // binary, which can't load native lmdb). Legacy 503 parity.
                    return yield* new ServiceUnavailableError({
                        error: "live ingest unavailable: run ax from source (the compiled binary can't host the Durable Streams sidecar)",
                    });
                }
                const since = payload.since;
                const sinceDays = typeof since === "number" && Number.isInteger(since) && since > 0
                    ? since
                    : undefined;
                // `runIngest` reads `--since=N` from `args` (see ingest/run.ts), so
                // the server-triggered run is shaped exactly like the CLI's.
                const { runId } = yield* startIngestWorkflow(
                    {
                        command: "ingest",
                        args: sinceDays === undefined ? [] : [`--since=${sinceDays}`],
                        cwd: process.cwd(),
                    },
                    stream,
                    IngestRuntimeLayer,
                );
                return new IngestTriggerResult({
                    runId,
                    stream: stream.streamUrl(runId),
                    streamName: ingestStreamName(runId),
                    streamBaseUrl: stream.baseUrl,
                });
            })));
