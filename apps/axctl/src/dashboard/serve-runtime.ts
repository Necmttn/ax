/**
 * Server-scoped Effect runtime for the studio server (Insights Surface).
 *
 * One `ManagedRuntime` serves every route handler, so `CacheRead`'s
 * published-snapshot connection (and the trace sink) is built once per
 * server lifetime instead of once per HTTP request.
 *
 * Studio ephemeral (wave 3, `c-daemon-studio`) dropped what this runtime used
 * to ALSO host: `IngestRuntimeLayer` merged with a live `SurrealClientLive`
 * connection, because this same runtime forked the detached ingest daemon
 * fiber the in-browser "trigger ingest" button started (`ingest-workflow.ts`,
 * now deleted). An on-demand process that exits when its client disconnects
 * cannot own that fiber's lifecycle, so the trigger was retired - studio now
 * only ever READS the published snapshot, and background freshness is a
 * separate concern (chunk 3a's freshness drive spawns `ax ingest`
 * independently of any studio invocation). No `SurrealClient` merge remains
 * anywhere in this runtime.
 *
 * Self-healing: v4 `ManagedRuntime` caches its layer-build fiber forever -
 * including a FAILED build (e.g. no snapshot published yet when the server
 * boots). A naive shared runtime would stay bricked until restart, where the
 * old per-request runner healed as soon as a snapshot appeared.
 * `makeServeRuntime` restores that behavior: when a run rejects while
 * `cachedContext` is still undefined (the build never succeeded), the failed
 * runtime is disposed and a fresh one is swapped in for the next request. A
 * rejection AFTER a successful build is a handler error and never triggers a
 * swap.
 */
import { Effect, Layer, ManagedRuntime } from "effect";
import { AppLayer } from "@ax/lib/layers";
import { CacheReadLive } from "../duckdb-embed-wiring.ts";
import { JudgmentLive } from "../judgment.ts";
import type { DashboardEnv, EffectRunner } from "./router/router.ts";

/**
 * The slice of `ManagedRuntime` the handle needs. Kept structural so tests
 * can inject a fake factory and exercise the healing logic without building
 * real layers (the interface is the test surface).
 */
export interface RuntimeLike {
    /** Defined once the layer build has SUCCEEDED; undefined before/after. */
    readonly cachedContext: unknown;
    readonly runPromise: <A>(effect: Effect.Effect<A, unknown, DashboardEnv>) => Promise<A>;
    readonly dispose: () => Promise<void>;
}

export type WarmupResult = { readonly ok: true } | { readonly ok: false; readonly error: unknown };

export interface ServeRuntimeHandle {
    /** The production `EffectRunner` passed into `dispatch`. */
    readonly runner: EffectRunner;
    /**
     * Force the full layer build (DB connection, stage registry, trace sink)
     * before the server accepts requests. A failure is non-fatal: the handle
     * already swapped in a fresh runtime, so the first request retries.
     */
    readonly warmup: () => Promise<WarmupResult>;
    readonly dispose: () => Promise<void>;
}

/**
 * Production runtime factory. Pass a `memoMap` to share layer builds with
 * other consumers of the same layer objects - `serveDashboard` shares one
 * memoMap between this runtime and the contract web handler
 * (contract/web-handler.ts) so AppLayer's SurrealDB connection is built once.
 */
export const defaultRuntimeFactory = (
    options?: { readonly memoMap?: Layer.MemoMap },
): (() => RuntimeLike) =>
() => ManagedRuntime.make(
    Layer.mergeAll(
        CacheReadLive,
        JudgmentLive,
        AppLayer,
    ),
    options?.memoMap ? { memoMap: options.memoMap } : undefined,
);

export function makeServeRuntime(make: () => RuntimeLike = defaultRuntimeFactory()): ServeRuntimeHandle {
    let runtime = make();
    let disposed = false;

    const runner: EffectRunner = async <A>(
        effect: Effect.Effect<A, unknown, DashboardEnv>,
    ): Promise<A> => {
        const current = runtime;
        try {
            return await current.runPromise(effect.pipe(Effect.scoped));
        } catch (err) {
            // Build-failure heal: `cachedContext` stays undefined until the
            // layer build succeeds, so this branch can only fire when the
            // build itself failed - a handler error on a healthy runtime
            // leaves the context cached and is rethrown untouched. The
            // `runtime === current` guard makes concurrent failers swap once.
            if (!disposed && current.cachedContext === undefined && runtime === current) {
                runtime = make();
                void current.dispose().catch(() => undefined);
            }
            throw err;
        }
    };

    return {
        runner,
        warmup: () =>
            runner(Effect.void).then(
                (): WarmupResult => ({ ok: true }),
                (error: unknown): WarmupResult => ({ ok: false, error }),
            ),
        dispose: () => {
            disposed = true;
            return runtime.dispose();
        },
    };
}
