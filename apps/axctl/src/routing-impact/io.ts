/**
 * State + DB IO for `ax routing impact`. State lives at
 * `~/.ax/routing-impact.json` and is read/written with Bun.file/Bun.write (no
 * node:fs, no Effect FS layer) so begin/end stay light. The windowed metrics
 * come from the same SurrealDB the rest of ax analytics use.
 */
import { Effect, Option } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { prettyPrint } from "@ax/lib/json";
import { decodeState, EMPTY_STATE, type RoutingImpactState } from "./state.ts";

export const defaultStatePath = (): string =>
    `${process.env.HOME ?? "."}/.ax/routing-impact.json`;

/** Load state; a missing/corrupt file resets to EMPTY_STATE (fail-open). */
export const loadState = async (path: string): Promise<RoutingImpactState> => {
    const file = Bun.file(path);
    if (!(await file.exists())) return EMPTY_STATE;
    try {
        const raw: unknown = JSON.parse(await file.text());
        const decoded = decodeState(raw);
        return Option.isSome(decoded) ? decoded.value : EMPTY_STATE;
    } catch {
        return EMPTY_STATE;
    }
};

export const saveState = async (path: string, state: RoutingImpactState): Promise<void> => {
    await Bun.write(path, `${prettyPrint(state)}\n`, { createPath: true });
};

// ---------------------------------------------------------------------------
// Windowed metrics (token-equiv cost + work-volume proxy)
// ---------------------------------------------------------------------------

export interface WindowMetrics {
    readonly tokenCostUsd: number;
    /** assistant turns in the window - the work-volume proxy. */
    readonly turns: number;
}

/**
 * Sum token-equivalent cost and count assistant turns in [startIso, endIso].
 * Datetime bindings are JS Date objects (SurrealDB SDK requirement). GROUP ALL
 * makes the aggregates return a single row.
 */
export const fetchWindowMetrics = (
    startIso: string,
    endIso: string,
): Effect.Effect<WindowMetrics, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const bindings = { start: new Date(startIso), end: new Date(endIso) };

        const [costRows] = yield* db.query<[ReadonlyArray<{ c: number | null }>]>(
            "SELECT math::sum(estimated_cost_usd) AS c FROM session_token_usage WHERE ts > $start AND ts <= $end GROUP ALL;",
            bindings,
        );
        const [turnRows] = yield* db.query<[ReadonlyArray<{ n: number | null }>]>(
            "SELECT count() AS n FROM turn WHERE role = 'assistant' AND ts > $start AND ts <= $end GROUP ALL;",
            bindings,
        );

        return {
            tokenCostUsd: Number(costRows?.[0]?.c ?? 0),
            turns: Number(turnRows?.[0]?.n ?? 0),
        };
    });
