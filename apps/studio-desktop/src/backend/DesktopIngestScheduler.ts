/**
 * DesktopIngestScheduler - keeps the graph fresh while the desktop app is open.
 *
 * The desktop app supervises `surreal` + `ax serve` (see {@link AxBackendManager})
 * but, unlike the CLI's launchd watcher, nothing was triggering ingest. Under the
 * IDE daemon model (no background agent - see
 * docs/superpowers/specs/2026-06-16-smappservice-background-helper-design.md) the
 * app owns catch-up: once `ax serve` is ready it fires an ingest run and then
 * repeats on an interval, reusing the daemon's own live-ingest pipeline via
 * `POST /api/ingest`. The ingest-lock on the serve side makes overlapping runs a
 * no-op, so a missed tick is harmless.
 */
import * as Cause from "effect/Cause";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import { AX_SERVE_PORT } from "./AxDaemonArbitration.ts";

const { logError } = makeComponentLogger("desktop-ingest-scheduler");

/** Local serve live-ingest endpoint the scheduler POSTs to. */
const ingestUrl = new URL(`http://127.0.0.1:${AX_SERVE_PORT}/api/ingest`);

/**
 * Fire a single ingest run against the local `ax serve` daemon. Mirrors
 * `ax ingest --since=<sinceDays>` by posting the live-ingest trigger payload
 * (`{ since }`, see the `ingestTrigger` endpoint in `@ax/lib` api-contract).
 */
export const triggerIngest = (sinceDays: number) =>
    Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const request = HttpClientRequest.post(ingestUrl).pipe(
            HttpClientRequest.bodyJsonUnsafe({ since: sinceDays }),
        );
        yield* client.execute(request);
    });

/** Tuning for {@link run}. */
export interface IngestSchedulerConfig {
    /** `--since=<sinceDays>` window passed to each ingest run. */
    readonly sinceDays: number;
    /** Gap between ingest runs while the app stays open. */
    readonly interval: Duration.Duration;
}

/**
 * Run ingest while the app is open: an immediate first run, then one every
 * `config.interval`. Never settles - the caller forks it into a scope so it is
 * interrupted on shutdown.
 */
export const run = (config: IngestSchedulerConfig) =>
    triggerIngest(config.sinceDays).pipe(
        // A failed run (serve briefly unreachable, transient ingest error) must
        // not kill the loop - log and swallow so the next tick still fires.
        Effect.catchCause((cause) =>
            logError("ingest run failed", { cause: Cause.pretty(cause) }),
        ),
        Effect.repeat(Schedule.spaced(config.interval)),
        Effect.asVoid,
    );
