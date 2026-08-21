/**
 * State + cache IO for `ax routing impact`. State lives at
 * `~/.ax/routing-impact.json` and is read/written with Bun.file/Bun.write (no
 * node:fs, no Effect FS layer) so begin/end stay light. The windowed metrics
 * come from the published DuckDB cache through the read seam.
 */
import { Effect, Option, Schema } from "effect";
import { NumberFromBigIntColumn } from "@ax/lib/duckdb/columns";
import { cacheFirst } from "@ax/lib/duckdb/query";
import type { CacheRead } from "@ax/lib/duckdb/seam";
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

const CostRow = Schema.Struct({ c: Schema.NullOr(Schema.Number) });
const TurnCountRow = Schema.Struct({ n: NumberFromBigIntColumn });

/**
 * Sum token-equivalent cost and count assistant turns in `(startIso, endIso]`.
 *
 * HALF-OPEN ON PURPOSE, and unchanged by the port: `ax routing impact` diffs an
 * OFF block against an ON block, so a row exactly on the shared boundary must
 * belong to precisely one of them. `>` on the low edge and `<=` on the high edge
 * is what makes two adjacent blocks partition the timeline.
 *
 * Both bounds bind as `Date`s - the client encodes them for the TIMESTAMP
 * comparison. No `GROUP ALL`: DuckDB's bare aggregates already return one row,
 * and `count(*)` returns a BIGINT, which is why the count decodes through the
 * bigint contract rather than as a plain number.
 */
export const fetchWindowMetrics = (
    startIso: string,
    endIso: string,
): Effect.Effect<WindowMetrics, never, CacheRead> =>
    Effect.gen(function* () {
        const window = [new Date(startIso), new Date(endIso)];

        const cost = yield* cacheFirst(
            CostRow,
            {
                sql: "SELECT sum(estimated_cost_usd) AS c FROM turn_token_usage WHERE ts > ? AND ts <= ?",
                params: window,
            },
            "routing impact cost",
        );
        const turns = yield* cacheFirst(
            TurnCountRow,
            {
                sql: "SELECT count(*) AS n FROM turn WHERE role = 'assistant' AND ts > ? AND ts <= ?",
                params: window,
            },
            "routing impact turns",
        );

        return { tokenCostUsd: cost?.c ?? 0, turns: turns?.n ?? 0 };
    });
