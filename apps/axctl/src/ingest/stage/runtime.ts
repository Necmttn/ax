import { Effect, Layer } from "effect";
import { AppLayer, appLayerWithTransport } from "@ax/lib/layers";
import { CacheRead, type CacheReadService } from "@ax/lib/duckdb/seam";
import type { TraceTransportTag } from "@ax/lib/live-traces/Sink";
import { StageRegistryDefault } from "./registry.ts";
import { AgentSourceRegistryLive } from "../../agents/registry.ts";

/** Stage-source registries some stages depend on (e.g. agentDefStage needs AgentSourceRegistry). */
const StageSourceLayers = AgentSourceRegistryLive;

/**
 * Production runtime layer for the Ingest Pipeline. Composes the library
 * `AppLayer` with the canonical `StageRegistryDefault`. CLI ingest entry
 * points should consume this; library code that does not need the stage
 * registry should keep consuming `AppLayer` directly.
 */
export const IngestRuntimeLayer = Layer.mergeAll(AppLayer, StageRegistryDefault, StageSourceLayers);

/**
 * Ingest runtime whose `TraceSink` flushes to `transport` (e.g. the progress
 * animation or `--debug` console). Needed because trace events are dropped
 * unless the transport is wired beneath the sink - see `appLayerWithTransport`.
 */
export const ingestRuntimeLayerWith = (transport: Layer.Layer<TraceTransportTag>) =>
    Layer.mergeAll(appLayerWithTransport(transport), StageRegistryDefault, StageSourceLayers);

/**
 * A `CacheRead` that PANICS on any access. Provided over every ingest run, on
 * both entry points.
 *
 * This is the F1/F2 guard, and it has to be a runtime panic rather than a
 * missing service because the two runtimes reach it differently. The CLI's
 * `runCli` is typed `SurrealClient | CacheRead` (the union across ALL commands),
 * so `CacheRead` must be satisfiable there; the daemon's `ManagedRuntime` builds
 * ONE layer for both HTTP handlers - which legitimately read the published
 * snapshot through `CacheRead` - and the ingest fibers `startIngestWorkflow`
 * forks onto it. Neither can simply omit the service.
 *
 * What it prevents: `withCacheWrite` publishes the snapshot only AFTER the run's
 * body succeeds, so a `CacheRead` resolved mid-ingest answers from the PREVIOUS
 * run and cannot see one row this run has written. `derive-metrics` computes
 * `session_metrics` from those rows, so the result is a wrong NUMBER, not an
 * error. A live reader inside ingest takes the lock-held `CacheWriteService` as
 * an argument instead.
 */
export const throwingCacheRead = (): CacheReadService =>
    new Proxy({} as CacheReadService, {
        get(_target, prop) {
            throw new Error(
                `axctl: CacheRead.${String(prop)} accessed inside the ingest runtime - an ingest-time `
                + "reader must take the lock-held CacheWriteService as an argument (F1/F2)",
            );
        },
    });

/**
 * Scope {@link throwingCacheRead} over one ingest program. Applied INSIDE the
 * runtime's own provide, so it shadows a `CacheRead` the surrounding runtime
 * supplies for its other consumers.
 */
export const withoutCacheRead = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, CacheRead>> =>
    Effect.provideService(effect, CacheRead, throwingCacheRead());
