/**
 * Splice hook_fire decision rows into a turn stream so the inspector can show
 * exactly where ax contributed PreToolUse context to the agent.
 *
 * Hook fires are positioned immediately BEFORE the nearest following turn
 * (the tool call the hook gated). Orphans at the end stay at the end; ones
 * before the first turn go at the start. Hook fires with no/invalid ts are
 * dropped (we can't position them deterministically).
 *
 * Pure function - inspector server slices hook_fires for the loaded turn
 * window's ts range and hands them in alongside the turns; the SPA renders
 * the merged list. Pagination accounting stays based on real turns only.
 *
 * Lives in `lib/shared` so the SPA and a node-side test can both import it
 * without a dependency on Effect / DB types.
 */

import type { HookFireDto, InspectTurnDto } from "./dashboard-types.ts";

export type RenderItem =
    | { readonly kind: "turn"; readonly turn: InspectTurnDto }
    | { readonly kind: "hook_fire"; readonly hook: HookFireDto };

const tsMs = (ts: string | null): number | null => {
    if (!ts) return null;
    const ms = new Date(ts).getTime();
    return Number.isFinite(ms) ? ms : null;
};

/** Merge turns + hook_fires into a single ordered render stream.
 *
 *  Algorithm: walk turns in order; before emitting each turn, flush any
 *  hook_fires whose ts is <= that turn's ts (the hook gated this call).
 *  Turns whose ts is null pass through in their original position - they
 *  don't gate hook splicing. Anything left after the last ts-bearing turn
 *  is appended as a tail (orphans). */
export function spliceHookFires(
    turns: ReadonlyArray<InspectTurnDto>,
    hookFires: ReadonlyArray<HookFireDto>,
): ReadonlyArray<RenderItem> {
    // Drop hook fires with no usable ts - we can't position them.
    const usableHooks = hookFires
        .filter((h) => tsMs(h.ts) != null)
        .slice()
        .sort((a, b) => tsMs(a.ts)! - tsMs(b.ts)!);

    const out: RenderItem[] = [];
    let hookIdx = 0;

    for (const t of turns) {
        const turnMs = tsMs(t.ts);
        if (turnMs != null) {
            while (hookIdx < usableHooks.length && tsMs(usableHooks[hookIdx]!.ts)! <= turnMs) {
                out.push({ kind: "hook_fire", hook: usableHooks[hookIdx]! });
                hookIdx += 1;
            }
        }
        out.push({ kind: "turn", turn: t });
    }

    for (; hookIdx < usableHooks.length; hookIdx++) {
        out.push({ kind: "hook_fire", hook: usableHooks[hookIdx]! });
    }
    return out;
}
