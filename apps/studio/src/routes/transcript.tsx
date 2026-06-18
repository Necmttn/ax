import { useMemo, type ReactNode } from "react";
import type { InspectSpanKind, SessionInspectPayload } from "@ax/lib/shared/dashboard-types";
import { spliceHookFires, type RenderItem } from "@ax/lib/shared/hook-fire-splice";
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
    /** Optional mounted turn window. `data.turns` stays the full session for
     *  cost progress, totals, and inspector state while this list controls the
     *  expensive transcript DOM. */
    readonly renderedTurns?: SessionInspectPayload["turns"];
    /** Hook fires paired with `renderedTurns`; omitted means render all hooks
     *  in `data.hook_fires`. */
    readonly renderedHookFires?: SessionInspectPayload["hook_fires"];
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
    /** Leading content inside the transcript list, before mounted turns. Used
     *  by the share route for virtual scroll spacers. */
    readonly renderBeforeTurns?: () => ReactNode;
    /**
     * Share route: extra markers rendered *after* each `<Turn>` as siblings
     * (harness-hook markers + in-bundle ShareSpawnMarkers).
     */
    readonly renderAfterTurn?: (turnSeq: number) => ReactNode;
    /** Trailing content after the turn list (live route's pagination sentinel). */
    readonly renderAfterTurns?: () => ReactNode;
}

export interface TranscriptRenderModel {
    readonly items: ReadonlyArray<RenderItem>;
    readonly resultByCall: Map<string, string>;
    readonly skillContentByCall: Map<string, string>;
    readonly consumedResultSeqs: Set<number>;
    readonly imagePathsByTurn: Map<number, string[]>;
    readonly consumedImageSeqs: Set<number>;
}

export function buildTranscriptRenderModel(data: Pick<SessionInspectPayload, "turns" | "hook_fires">): TranscriptRenderModel {
    const toolPairing = pairToolResults(data.turns);
    const imagePairing = pairImageAttachments(data.turns);
    return {
        items: spliceHookFires(data.turns, data.hook_fires),
        resultByCall: toolPairing.resultByCall,
        skillContentByCall: toolPairing.skillContentByCall,
        consumedResultSeqs: toolPairing.consumedResultSeqs,
        imagePathsByTurn: imagePairing.imagePathsByTurn,
        consumedImageSeqs: imagePairing.consumedSeqs,
    };
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
    renderBeforeTurns,
    renderAfterTurn,
    renderAfterTurns,
    renderedTurns,
    renderedHookFires,
}: TranscriptProps) {
    const turnsToRender = renderedTurns ?? data.turns;
    const hooksToRender = renderedHookFires ?? data.hook_fires;
    const renderModel = useMemo(
        () => buildTranscriptRenderModel({ turns: turnsToRender, hook_fires: hooksToRender }),
        [turnsToRender, hooksToRender],
    );
    return (
        <>
            {header}
            <FilterBar {...filterBar} />
            <InspectGuide data={data} />
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", padding: "4px var(--strip-x) 8px" }}>
                {(() => {
                    // Chips at ~0% are dead weight that dilutes the meaningful
                    // ones - collapse them into a single dim count.
                    const entries = (Object.keys(KIND_STYLE) as InspectSpanKind[]).map((kind) => {
                        const n = data.totals_by_kind[kind] ?? 0;
                        const share = data.total_chars > 0 ? (n / data.total_chars) * 100 : 0;
                        return { kind, share };
                    });
                    const visible = entries.filter((e) => e.share >= 0.05);
                    const hidden = entries.length - visible.length;
                    return (
                        <>
                            {visible.map(({ kind, share }) => {
                                const c = KIND_STYLE[kind];
                                const pct = share.toFixed(1);
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
                            {hidden > 0 ? (
                                <span style={{ alignSelf: "center", color: "var(--muted-2)", fontSize: 11 }}>
                                    +{hidden} at ~0%
                                </span>
                            ) : null}
                        </>
                    );
                })()}
            </div>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                    {renderBeforeTurns?.()}
                    {renderModel.items.map((item) => {
                        if (item.kind === "hook_fire") {
                            return <HookFireMarker key={`hook-${item.hook.idx}`} hook={item.hook} />;
                        }
                        const turn = item.turn;
                        // A result turn merged into a preceding call's card,
                        // or a pure-image-attachment turn folded into its
                        // referencing message, is not rendered standalone.
                        if (renderModel.consumedResultSeqs.has(turn.seq) || renderModel.consumedImageSeqs.has(turn.seq)) return null;
                        const after = renderAfterTurn?.(turn.seq);
                        return (
                            <div key={`turn-${turn.seq}`} data-turn-frame={turn.seq}>
                                <Turn
                                    turn={turn}
                                    anchored={anchoredSeq === turn.seq}
                                    childrenSpawnedHere={childrenSpawnedHereForTurn?.(turn.seq)}
                                    activeTarget={selection?.turnSeq === turn.seq ? selection.target : null}
                                    onInspect={setSelection}
                                    resultFor={(callIndex) => renderModel.resultByCall.get(callKey(turn.seq, callIndex))}
                                    skillContentFor={(callIndex) => renderModel.skillContentByCall.get(callKey(turn.seq, callIndex))}
                                    imagePaths={renderModel.imagePathsByTurn.get(turn.seq)}
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
