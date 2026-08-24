/**
 * Best-effort OTLP relay (#1017). Called from the `otlpd` receiver AFTER a body
 * is spooled: it re-POSTs the same JSON body to the user's own collector.
 *
 * Contract, all load-bearing:
 *   - NEVER throws to the caller - the receiver must still return 2xx to the
 *     harness even when the upstream is down (an exporter that sees a 5xx
 *     retry-storms).
 *   - Bounded by a timeout so a hung upstream cannot pin the write chain.
 *   - `fetch` is injected so the relay is unit-testable without a network.
 *
 * ax forces `http/json`, so it relays JSON. A protobuf-only upstream rejects it;
 * that surfaces via `onError`, it is not fatal (documented caveat).
 */
import { signalOfPath, type OtelForwardConfig } from "./forward-config.ts";

export interface RelayDeps {
    readonly fetch: typeof fetch;
    readonly timeoutMs?: number;
    /** Observe a failed relay (upstream down, non-2xx, timeout). Never throws. */
    readonly onError?: (signal: string, error: unknown) => void;
    readonly onSuccess?: (signal: string) => void;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Relay one accepted OTLP request to its matching upstream target. Resolves
 * (never rejects) once the relay completes or is skipped.
 */
export const relayOtlp = async (
    config: OtelForwardConfig,
    pathname: string,
    body: string,
    deps: RelayDeps,
): Promise<void> => {
    if (!config.enabled) return;
    const signal = signalOfPath(pathname);
    if (!signal) return;
    const target = config.targets.find((t) => t.signal === signal);
    if (!target) return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
        const res = await deps.fetch(target.url, {
            method: "POST",
            headers: { "content-type": "application/json", ...target.headers },
            body,
            signal: controller.signal,
        });
        if (res.ok) deps.onSuccess?.(signal);
        else deps.onError?.(signal, new Error(`upstream responded ${res.status}`));
    } catch (error) {
        deps.onError?.(signal, error);
    } finally {
        clearTimeout(timer);
    }
};

/**
 * A once-per-signal stderr warner for the receiver: a down upstream must not
 * spam the otlpd log on every batch, so warn the FIRST failure per signal per
 * process, then stay quiet.
 */
export const makeRelayLogger = (): ((signal: string, error: unknown) => void) => {
    const warned = new Set<string>();
    return (signal, error) => {
        if (warned.has(signal)) return;
        warned.add(signal);
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`otlp-forward: relay of ${signal} failed (${message}); further ${signal} failures silenced this run`);
    };
};
