/**
 * Persisted state for `ax routing impact` (issue #575): the captured work blocks
 * the off-vs-on receipt is built from. Lives at `~/.ax/routing-impact.json`
 * (sibling of routing-table.json / quota-cache.json). Pure transitions here;
 * the CLT does the IO.
 */
import { Schema } from "effect";
import type { Arm, WindowEdge } from "./compute.ts";

export const WindowEdgeSchema = Schema.Struct({
    utilization: Schema.Number,
    resets_at: Schema.String,
});

/** One captured block. Open while `ended_at` is null (between begin and end). */
export const BlockSchema = Schema.Struct({
    arm: Schema.Literals(["off", "on"]),
    label: Schema.optional(Schema.String),
    started_at: Schema.String,
    ended_at: Schema.NullOr(Schema.String),
    five_hour_start: Schema.NullOr(WindowEdgeSchema),
    five_hour_end: Schema.NullOr(WindowEdgeSchema),
});
export type Block = typeof BlockSchema.Type;

export const RoutingImpactStateSchema = Schema.Struct({
    v: Schema.Literal(1),
    blocks: Schema.Array(BlockSchema),
});
export type RoutingImpactState = typeof RoutingImpactStateSchema.Type;

export const EMPTY_STATE: RoutingImpactState = { v: 1, blocks: [] };

export const decodeState = Schema.decodeUnknownOption(RoutingImpactStateSchema);

/** The currently-open block (begin without a matching end), or null. */
export const openBlock = (state: RoutingImpactState): Block | null =>
    state.blocks.find((b) => b.ended_at === null) ?? null;

export class RoutingImpactStateError extends Schema.TaggedErrorClass<RoutingImpactStateError>(
    "RoutingImpactStateError",
)("RoutingImpactStateError", {
    reason: Schema.String,
}) {}

/**
 * Pure: append a new open block. Fails if one is already open (you must `end`
 * the current block before starting another).
 */
export const beginBlock = (
    state: RoutingImpactState,
    args: { arm: Arm; label?: string | undefined; startedAt: string; fiveHour: WindowEdge | null },
): RoutingImpactState | RoutingImpactStateError => {
    const open = openBlock(state);
    if (open) {
        return new RoutingImpactStateError({
            reason: `a "${open.arm}" block opened at ${open.started_at} is still running - run \`ax routing impact end\` first`,
        });
    }
    const block: Block = {
        arm: args.arm,
        ...(args.label !== undefined ? { label: args.label } : {}),
        started_at: args.startedAt,
        ended_at: null,
        five_hour_start: args.fiveHour,
        five_hour_end: null,
    };
    return { v: 1, blocks: [...state.blocks, block] };
};

/** Pure: close the open block. Fails if none is open. */
export const endBlock = (
    state: RoutingImpactState,
    args: { endedAt: string; fiveHour: WindowEdge | null },
): RoutingImpactState | RoutingImpactStateError => {
    const open = openBlock(state);
    if (!open) {
        return new RoutingImpactStateError({
            reason: "no open block - run `ax routing impact begin --arm=off|on` first",
        });
    }
    const blocks = state.blocks.map((b) =>
        b === open ? { ...b, ended_at: args.endedAt, five_hour_end: args.fiveHour } : b,
    );
    return { v: 1, blocks };
};

/** Completed blocks only (both edges of the timestamp pair present). */
export const completedBlocks = (state: RoutingImpactState): ReadonlyArray<Block> =>
    state.blocks.filter((b): b is Block & { ended_at: string } => b.ended_at !== null);
