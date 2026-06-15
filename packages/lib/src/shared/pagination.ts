/**
 * Shared offset/limit clamp for dashboard list endpoints.
 *
 * Consolidates the near-identical helpers that previously lived in
 * `src/dashboard/recall.ts`, `src/dashboard/sessions-list.ts`, and the
 * inline `Math.max/Math.min/Math.trunc` chain in
 * `src/dashboard/session-inspect.ts`. The HTTP layer and tests share the
 * exact same rule by reaching for `clampPagination` with a per-endpoint
 * `{ defaultLimit, maxLimit }` config.
 *
 * Rules:
 *  - `undefined` / NaN / Infinity / non-positive limit → `defaultLimit`
 *  - limit > `maxLimit` → `maxLimit`
 *  - fractional limit → truncated toward zero
 *  - `undefined` / NaN / negative offset → 0
 *  - fractional offset → truncated toward zero
 */

export interface PaginationConfig {
    readonly defaultLimit: number;
    readonly maxLimit: number;
}

export interface PaginationParams {
    readonly offset?: number | undefined;
    readonly limit?: number | undefined;
}

export interface ClampedPagination {
    readonly offset: number;
    readonly limit: number;
}

export const clampOffset = (value: number | undefined): number => {
    const n = Math.trunc(value ?? 0);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n;
};

export const clampLimit = (
    value: number | undefined,
    config: PaginationConfig,
): number => {
    const n = Math.trunc(value ?? config.defaultLimit);
    if (!Number.isFinite(n) || n <= 0) return config.defaultLimit;
    return Math.min(config.maxLimit, n);
};

export const clampPagination = (
    params: PaginationParams,
    config: PaginationConfig,
): ClampedPagination => ({
    offset: clampOffset(params.offset),
    limit: clampLimit(params.limit, config),
});

// ---------------------------------------------------------------------------
// clampInt - general-purpose integer clamper (clampLimit minus the optional-max)
// ---------------------------------------------------------------------------

/**
 * Config for clampInt.
 *
 * - `default`: returned when the value is absent, non-finite, or below `min`.
 * - `min`:     inclusive lower bound; values below it return `default` (optional - no lower check when absent).
 * - `max`:     inclusive upper cap (optional - no cap when absent).
 */
export interface ClampIntConfig {
    readonly default: number;
    readonly min?: number;
    readonly max?: number;
}

/**
 * General-purpose integer clamp.
 *
 * Truncates toward zero (like clampLimit/clampOffset), substitutes `default`
 * for undefined, non-finite, or below-minimum values, and optionally caps at
 * `max`. Drop-in generalisation of clampLimit for non-pagination uses (day
 * windows, custom floors/ceilings).
 *
 * Rules:
 *  - `undefined` → `config.default`
 *  - NaN / ±Infinity → `config.default`
 *  - fractional → truncated toward zero, then tested
 *  - value < `config.min` → `config.default` (only when `min` is given)
 *  - value > `config.max` → `config.max` (only when `max` is given)
 *  - else → truncated value
 */
export const clampInt = (value: number | undefined, config: ClampIntConfig): number => {
    const n = Math.trunc(value ?? config.default);
    if (!Number.isFinite(n)) return config.default;
    if (config.min !== undefined && n < config.min) return config.default;
    if (config.max !== undefined) return Math.min(config.max, n);
    return n;
};
