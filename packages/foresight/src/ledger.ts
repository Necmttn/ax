// Pure hit-rate ledger for predictive prefetch. Timestamps are injected so
// the module stays clock-free and fully unit-testable.

export type LedgerSnapshot = {
    fired: number;
    hits: number;
    errors: number;
    navigations: number;
    hitRate: number;
};

export type Ledger = {
    recordPrefetch(key: string, at: number): void;
    recordError(key: string, at: number): void;
    recordNavigate(key: string, at: number): void;
    snapshot(): LedgerSnapshot;
};

export function createLedger(windowMs = 5000): Ledger {
    const lastPrefetch = new Map<string, number>();
    let fired = 0;
    let hits = 0;
    let errors = 0;
    let navigations = 0;

    return {
        recordPrefetch(key, at) {
            fired++;
            lastPrefetch.set(key, at);
        },
        recordError(_key, _at) {
            errors++;
        },
        recordNavigate(key, at) {
            navigations++;
            const t = lastPrefetch.get(key);
            if (t !== undefined && at >= t && at - t <= windowMs) {
                hits++;
                lastPrefetch.delete(key);
            }
        },
        snapshot() {
            return {
                fired,
                hits,
                errors,
                navigations,
                hitRate: fired === 0 ? 0 : hits / fired,
            };
        },
    };
}

/** Module-level singleton used by initForesight + ForesightLink. */
export const ledger: Ledger = createLedger();
