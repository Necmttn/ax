import { useEffect, useMemo, useRef, useState } from "react";
import type { InspectSpanKind, InspectTurnDto } from "@shared/dashboard-types.ts";
import {
    isCorrectionTurn,
    isRoleTurn,
    isSpawnAnchorTurn,
    matchesSearch,
    matchingSeqs,
    nextMatchAfter,
} from "./inspector-filters.ts";

export interface FilterBarProps {
    readonly turns: ReadonlyArray<InspectTurnDto>;
    readonly anchorSeqs: ReadonlySet<number>;
    readonly loadedCount: number;
    readonly totalCount: number;
    readonly appendLoading: boolean;
    readonly loadMore: (count?: number) => Promise<void>;
    /** Returns the latest `turns` array - bypasses prop staleness across an
     *  `await loadMore()` boundary so retry-after-load can see new entries. */
    readonly getTurns: () => ReadonlyArray<InspectTurnDto>;
    /** Same as above for the hash-derived cursor seq. */
    readonly getCurrentSeq: () => number | null;
    /** Idx values of hook_fires in the loaded window, ts-ordered. Used by the
     *  "next hook fire" jump button - hook_fires have their own DOM ids
     *  (#hook-N), separate from the turn seq nav. */
    readonly hookFireIdxs: ReadonlyArray<number>;
    /** Latest hook_fire idxs accessor - bypasses prop staleness across the
     *  `await loadMore()` boundary in the next-hook-fire handler. */
    readonly getHookFireIdxs: () => ReadonlyArray<number>;
    /** Total hook_fires across the whole session - used to label the button
     *  and decide whether to keep paginating when the loaded window is dry. */
    readonly totalHookFires: number;
}

type QuickFilter =
    | { key: "correction"; label: string; pred: (t: InspectTurnDto) => boolean }
    | { key: "spawn"; label: string; pred: (t: InspectTurnDto) => boolean }
    | { key: InspectSpanKind; label: string; pred: (t: InspectTurnDto) => boolean };

