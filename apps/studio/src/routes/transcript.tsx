import type { ReactNode } from "react";
import type { InspectSpanKind, SessionInspectPayload } from "@ax/lib/shared/dashboard-types";
import { spliceHookFires } from "@ax/lib/shared/hook-fire-splice";
import { FilterBar, type FilterBarProps } from "./inspector-filter-bar.tsx";
import { pairImageAttachments } from "./image-pairing.ts";
import { callKey, pairToolResults } from "./tool-pairing.ts";
import {
    DockedRail,
    HookFireMarker,
    InspectGuide,
    KIND_STYLE,
    Turn,
    type InspectSelection,
    type SpawnChildDto,
} from "./session-inspect.tsx";

export interface TranscriptProps {
    /** The session payload to render (parent or subagent). */
    readonly data: SessionInspectPayload;
    /**
     * Chrome rendered above the FilterBar: the `{turns} turns · {chars} chars`
     * line plus any caller-specific bars (live shows project + spawn/parent
     * bars; share shows just the turns/chars/source line).
     */
    readonly header: ReactNode;
    /** Fully-assembled props for the shared FilterBar - the two callers wire
     *  their own anchor sets, hook-fire idx accessors, and loadMore. */
    readonly filterBar: FilterBarProps;
    /** Caller-owned deep-link cursor (drives the per-turn `anchored` highlight). */
    readonly anchoredSeq: number | null;
    /** Caller-owned docked-inspector selection + setter. */
    readonly selection: InspectSelection | null;
    readonly setSelection: (selection: InspectSelection | null) => void;
    /** Caller-owned "which turn is on screen" seq for the cost rail. */
    readonly visibleSeq: number | null;
    /**
     * Live route: child sessions spawned at a given turn, rendered *inside*
     * the `<Turn>` via its `childrenSpawnedHere` prop (DB-routed SpawnMarkers).
     */
    readonly childrenSpawnedHereForTurn?: (turnSeq: number) => ReadonlyArray<SpawnChildDto> | undefined;
    /**
     * Share route: extra markers rendered *after* each `<Turn>` as siblings
     * (harness-hook markers + in-bundle ShareSpawnMarkers).
     */
    readonly renderAfterTurn?: (turnSeq: number) => ReactNode;
    /** Trailing content after the turn list (live route's pagination sentinel). */
    readonly renderAfterTurns?: () => ReactNode;
}

/**
 * The shared transcript body for one session. Both the live session-inspect
 * route and the public gist-share route render through this so feature parity
 * can't drift: header line, filter bar, cost guide, the KIND_STYLE legend
 * strip, the spliced turn list, and the docked cost/inspector rail. The two
 * callers differ only in how spawn markers attach to turns (DB route vs
 * in-bundle file) and whether pagination exists - handled via the slot props.
 */
export function Transcript({
    data,
    header,
    filterBar,
    anchoredSeq,
    selection,
    setSelection,
    visibleSeq,
    childrenSpawnedHereForTurn,
    renderAfterTurn,
    renderAfterTurns,
}: TranscriptProps) {
    // Pair each tool_use turn's calls with the immediately-following
    // tool_result turn(s). Those result turns are merged INTO the call card
    // (so the consumed seqs are dropped from the standalone turn list below);
    // unmatched/orphan tool_result turns survive and render via ToolResultView.
    const { resultByCall, skillContentByCall, consumedResultSeqs } = pairToolResults(data.turns);
    // Fold "pure image attachment" turns (text is essentially just
    // `[Image: source: …]`) into the referencing message turn: the image
    // renders on the anchor, the standalone attachment turn collapses - exactly
    // like tool call→result above. A consumed seq from EITHER pass is dropped
    // from the standalone list, so the two consumed sets are unioned below.
    const { imagePathsByTurn, consumedSeqs: consumedImageSeqs } = pairImageAttachments(data.turns);
    return (
        <>
            {header}
            <FilterBar {...filterBar} />
            <InspectGuide data={data} />
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", padding: "4px 24px 8px" }}>
                {(Object.keys(KIND_STYLE) as InspectSpanKind[]).map((kind) => {
                    const c = KIND_STYLE[kind];
                    const n = data.totals_by_kind[kind] ?? 0;
                    const pct = data.total_chars > 0 ? ((n / data.total_chars) * 100).toFixed(1) : "0";
                    return (
                        <span
                            key={kind}
                            title={`${c.label}: ${pct}% of exported characters in this session view. This is not token share or billing share.`}
                            style={{ background: c.bg, color: c.fg, padding: "2px 10px", borderRadius: 4, fontSize: 11, fontWeight: 600, borderLeft: `3px solid ${c.bar}` }}
                        >
                            {c.label} <em style={{ fontStyle: "normal", opacity: 0.7, fontWeight: 400 }}>{pct}%</em>
                        </span>
                    );
                })}
            </div>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                    {spliceHookFires(data.turns, data.hook_fires).map((item) => {
                        if (item.kind === "hook_fire") {
                            return <HookFireMarker key={`hook-${item.hook.idx}`} hook={item.hook} />;
                        }
                        const turn = item.turn;
                        // A result turn merged into a preceding call's card,
                        // or a pure-image-attachment turn folded into its
                        // referencing message, is not rendered standalone.
                        if (consumedResultSeqs.has(turn.seq) || consumedImageSeqs.has(turn.seq)) return null;
                        const after = renderAfterTurn?.(turn.seq);
                        return (
                            <div key={`turn-${turn.seq}`}>
                                <Turn
                                    turn={turn}
                                    anchored={anchoredSeq === turn.seq}
                                    childrenSpawnedHere={childrenSpawnedHereForTurn?.(turn.seq)}
                                    activeTarget={selection?.turnSeq === turn.seq ? selection.target : null}
                                    onInspect={setSelection}
                                    resultFor={(callIndex) => resultByCall.get(callKey(turn.seq, callIndex))}
                                    skillContentFor={(callIndex) => skillContentByCall.get(callKey(turn.seq, callIndex))}
                                    imagePaths={imagePathsByTurn.get(turn.seq)}
                                />
                                {after}
                            </div>
                        );
                    })}
                    {renderAfterTurns?.()}
                </div>
                <DockedRail
                    data={data}
                    currentSeq={visibleSeq}
                    selection={selection}
                    setSelection={setSelection}
                />
            </div>
        </>
    );
}
