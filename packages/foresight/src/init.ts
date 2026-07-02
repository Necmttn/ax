import { ForesightManager, type UpdateForsightManagerSettings } from "js.foresight";
import { ledger } from "./ledger.ts";

export type ForesightDevtoolsLoader = () => Promise<unknown> | unknown;

export type InitForesightOptions = {
    /** Wire the hit-rate ledger + window.__axForesight. Pass import.meta.env.DEV from the app. */
    dev?: boolean;
    /** Load the ForesightJS devtools overlay when paired with devtoolsLoader. */
    devtools?: boolean;
    /** App-owned dynamic import for the devtools overlay, so prod builds can DCE the chunk. */
    devtoolsLoader?: ForesightDevtoolsLoader;
    settings?: Partial<UpdateForsightManagerSettings>;
};

let initialized = false;

/**
 * Idempotent, browser-only ForesightJS boot. Returns true only when this
 * call performed the initialization. Safe to import server-side; safe to
 * call from prerender code paths (no-ops without a window).
 */
export function initForesight(opts: InitForesightOptions = {}): boolean {
    if (initialized || typeof window === "undefined") return false;
    initialized = true;

    ForesightManager.initialize(opts.settings);

    if (opts.dev) {
        ForesightManager.instance.addEventListener("callbackCompleted", (e) => {
            const key = e.state.name || "unnamed";
            if (e.status === "error") ledger.recordError(key, Date.now());
            else ledger.recordPrefetch(key, Date.now());
        });
        (window as Window & { __axForesight?: () => unknown }).__axForesight = () =>
            ledger.snapshot();
    }

    if (opts.devtools && opts.devtoolsLoader) {
        const loadDevtools = opts.devtoolsLoader;
        void Promise.resolve()
            .then(loadDevtools)
            .catch(() => {
                // devtools are best-effort; never break the app over them
            });
    }

    return true;
}