export function FilterBar({
    turns,
    anchorSeqs,
    loadedCount,
    totalCount,
    appendLoading,
    loadMore,
    getTurns,
    getCurrentSeq,
    hookFireIdxs,
    getHookFireIdxs,
    totalHookFires,
}: FilterBarProps) {
    const [searchInput, setSearchInput] = useState("");
    const [searchQuery, setSearchQuery] = useState("");

    // Guard against late jumpTo() calls after the route unmounts. Without
    // this, a pending `await loadMore()` could resolve after navigation and
    // mutate window.location.hash on the *next* route.
    const isMountedRef = useRef(true);
    useEffect(() => () => { isMountedRef.current = false; }, []);

    // Debounce free-text input → searchQuery (~250 ms).
    useEffect(() => {
        const handle = window.setTimeout(() => setSearchQuery(searchInput), 250);
        return () => window.clearTimeout(handle);
    }, [searchInput]);

    const quickFilters: ReadonlyArray<QuickFilter> = useMemo(() => [
        { key: "correction",     label: "next correction",  pred: isCorrectionTurn },
        { key: "spawn",          label: "next spawn",       pred: (t) => isSpawnAnchorTurn(t, anchorSeqs) },
        { key: "tool_use",       label: "next tool_use",    pred: (t) => isRoleTurn(t, "tool_use") },
        { key: "tool_result",    label: "next tool_result", pred: (t) => isRoleTurn(t, "tool_result") },
        { key: "hook_injection", label: "next hook ctx",    pred: (t) => isRoleTurn(t, "hook_injection") },
    ], [anchorSeqs]);

    // "next hook fire" jumps among the spliced hook_fire markers - those have
    // their own #hook-N DOM ids, separate from the turn seq nav. We do not
    // mutate window.location.hash (that would clobber the turn cursor), just
    // scrollIntoView. Click again to advance to the next.
    const hookCursorRef = useRef<number>(-1);
    const jumpNextHookFire = async () => {
        let idxs = getHookFireIdxs();
        if (idxs.length === 0) {
            if (totalHookFires === 0 || appendLoading) return;
            // Hook fires exist but none are in the loaded window - load all
            // remaining turns (the server slices hook_fires alongside) and
            // retry from the fresh idx list.
            await loadMore(totalCount - loadedCount);
            if (!isMountedRef.current) return;
            idxs = getHookFireIdxs();
            if (idxs.length === 0) return;
        }
        // idxs is ts-ordered. Advance to next, wrap when past the end.
        hookCursorRef.current = (hookCursorRef.current + 1) % idxs.length;
        const idx = idxs[hookCursorRef.current]!;
        const el = document.getElementById(`hook-${idx}`);
        if (el) el.scrollIntoView({ behavior: "auto", block: "center" });
    };

    // Precompute matching seqs per filter against the currently-loaded window.
    // If the filter yields nothing in the loaded window AND we haven't loaded
    // everything yet, the button stays enabled and clicking will trigger a
    // bigger page fetch (handled in handleJump).
    const matchesByKey = useMemo(() => {
        const m = new Map<string, ReadonlyArray<number>>();
        for (const f of quickFilters) m.set(f.key, matchingSeqs(turns, f.pred));
        return m;
    }, [turns, quickFilters]);

    const searchSeqs = useMemo<ReadonlyArray<number>>(() => {
        const q = searchQuery.trim();
        if (q.length === 0) return [];
        return matchingSeqs(turns, (t) => matchesSearch(t, q));
    }, [turns, searchQuery]);

    const fullyLoaded = loadedCount >= totalCount;

    const jumpTo = (seq: number) => {
        // Setting the hash triggers our hashchange listener, which updates
        // anchoredSeq → re-fires the scroll + auto-load useEffects. The
        // browser steals focus to the hash target on navigation, so preserve
        // the previously-focused element (typically the search input) so
        // repeated Enter / button-clicks keep working without re-focusing.
        const prevFocus = document.activeElement as HTMLElement | null;
        if (window.location.hash === `#turn-${seq}`) {
            const el = document.getElementById(`turn-${seq}`);
            if (el) el.scrollIntoView({ behavior: "auto", block: "start" });
        } else {
            window.location.hash = `#turn-${seq}`;
        }
        if (prevFocus && typeof prevFocus.focus === "function" && prevFocus !== document.body) {
            // Restore on the next frame, after the browser's hash-focus steal.
            window.requestAnimationFrame(() => prevFocus.focus({ preventScroll: true }));
        }
    };

    const handleJump = async (pred: (t: InspectTurnDto) => boolean) => {
        // Always recompute matches and cursor from refs - the closure may be
        // stale across rapid repeat clicks faster than React re-renders.
        const seqs = matchingSeqs(getTurns(), pred);
        const next = nextMatchAfter(seqs, getCurrentSeq());
        if (next != null) { jumpTo(next); return; }
        // No match in loaded window. If pagination still has pages, load
        // everything and retry once against the fresh data.
        if (fullyLoaded || appendLoading) return;
        await loadMore(totalCount - loadedCount);
        if (!isMountedRef.current) return;
        const fresh = matchingSeqs(getTurns(), pred);
        const retry = nextMatchAfter(fresh, getCurrentSeq());
        if (retry != null) jumpTo(retry);
    };

    const jumpSearch = () => {
        const q = searchInput.trim();
        if (q.length === 0) return;
        // Force immediate apply (skip debounce) on Enter so the visible hit
        // counter matches what the jump uses.
        setSearchQuery(searchInput);
        // Always read via refs so rapid repeat-Enter (faster than React's
        // re-render) sees the freshest cursor and turn list.
        const fresh = matchingSeqs(getTurns(), (t) => matchesSearch(t, q));
        const next = nextMatchAfter(fresh, getCurrentSeq());
        if (next != null) { jumpTo(next); return; }
        if (fullyLoaded || appendLoading) return;
        void loadMore(totalCount - loadedCount).then(() => {
            if (!isMountedRef.current) return;
            const after = matchingSeqs(getTurns(), (t) => matchesSearch(t, q));
            const retry = nextMatchAfter(after, getCurrentSeq());
            if (retry != null) jumpTo(retry);
        });
    };

    const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") {
            e.preventDefault();
            jumpSearch();
        }
    };

    const btnStyle = (enabled: boolean): React.CSSProperties => ({
        padding: "3px 10px",
        fontSize: 11,
        fontFamily: "ui-monospace, monospace",
        border: "1px solid #e2e8f0",
        background: enabled ? "#fff" : "#f1f5f9",
        color: enabled ? "#475569" : "#94a3b8",
        borderRadius: 4,
        cursor: enabled ? "pointer" : "not-allowed",
    });

    return (
        <div style={{
            display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center",
            padding: "6px 24px", borderTop: "1px solid #e2e8f0", background: "#f8fafc",
            fontFamily: "ui-monospace, monospace", fontSize: 11,
        }}>
            <span style={{ color: "#64748b", marginRight: 4 }}>jump:</span>
            {(() => {
                const hasLoaded = hookFireIdxs.length > 0;
                const canDiscoverMore = loadedCount < totalCount && totalHookFires > 0;
                const enabled = (hasLoaded || canDiscoverMore) && !appendLoading;
                const count = totalHookFires > 0 ? ` (${totalHookFires})` : "";
                const title = totalHookFires === 0
                    ? "no hook decisions logged for this session"
                    : hasLoaded
                        ? `${hookFireIdxs.length} loaded · ${totalHookFires} total`
                        : `${totalHookFires} hook fire${totalHookFires === 1 ? "" : "s"} - click to load more`;
                return (
                    <button
                        key="hook-fire"
                        onClick={() => { void jumpNextHookFire(); }}
                        disabled={!enabled}
                        title={title}
                        style={{ ...btnStyle(enabled), borderLeft: "3px solid #10b981" }}
                    >
                        next hook fire{count}
                    </button>
                );
            })()}
            {quickFilters.map((f) => {
                const seqs = matchesByKey.get(f.key) ?? [];
                // Button is "enabled" if matches exist in window OR pagination
                // can still discover more. We never permanently disable until
                // the full session is loaded and zero matches were found.
                const hasMatches = seqs.length > 0;
                const canDiscoverMore = !fullyLoaded;
                const enabled = (hasMatches || canDiscoverMore) && !appendLoading;
                const count = hasMatches ? ` (${seqs.length})` : "";
                const title = !hasMatches && fullyLoaded
                    ? "no matches in this session"
                    : !hasMatches
                        ? `no matches in loaded ${loadedCount.toLocaleString()} turns - click to load more`
                        : `${seqs.length} match${seqs.length === 1 ? "" : "es"} in loaded window`;
                return (
                    <button
                        key={f.key}
                        onClick={() => { void handleJump(f.pred); }}
                        disabled={!enabled}
                        title={title}
                        style={btnStyle(enabled)}
                    >
                        {f.label}{count}
                    </button>
                );
            })}
            <div style={{ display: "flex", gap: 4, marginLeft: 8, alignItems: "center", flex: "1 1 220px", minWidth: 180 }}>
                <input
                    type="search"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    onKeyDown={onSearchKeyDown}
                    placeholder="find in turns (Enter to jump)…"
                    style={{
                        flex: 1, padding: "3px 8px", fontSize: 11, fontFamily: "inherit",
                        border: "1px solid #e2e8f0", borderRadius: 4, background: "#fff",
                        color: "#1f2937", minWidth: 0,
                    }}
                />
                <button
                    type="button"
                    onClick={jumpSearch}
                    disabled={searchInput.trim().length === 0}
                    title="jump to next match (or press Enter)"
                    style={btnStyle(searchInput.trim().length > 0)}
                >
                    next
                </button>
                {searchQuery.trim().length > 0 ? (
                    <span style={{ color: searchSeqs.length > 0 ? "#475569" : "#ef4444" }}>
                        {searchSeqs.length > 0
                            ? `${searchSeqs.length} hit${searchSeqs.length === 1 ? "" : "s"}`
                            : (fullyLoaded ? "no hits" : "no hits in loaded window")}
                    </span>
                ) : null}
            </div>
        </div>
    );
}
