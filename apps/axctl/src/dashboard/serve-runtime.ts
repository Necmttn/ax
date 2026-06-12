/**
 * Server-scoped Effect runtime for the dashboard server (Insights Surface).
 *
 * One `ManagedRuntime` over `IngestRuntimeLayer` (a superset of `AppLayer`)
 * serves BOTH route handlers and the detached ingest daemon fibers that
 * `startIngestWorkflow` forks - so the SurrealDB connection, trace sink, and
 * stage registry are built once per server lifetime instead of once per
 * HTTP request (the old `appLayerRunner` paid a fresh WebSocket handshake +
 * signin on every request).
 *
 * Self-healing: v4 `ManagedRuntime` caches its layer-build fiber forever -
 * including a FAILED build (e.g. SurrealDB down when the server boots). A
 * naive shared runtime would stay bricked until restart, where the old
 * per-request runner healed as soon as the DB came up. `makeServeRuntime`
 * restores that behavior: when a run rejects while `cachedContext` is still
 * undefined (the build never succeeded), the failed runtime is disposed and a
 * fresh one is swapped in for the next request. A rejection AFTER a
 * successful build is a handler error and never triggers a swap.
 */
import { Effect, ManagedRuntime } from "effect";
import { IngestRuntimeLayer } from "../ingest/stage/runtime.ts";
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

const makeDefault = (): RuntimeLike => ManagedRuntime.make(IngestRuntimeLayer);

export function makeServeRuntime(make: () => RuntimeLike = makeDefault): ServeRuntimeHandle {
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
