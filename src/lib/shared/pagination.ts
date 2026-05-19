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
    readonly offset?: number;
    readonly limit?: number;
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
