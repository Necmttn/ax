import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";

export interface SessionBaselines {
    readonly median_cost_usd: number | null;
    readonly median_friction: number | null;
    readonly median_time_to_land_ms: number | null;
    readonly burn_p90: number | null;
}

interface CostRow {
    readonly estimated_cost_usd: number | null;
}

interface FrictionRow {
    readonly friction: number | null;
}

interface TimeToLandRow {
    readonly time_to_land_ms: number | null;
}

interface BurnRow {
    readonly estimated_tokens: number | null;
    readonly turns: number | null;
}

const CACHE_TTL_MS = 5 * 60_000;

let cachedBaselines: { readonly value: SessionBaselines; readonly expiresAt: number } | null = null;

const finiteNumbers = (xs: ReadonlyArray<number | null | undefined>): number[] =>
    xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));

export const median = (xs: ReadonlyArray<number>): number | null => {
    if (xs.length === 0) return null;
    const sorted = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
        ? sorted[mid]!
        : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

export const p90 = (xs: ReadonlyArray<number>): number | null => {
    if (xs.length === 0) return null;
    const sorted = [...xs].sort((a, b) => a - b);
    const index = Math.ceil(sorted.length * 0.9) - 1;
    return sorted[Math.max(0, index)]!;
};

export const _resetBaselineCacheForTests = (): void => {
    cachedBaselines = null;
};

export const fetchSessionBaselines = (): Effect.Effect<SessionBaselines, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const now = Date.now();
        if (cachedBaselines && cachedBaselines.expiresAt > now) {
            return cachedBaselines.value;
        }

        const db = yield* SurrealClient;
        const [costRows, frictionRows, timeToLandRows, burnRows] = yield* db.query<[
            CostRow[],
            FrictionRow[],
            TimeToLandRow[],
            BurnRow[],
        ]>(`
            SELECT estimated_cost_usd
            FROM session_token_usage
            WHERE ts > time::now() - 30d
              AND estimated_cost_usd IS NOT NONE;
            SELECT (user_corrections + tool_errors) AS friction
            FROM session_health
            WHERE ts > time::now() - 30d;
            SELECT time_to_land_ms
            FROM session_metrics
            WHERE session.started_at > time::now() - 30d
              AND time_to_land_ms IS NOT NONE;
            SELECT estimated_tokens, turns
            FROM session_health
            WHERE ts > time::now() - 30d
              AND turns > 0;
        `);

        const burnRates = burnRows
            .map((row) => {
                const estimatedTokens = Number(row.estimated_tokens);
                const turns = Number(row.turns);
                return turns > 0 ? estimatedTokens / turns : Number.NaN;
            })
            .filter((x) => Number.isFinite(x));

        const value: SessionBaselines = {
            median_cost_usd: median(finiteNumbers(costRows.map((row) => row.estimated_cost_usd))),
            median_friction: median(finiteNumbers(frictionRows.map((row) => row.friction))),
            median_time_to_land_ms: median(finiteNumbers(timeToLandRows.map((row) => row.time_to_land_ms))),
            burn_p90: p90(burnRates),
        };
        cachedBaselines = { value, expiresAt: now + CACHE_TTL_MS };
        return value;
    });
