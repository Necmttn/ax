import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type {
    HookFireDto,
    InspectTurnContentDto,
    InspectSpanKind,
    InspectTurnDto,
    SessionInspectPayload,
    SessionTokenUsageDetail,
    ToolCallDto,
    TurnTokenUsageDetail,
} from "@ax/lib/shared/dashboard-types";
import { shortSessionId } from "@ax/lib/shared/session-id";
import type { SessionTimelinePayload } from "../api.ts";
import { compactTokens, useInspectSelection, useVisibleTurnSeq } from "./session-inspect.tsx";
import { SessionTimelineBody } from "./session-timeline.tsx";
import { Transcript } from "./transcript.tsx";

type ShareSchemaVersion = 1 | 2 | 3 | 4;

// A published gist's files are immutable for a viewing session, so cache them
// forever and never refetch on focus/remount - the 1.26MB session.json should
// be fetched + parsed once, then served from cache on every navigation.
const IMMUTABLE_SHARE_QUERY = { staleTime: Infinity, gcTime: Infinity } as const;

// Mount only this many turns initially, then grow on scroll. content-visibility
// virtualizes paint, but React still MOUNTS every turn + runs its per-turn
// dissection up front - on a 291-turn session that's the multi-second hang.
// Windowing the mount (like the live inspector's PAGE_SIZE) is the real fix.
const SHARE_PAGE_SIZE = 80;

interface ShareHarnessHookView {
    readonly idx: number;
    readonly ts: string;
    readonly event_name: string;
    readonly hook_name: string;
    readonly effect: string;
    readonly status: string;
    readonly command?: string;
    readonly detail?: string;
    readonly anchor_turn_seq: number | null;
}

interface ShareArtifact {
    readonly schema_version: ShareSchemaVersion;
    readonly exported_at: string;
    readonly ax_version?: string;
    readonly session: {
        readonly id: string;
        readonly source: string;
        readonly model?: string;
        readonly project?: string;
        readonly repository?: string;
        readonly started_at?: string;
        readonly ended_at?: string;
        readonly summary?: string;
    };
    readonly stats: {
        readonly turns: number;
        readonly tool_calls: number;
        readonly files_changed: number;
        readonly skills_used: number;
        readonly failures: number;
    };
    readonly token_usage?: SessionTokenUsageDetail | null;
    /** v4 additive: segmented highlight timeline precomputed at export time. */
    readonly session_timeline?: SessionTimelinePayload | null;
    readonly hook_fires?: ReadonlyArray<HookFireDto>;
    readonly harness_hooks?: ReadonlyArray<ShareHarnessHookView>;
    readonly turns?: ReadonlyArray<{
        readonly id: string;
        readonly seq: number;
        readonly ts?: string;
        readonly role: string;
        readonly message_kind?: string;
        readonly intent_kind?: string;
        readonly text: string;
        readonly content?: InspectTurnContentDto | null;
        readonly token_usage?: TurnTokenUsageDetail | null;
        readonly has_tool_use?: boolean;
        readonly has_error?: boolean;
        readonly tool_calls?: ReadonlyArray<ToolCallDto>;
    }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/** Raw content URL for any file within a gist (latest revision). */
export function gistRawUrl(owner: string, gistId: string, file: string): string {
    return `https://gist.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(gistId)}/raw/${encodeURIComponent(file)}`;
}

/** Legacy single-file share path (schema v1/v2). */
export function rawSessionFileUrl(owner: string, gistId: string): string {
    return gistRawUrl(owner, gistId, "ax-session.json");
}

const SUPPORTED_VERSIONS = new Set<number>([1, 2, 3, 4]);

function validateArtifact(value: unknown): ShareArtifact {
    if (
        !isRecord(value) ||
        typeof value.schema_version !== "number" ||
        !SUPPORTED_VERSIONS.has(value.schema_version) ||
        !isRecord(value.session) ||
        typeof value.session.id !== "string" ||
        !isRecord(value.stats) ||
        !Array.isArray(value.turns)
    ) {
        throw new Error("Invalid session share artifact");
    }
    return value as unknown as ShareArtifact;
}

export async function fetchShareArtifact(owner: string, gistId: string): Promise<ShareArtifact> {
    const artifactResponse = await fetch(rawSessionFileUrl(owner, gistId));
    if (!artifactResponse.ok) throw new Error("Could not fetch ax-session.json");

    return validateArtifact(await artifactResponse.json());
}

// --- v3 multi-file bundle --------------------------------------------------

export interface ShareSubagentCard {
    readonly id: string;
    readonly file: string;
    readonly parent_id: string | null;
    readonly depth: number;
    readonly spawn_turn_seq: number | null;
    readonly source: string;
    readonly model?: string;
    readonly started_at?: string;
    readonly ended_at?: string;
    readonly duration_ms: number | null;
    readonly stats: ShareArtifact["stats"];
    readonly cost_usd: number | null;
    readonly estimated_tokens: number | null;
    readonly task_label?: string;
    readonly had_error: boolean;
}

export interface ShareManifest {
    readonly schema_version: 3 | 4;
    readonly kind: "manifest";
    readonly exported_at: string;
    readonly ax_version?: string;
    readonly session: ShareArtifact["session"];
    readonly stats: ShareArtifact["stats"];
    readonly token_usage?: SessionTokenUsageDetail | null;
    readonly root_file: string;
    readonly totals: {
        readonly cost_usd: number | null;
        readonly duration_ms: number | null;
        readonly tool_calls: number;
        readonly turns: number;
        readonly subagents: number;
        readonly failures: number;
    };
    readonly subagents: ReadonlyArray<ShareSubagentCard>;
}

export function isShareManifest(value: unknown): value is ShareManifest {
    return (
        isRecord(value) &&
        value.kind === "manifest" &&
        (value.schema_version === 3 || value.schema_version === 4) &&
        isRecord(value.session) &&
        typeof value.session.id === "string" &&
        isRecord(value.totals) &&
        Array.isArray(value.subagents) &&
        typeof value.root_file === "string"
    );
}

/**
 * Fetch the bundle manifest (`index.json`). Returns null when the gist has no
 * manifest (a legacy v1/v2 single-file share) so the caller can fall back.
 */
export async function fetchShareManifest(owner: string, gistId: string): Promise<ShareManifest | null> {
    const response = await fetch(gistRawUrl(owner, gistId, "index.json"));
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("Could not fetch index.json");
    const json = await response.json();
    if (!isShareManifest(json)) return null;
    return json;
}

/** Fetch one named session file (root `session.json` or a `subagent-*.json`). */
export async function fetchShareFile(owner: string, gistId: string, file: string): Promise<ShareArtifact> {
    const response = await fetch(gistRawUrl(owner, gistId, file));
    if (!response.ok) throw new Error(`Could not fetch ${file}`);
    return validateArtifact(await response.json());
}

export function spanKindForShareTurn(turn: NonNullable<ShareArtifact["turns"]>[number]): InspectSpanKind {
    if (turn.has_error) return "tool_result";
    if (turn.intent_kind === "wrapper_instruction") return "wrapper_instruction";
    if (turn.intent_kind === "skill_context") return "skill_context";
    if (turn.intent_kind === "system_context") return "system_context";
    if (turn.intent_kind === "tool_result") return "tool_result";
    if (turn.intent_kind === "tool_call") return "tool_use";
    if (turn.intent_kind === "subagent_task") return "subagent_task";
    if (turn.intent_kind === "subagent_notification") return "subagent_notification";
    if (turn.intent_kind === "pasted_reference") return "pasted_reference";
    if (turn.message_kind === "tool_result") return "tool_result";
    if (turn.message_kind === "tool_call" || turn.has_tool_use) return "tool_use";
    if (turn.message_kind === "system_or_developer") return "system_context";
    if (turn.message_kind === "context") return "skill_context";
    if (turn.message_kind === "control") return "wrapper_instruction";
    if (turn.role === "assistant") return "assistant_text";
    return "user_input";
}

export function inspectPayloadFromShare(artifact: ShareArtifact, sourcePath: string): SessionInspectPayload {
    const totals: Partial<Record<InspectSpanKind, number>> = {};
    let totalChars = 0;
    const turns = (artifact.turns ?? []).map((turn): InspectTurnDto => {
        const kind = spanKindForShareTurn(turn);
        totals[kind] = (totals[kind] ?? 0) + turn.text.length;
        totalChars += turn.text.length;
        return {
            seq: turn.seq,
            role: turn.role,
            semantic_role: kind,
            ts: turn.ts ?? null,
            char_count: turn.text.length,
            raw_text: turn.text,
            spans: [{ kind, text: turn.text, label: turn.intent_kind ?? turn.message_kind }],
            token_usage: turn.token_usage ?? null,
            content: turn.content ?? null,
            ...(turn.tool_calls && turn.tool_calls.length > 0 ? { tool_calls: turn.tool_calls } : {}),
        };
    });

    return {
        session_id: artifact.session.id,
        source_path: sourcePath,
        project: null,
        cwd: null,
        total_chars: totalChars,
        totals_by_kind: totals,
        token_usage: artifact.token_usage ?? null,
        total_turns: turns.length,
        turn_window: { offset: 0, limit: turns.length },
        turns,
        parent_session: null,
        parent_nickname: null,
        children: [],
        hook_fires: artifact.hook_fires ?? [],
        total_hook_fires: artifact.hook_fires?.length ?? 0,
    };
}

function hashSeq(): number | null {
    if (typeof window === "undefined") return null;
    const match = window.location.hash.match(/^#turn-(\d+)$/);
    return match ? Number(match[1]) : null;
}

export function ShareInspectRoute() {
    const { owner, gistId } = useParams({ from: "/share/$owner/$gistId" });
    return <ShareInspectView owner={owner} gistId={gistId} />;
}

function fmtUsd(value: number | null | undefined): string | null {
    if (value == null || !Number.isFinite(value)) return null;
    return value >= 0.01 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;
}

function fmtDuration(ms: number | null | undefined): string | null {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ""}`;
    const h = Math.floor(m / 60);
    return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

// --- F2 session map (manifest-only) -----------------------------------------

export type SessionMapAxis = "seq" | "time" | "order";

export interface SessionMapLane {
    readonly file: string;
    readonly id: string;
    readonly row: number;
    /** Left edge as a 0..1 fraction of the strip. */
    readonly x: number;
    /** Width as a 0..1 fraction of the strip (minimum applied). */
    readonly w: number;
    /** 0..1 cost relative to the max subagent cost; null = flat neutral (no
     *  card in the share has a positive cost, so intensity carries no signal). */
    readonly intensity: number | null;
    readonly failed: boolean;
    readonly failures: number;
    readonly label: string;
    readonly title: string;
}

export interface SessionMapModel {
    /** One axis semantic per share - never mixed per card. */
    readonly axis: SessionMapAxis;
    readonly rows: number;
    readonly rootDurationMs: number | null;
    readonly lanes: ReadonlyArray<SessionMapLane>;
}

export const SESSION_MAP_MIN_LANE_W = 0.012;
const SESSION_MAP_MAX_ROWS = 4;
/** Bars whose left edges sit closer than this (strip fraction) to an earlier
 *  bar's right edge pack onto the next row instead of overlapping. */
const SESSION_MAP_PACK_GAP = 0.002;

const parseShareTs = (iso: string | null | undefined): number | null => {
    const t = Date.parse(iso ?? "");
    return Number.isFinite(t) ? t : null;
};

/**
 * Pure shaper for the share-page session map: manifest in, positioned lanes
 * out. Axis is chosen once per share - spawn seq when every card has one AND
 * every card is a direct child of the root (`spawn_turn_seq` is parent-local,
 * so a nested card's seq has no meaning on the root's turn axis), else start
 * time over the root window, else stable manifest order.
 */
export function buildSessionMapLanes(manifest: ShareManifest): SessionMapModel | null {
    const cards = manifest.subagents;
    if (cards.length === 0) return null;

    const t0 = parseShareTs(manifest.session.started_at);
    const tEnd = parseShareTs(manifest.session.ended_at);
    const totalsDuration =
        manifest.totals.duration_ms != null && manifest.totals.duration_ms > 0 ? manifest.totals.duration_ms : null;
    const t1 = tEnd ?? (t0 != null && totalsDuration != null ? t0 + totalsDuration : null);
    const windowMs = t0 != null && t1 != null && t1 > t0 ? t1 - t0 : null;
    const rootDurationMs = windowMs ?? totalsDuration;

    const seqValues = cards
        .map((c) => c.spawn_turn_seq)
        .filter((s): s is number => typeof s === "number" && Number.isFinite(s));
    const allSeq = seqValues.length === cards.length && cards.every((c) => c.depth === 1);
    const axis: SessionMapAxis = allSeq ? "seq" : windowMs != null ? "time" : "order";
    const minSeq = allSeq ? Math.min(...seqValues) : 0;
    const seqRange = allSeq ? Math.max(...seqValues) - minSeq : 0;

    const maxChildDuration = Math.max(0, ...cards.map((c) => c.duration_ms ?? 0));
    // No known root duration: scale so the longest child fills a quarter strip.
    const widthDenom = rootDurationMs ?? (maxChildDuration > 0 ? maxChildDuration * 4 : null);

    const maxCost = Math.max(0, ...cards.map((c) => (c.cost_usd != null && c.cost_usd > 0 ? c.cost_usd : 0)));

    const placed = cards.map((card, i) => {
        let x = 0;
        if (axis === "seq") {
            x = seqRange > 0 ? ((card.spawn_turn_seq ?? minSeq) - minSeq) / seqRange : 0;
        } else if (axis === "time") {
            const ts = parseShareTs(card.started_at);
            x = ts != null && t0 != null && windowMs != null ? Math.min(1, Math.max(0, (ts - t0) / windowMs)) : 0;
        } else {
            x = i / cards.length;
        }
        const d = card.duration_ms != null && card.duration_ms > 0 ? card.duration_ms : null;
        const w = Math.min(1, Math.max(SESSION_MAP_MIN_LANE_W, d != null && widthDenom != null ? d / widthDenom : 0));
        const failures = card.stats.failures;
        return {
            card,
            order: i,
            x: Math.min(x, 1 - w),
            w,
            intensity: maxCost > 0 ? Math.min(1, Math.max(0, (card.cost_usd ?? 0) / maxCost)) : null,
            failed: failures > 0,
            failures,
            label: subagentChipLabel(card.task_label) ?? `${shortSessionId(card.id)}…`,
            title: [
                card.task_label ?? card.id,
                card.model,
                fmtDuration(card.duration_ms),
                fmtUsd(card.cost_usd),
                failures > 0 ? `${failures} failure${failures === 1 ? "" : "s"}` : null,
            ].filter(Boolean).join(" · "),
        };
    });

    // Greedy row packing on the shared axis - overlapping bars stack downward.
    const laneEnds: number[] = [];
    const lanes = [...placed]
        .sort((p, q) => p.x - q.x || p.order - q.order)
        .map(({ card, order: _order, ...lane }): SessionMapLane => {
            let row = 0;
            while (row < laneEnds.length && (laneEnds[row] ?? 0) > lane.x - SESSION_MAP_PACK_GAP) row++;
            if (row >= SESSION_MAP_MAX_ROWS) row = SESSION_MAP_MAX_ROWS - 1;
            laneEnds[row] = Math.max(laneEnds[row] ?? 0, lane.x + lane.w);
            return { ...lane, file: card.file, id: card.id, row };
        });

    return {
        axis,
        rows: lanes.reduce((acc, lane) => Math.max(acc, lane.row + 1), 1),
        rootDurationMs,
        lanes,
    };
}

const SESSION_MAP_ROW_H = 18;
const SESSION_MAP_AXIS_CAPTION: Record<SessionMapAxis, string> = {
    seq: "placed by spawn turn",
    time: "placed by start time",
    order: "in spawn order",
};

/**
 * Compact session-map strip near the share hero: the root run's fan-out as
 * one bar per subagent. Renders from the manifest only; clicking a bar uses
 * the same `?sub=<file>` selection as the rest of the share viewer.
 */
function ShareSessionMap(props: {
    readonly manifest: ShareManifest;
    readonly selectedFile: string;
    readonly onSelect: (file: string) => void;
    readonly onPrefetch: (file: string) => void;
}) {
    const model = useMemo(() => buildSessionMapLanes(props.manifest), [props.manifest]);
    if (!model) return null;
    const duration = fmtDuration(model.rootDurationMs);
    const hasCost = model.lanes.some((lane) => lane.intensity != null);
    const laneBackground = (lane: SessionMapLane): string => {
        const pct = lane.intensity == null ? 26 : Math.round(18 + 62 * lane.intensity);
        if (lane.failed) return `color-mix(in srgb, var(--red) ${Math.max(pct, 26)}%, var(--panel))`;
        if (lane.intensity == null) return "color-mix(in srgb, var(--muted) 22%, var(--panel))";
        return `color-mix(in srgb, var(--rose) ${pct}%, var(--panel))`;
    };
    return (
        <div style={SUBAGENT_BAR_STYLE} aria-label="Session map">
            <div style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                font: "700 10px/1.5 ui-monospace, monospace",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: "var(--muted)",
            }}>
                <span>Session map · {model.lanes.length} subagent{model.lanes.length === 1 ? "" : "s"}</span>
                <span>{[duration ? `root ${duration}` : null, SESSION_MAP_AXIS_CAPTION[model.axis]].filter(Boolean).join(" · ")}</span>
            </div>
            <div style={{ position: "relative", height: model.rows * SESSION_MAP_ROW_H, marginTop: 8 }}>
                {model.lanes.map((lane) => {
                    const selected = lane.file === props.selectedFile;
                    return (
                        <button
                            key={lane.file}
                            type="button"
                            title={lane.title}
                            aria-label={`Open subagent: ${lane.title}`}
                            aria-pressed={selected}
                            onClick={() => props.onSelect(lane.file)}
                            onMouseEnter={() => props.onPrefetch(lane.file)}
                            onFocus={() => props.onPrefetch(lane.file)}
                            style={{
                                position: "absolute",
                                left: `${lane.x * 100}%`,
                                width: `${lane.w * 100}%`,
                                minWidth: 10,
                                maxWidth: "100%",
                                top: lane.row * SESSION_MAP_ROW_H,
                                height: SESSION_MAP_ROW_H - 4,
                                padding: "0 4px",
                                border: selected ? "1px solid var(--ink)" : "1px solid transparent",
                                borderRadius: 2,
                                cursor: "pointer",
                                background: laneBackground(lane),
                                overflow: "hidden",
                                textAlign: "left",
                                whiteSpace: "nowrap",
                                textOverflow: "ellipsis",
                                font: "9px/1.4 ui-monospace, monospace",
                                color: lane.failed ? "color-mix(in srgb, var(--red) 60%, var(--ink))" : "var(--ink)",
                            }}
                        >
                            {lane.label}
                        </button>
                    );
                })}
            </div>
            <div style={{ marginTop: 6, font: "10px/1.4 ui-monospace, monospace", color: "var(--muted-2)" }}>
                {[hasCost ? "darker = costlier" : null, "click a bar to open the subagent"].filter(Boolean).join(" · ")}
            </div>
        </div>
    );
}

/** The transcript body for one session - reused by parent + subagent views. */
function InspectBody({
    data,
    subagentsByTurn,
    harnessHooks,
    onSelectSubagent,
    onPrefetchSubagent,
    landOnFirstTurn = false,
}: {
    readonly data: SessionInspectPayload;
    readonly subagentsByTurn?: ReadonlyMap<number, ReadonlyArray<ShareSubagentCard>>;
    readonly harnessHooks?: ReadonlyArray<ShareHarnessHookView>;
    readonly onSelectSubagent?: (file: string) => void;
    readonly onPrefetchSubagent?: (file: string) => void;
    /** Land on the first message instead of page top (subagent continuity:
     *  the reader just clicked this session's task in the parent transcript). */
    readonly landOnFirstTurn?: boolean;
}) {
    const [anchoredSeq, setAnchoredSeq] = useState<number | null>(() => hashSeq());
    const turnsRef = useRef<ReadonlyArray<InspectTurnDto>>([]);
    turnsRef.current = data.turns;

    // Landing on mount (the component is keyed per session file): a #turn
    // anchor wins via the anchoredSeq effect below; otherwise a subagent
    // continues at its first message; otherwise reset to the page top.
    useEffect(() => {
        if (hashSeq() != null) return;
        const first = turnsRef.current[0];
        if (landOnFirstTurn && first) {
            document.getElementById(`turn-${first.seq}`)?.scrollIntoView({ behavior: "auto", block: "start" });
            return;
        }
        window.scrollTo(0, 0);
        // Mount-only: landing is a one-shot decision per keyed session view.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Mount-windowing: render the first N turns, grow on scroll / on a jump that
    // targets a turn past the window. The full list stays in `data.turns` so
    // jump/find/cost-rail still see everything.
    const [visibleCount, setVisibleCount] = useState(() => Math.min(SHARE_PAGE_SIZE, data.turns.length));
    // Reset the window when the session being viewed changes (subagent switch).
    useEffect(() => {
        setVisibleCount(Math.min(SHARE_PAGE_SIZE, data.turns.length));
    }, [data.source_path, data.turns.length]);
    const loadMore = (n?: number) =>
        new Promise<void>((resolve) => {
            setVisibleCount((c) => Math.min(data.turns.length, c + Math.max(n ?? SHARE_PAGE_SIZE, SHARE_PAGE_SIZE)));
            // Resolve after the grow has rendered so FilterBar's post-loadMore
            // scrollIntoView finds the now-mounted target.
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
    const sentinelRef = useRef<HTMLDivElement | null>(null);
    // Harness hooks (guardrail fires) anchored to their nearest turn, + the
    // combined jump idx list ("next hook fire" cycles file-context + harness).
    const harnessByTurn = useMemo(() => {
        const map = new Map<number, ShareHarnessHookView[]>();
        for (const hook of harnessHooks ?? []) {
            if (hook.anchor_turn_seq == null) continue;
            const list = map.get(hook.anchor_turn_seq) ?? [];
            list.push(hook);
            map.set(hook.anchor_turn_seq, list);
        }
        return map;
    }, [harnessHooks]);
    const hookFireIdxs = [
        ...data.hook_fires.map((h) => h.idx),
        ...(harnessHooks ?? []).map((h) => HARNESS_HOOK_IDX_BASE + h.idx),
    ];
    const hookFireIdxsRef = useRef<ReadonlyArray<number>>([]);
    hookFireIdxsRef.current = hookFireIdxs;
    const visibleSeq = useVisibleTurnSeq(data.turns, anchoredSeq ?? data.turns[0]?.seq ?? null);
    const [selection, setSelection] = useInspectSelection(data);
    // Spawn-turn seqs power the "next spawn" jump button + match the inline
    // spawn markers below.
    const spawnAnchorSeqs = useMemo(
        () => new Set<number>(subagentsByTurn ? [...subagentsByTurn.keys()] : []),
        [subagentsByTurn],
    );

    useEffect(() => {
        const onHashChange = () => setAnchoredSeq(hashSeq());
        window.addEventListener("hashchange", onHashChange);
        return () => window.removeEventListener("hashchange", onHashChange);
    }, []);

    // A jump/hash targeting a turn past the window grows it to include the target.
    useEffect(() => {
        if (anchoredSeq == null) return;
        const idx = data.turns.findIndex((t) => t.seq === anchoredSeq);
        if (idx >= 0 && idx >= visibleCount) setVisibleCount(idx + 1);
    }, [anchoredSeq, data.turns, visibleCount]);

    useEffect(() => {
        if (anchoredSeq == null) return;
        document.getElementById(`turn-${anchoredSeq}`)?.scrollIntoView({ behavior: "auto", block: "start" });
    }, [anchoredSeq, data.turns.length, visibleCount]);

    // Grow the window as the bottom sentinel scrolls into view.
    useEffect(() => {
        const el = sentinelRef.current;
        if (!el || visibleCount >= data.turns.length) return;
        const obs = new IntersectionObserver(
            (entries) => {
                if (entries.some((e) => e.isIntersecting)) {
                    setVisibleCount((c) => Math.min(data.turns.length, c + SHARE_PAGE_SIZE));
                }
            },
            { rootMargin: "1200px 0px" },
        );
        obs.observe(el);
        return () => obs.disconnect();
    }, [visibleCount, data.turns.length]);

    const windowedTurns = useMemo(() => data.turns.slice(0, visibleCount), [data.turns, visibleCount]);

    return (
        <Transcript
            data={{ ...data, turns: windowedTurns }}
            anchoredSeq={anchoredSeq}
            selection={selection}
            setSelection={setSelection}
            visibleSeq={visibleSeq}
            filterBar={{
                turns: data.turns,
                anchorSeqs: spawnAnchorSeqs,
                loadedCount: visibleCount,
                totalCount: data.turns.length,
                appendLoading: false,
                loadMore,
                getTurns: () => turnsRef.current,
                getCurrentSeq: () => anchoredSeq,
                hookFireIdxs,
                getHookFireIdxs: () => hookFireIdxsRef.current,
                totalHookFires: data.total_hook_fires + (harnessHooks?.length ?? 0),
            }}
            header={
                <div style={{ padding: "8px var(--strip-x)", color: "var(--muted)", fontSize: 12, fontFamily: "ui-monospace, monospace" }}>
                    {data.turns.length} turns · this session
                </div>
            }
            renderAfterTurn={(seq) => {
                const spawned = subagentsByTurn?.get(seq);
                const hooks = harnessByTurn.get(seq);
                return (
                    <>
                        {hooks && hooks.length > 0 ? (
                            <div style={{ padding: "2px var(--strip-x) 4px" }}>
                                {hooks.map((hook) => (
                                    <HarnessHookMarker key={`hh-${hook.idx}`} hook={hook} />
                                ))}
                            </div>
                        ) : null}
                        {spawned && spawned.length > 0 ? (
                            <div style={{ padding: "2px var(--strip-x) 6px" }}>
                                {spawned.map((card) => (
                                    <ShareSpawnMarker
                                        key={card.id}
                                        card={card}
                                        onSelect={() => onSelectSubagent?.(card.file)}
                                        onPrefetch={() => onPrefetchSubagent?.(card.file)}
                                    />
                                ))}
                            </div>
                        ) : null}
                    </>
                );
            }}
            renderAfterTurns={() =>
                visibleCount < data.turns.length ? (
                    <div ref={sentinelRef} style={{ padding: "12px var(--strip-x)", color: "var(--muted-2)", fontSize: 11, fontFamily: "ui-monospace, monospace" }}>
                        loading {data.turns.length - visibleCount} more turns…
                    </div>
                ) : null
            }
        />
    );
}

const SUBAGENT_BAR_STYLE: CSSProperties = {
    padding: "10px var(--strip-x)",
    background: "var(--panel)",
    borderBottom: "1px solid var(--line)",
    fontSize: 12,
};

/** Chip-shaped child-session link: a solid scannable unit with a real hit
 *  area, toned as navigation (the rose family stays on the inline spawn
 *  markers - an error-red strip read as "something failed", not "browse"). */
const SUBAGENT_LINK_STYLE: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: 3,
    padding: "6px 10px",
    cursor: "pointer",
    color: "var(--blue)",
    fontFamily: "ui-monospace, monospace",
    fontSize: 12,
    textDecoration: "none",
};

/** Children share a long boilerplate prefix ("You are implementing ...") -
 *  truncating from the tail kept only the shared part. Strip the prefix so
 *  the differentiating text survives. */
const subagentChipLabel = (label: string | null | undefined): string | null => {
    if (!label) return null;
    const stripped = label.replace(/^you are\s+(implementing\s+)?/i, "").trim();
    const text = stripped || label;
    return text.length > 52 ? `${text.slice(0, 51)}…` : text;
};

const VIEW_TOGGLE_BAR_STYLE: CSSProperties = {
    display: "flex",
    gap: 6,
    padding: "8px var(--strip-x) 0",
};

const VIEW_TOGGLE_BUTTON_STYLE: CSSProperties = {
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: 4,
    padding: "6px 12px",
    cursor: "pointer",
    color: "var(--muted)",
    fontFamily: "ui-monospace, monospace",
    fontSize: 11.5,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
};

/** DOM-id offset so harness-hook markers don't collide with file-context
 *  hook_fire markers (both use `hook-<n>` ids for the shared jump). */
const HARNESS_HOOK_IDX_BASE = 1_000_000;

const harnessTone = (accent: string): { bg: string; fg: string; bar: string } => ({
    bg: `color-mix(in srgb, ${accent} 8%, var(--panel))`,
    fg: `color-mix(in srgb, ${accent} 45%, var(--ink))`,
    bar: accent,
});
const HARNESS_EFFECT_TONE: Record<string, { bg: string; fg: string; bar: string }> = {
    blocked: harnessTone("var(--red)"),
    modified_input: harnessTone("var(--gold)"),
    injected_context: harnessTone("var(--green)"),
    notified: harnessTone("var(--blue)"),
};

/** Inline marker for a harness hook that did something (blocked / modified /
 *  injected). Shows the guardrail activity inline in the shared transcript. */
function HarnessHookMarker(props: { readonly hook: ShareHarnessHookView }) {
    const { hook } = props;
    const tone = HARNESS_EFFECT_TONE[hook.effect] ?? { bg: "var(--page)", fg: "var(--ink)", bar: "var(--muted-2)" };
    return (
        <div
            id={`hook-${HARNESS_HOOK_IDX_BASE + hook.idx}`}
            style={{
                margin: "4px 0", padding: "5px 10px", background: tone.bg,
                borderLeft: `4px solid ${tone.bar}`, borderRadius: 3,
                fontSize: 11, fontFamily: "ui-monospace, monospace", color: tone.fg,
            }}
        >
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 700 }}>⚙ hook</span>
                <span style={{ fontWeight: 600 }}>{hook.hook_name}</span>
                <span style={{ background: tone.bar, color: "#fff", padding: "0 6px", borderRadius: 2, fontSize: 10, fontWeight: 600 }}>
                    {hook.effect.replace(/_/g, " ")}
                </span>
                {hook.command ? <span style={{ opacity: 0.7 }}>{hook.command}</span> : null}
                {hook.status === "blocking_error" ? <span style={{ fontWeight: 600 }}>⚠️ blocking</span> : null}
            </div>
            {hook.detail ? (
                <div style={{ marginTop: 4, whiteSpace: "pre-wrap", wordBreak: "break-word", opacity: 0.9, lineHeight: 1.5 }}>
                    {hook.detail}
                </div>
            ) : null}
        </div>
    );
}

/**
 * Inline "spawned subagent" marker, mirroring the live inspector's SpawnMarker
 * look but wired to in-bundle file selection (gist children aren't DB routes).
 */
export function ShareSpawnMarker(props: {
    readonly card: ShareSubagentCard;
    readonly onSelect: () => void;
    readonly onPrefetch: () => void;
}) {
    const { card } = props;
    const cost = fmtUsd(card.cost_usd);
    const duration = fmtDuration(card.duration_ms);
    const tokens = compactTokens(card.estimated_tokens);
    return (
        <button
            type="button"
            onClick={props.onSelect}
            onMouseEnter={props.onPrefetch}
            onFocus={props.onPrefetch}
            style={{
                display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
                width: "100%", textAlign: "left", cursor: "pointer",
                margin: "4px 0", padding: "10px", background: "color-mix(in srgb, var(--rose) 8%, var(--panel))",
                border: "1px solid color-mix(in srgb, var(--rose) 25%, var(--panel))", borderLeft: "4px solid var(--rose)", borderRadius: 3,
                fontSize: 11, fontFamily: "ui-monospace, monospace", color: "var(--rose)",
            }}
        >
            <span style={{ fontWeight: 700 }}>↳ spawned subagent</span>
            <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 420 }}>
                {card.task_label ? `"${card.task_label}"` : `${card.id.slice(0, 24)}…`}
            </span>
            <span style={{ background: "color-mix(in srgb, var(--rose) 25%, var(--panel))", color: "color-mix(in srgb, var(--rose) 45%, var(--ink))", padding: "0 6px", borderRadius: 2, fontSize: 10, fontWeight: 600 }}>
                {card.model ?? card.source}
            </span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                <span>{card.stats.turns} turns</span>
                <span>{card.stats.tool_calls} tools</span>
                {tokens ? <span>{tokens} tok</span> : null}
                {duration ? <span>{duration}</span> : null}
                {cost ? <span>{cost}</span> : null}
                <span style={{ opacity: 0.7 }}>open →</span>
            </span>
        </button>
    );
}

function fmtShareDate(iso?: string): string | null {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
}

/** Strip the `committed <sha> · ` prefix a timeline segment title carries so
 *  scrubber labels read as work, not bookkeeping. */
const segmentLabel = (title: string): string =>
    title.replace(/^committed\s+\S+\s*·\s*/, "").trim() || title;

/**
 * The session scrubber: the whole run on one wall-clock strip. Segments are
 * the timeline's phases (proportional to real elapsed time), green ticks are
 * commits, red ticks failures, rose dots subagent dispatches. Clicking a
 * phase jumps the transcript to its first turn (the hash flip also leaves
 * the timeline view if that's where the reader is).
 */
function SessionScrubber({ timeline, spawnCards }: {
    readonly timeline: SessionTimelinePayload;
    readonly spawnCards?: ReadonlyArray<ShareSubagentCard>;
}) {
    const h = timeline.highlights;
    const t0 = Date.parse(h.started_at ?? "");
    const t1 = Date.parse(h.ended_at ?? "");
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 - t0 < 60_000) return null;
    const span = t1 - t0;
    const frac = (iso: string | null | undefined): number | null => {
        const t = Date.parse(iso ?? "");
        if (!Number.isFinite(t)) return null;
        return Math.min(1, Math.max(0, (t - t0) / span));
    };
    const segs = timeline.segments
        .map((seg, i) => {
            const a = frac(seg.started_at);
            const next = timeline.segments[i + 1];
            const b = next ? frac(next.started_at) : 1;
            return a != null && b != null && b > a ? { seg, a, b } : null;
        })
        .filter((s): s is { seg: SessionTimelinePayload["segments"][number]; a: number; b: number } => s !== null);
    if (segs.length < 2) return null;
    const ticks = (kind: "checkpoint" | "failure") =>
        timeline.events.filter((e) => e.kind === kind).map((e) => frac(e.ts)).filter((x): x is number => x != null);
    const jump = (seq: number | null) => {
        if (seq == null) return;
        window.location.hash = `turn-${seq}`;
    };
    const fmtClock = (t: number) => new Date(t).toISOString().slice(5, 16).replace("T", " ");
    // Subagent lanes: each dispatch as a bar on the same time axis, greedy
    // row packing, opacity by cost - a timeline-local preview of the fan-out
    // (the standalone F2 session map is ShareSessionMap, rendered separately).
    const lanes: Array<Array<{ x: number; w: number; cost: number; failed: boolean; label: string }>> = [];
    const laneEnds: number[] = [];
    const maxCost = Math.max(0.01, ...(spawnCards ?? []).map((c) => c.cost_usd ?? 0));
    for (const card of [...(spawnCards ?? [])].sort((p, q) => (p.started_at ?? "").localeCompare(q.started_at ?? ""))) {
        const x = frac(card.started_at);
        if (x == null) continue;
        const w = Math.max((card.duration_ms ?? 0) / span, 0.004);
        let r = 0;
        while (r < laneEnds.length && laneEnds[r] > x - 0.002) r++;
        if (r >= 4) r = 3;
        laneEnds[r] = x + w;
        (lanes[r] ??= []).push({
            x,
            w,
            cost: card.cost_usd ?? 0,
            failed: (card.stats?.failures ?? 0) > 0,
            label: `${card.task_label ?? card.id} - ${fmtUsd(card.cost_usd) ?? ""}`,
        });
    }
    return (
        <div className="scrub-wrap">
            {/* Labels live in their own deck so the strip below stays pure
                signal - inside the strip they collided with the ticks. */}
            <div className="scrub-labels">
                {segs.filter(({ a, b }) => b - a > 0.08).map(({ seg, a, b }) => (
                    <span
                        key={`l-${seg.id}`}
                        style={{ left: `${a * 100}%`, width: `${(b - a) * 100}%` }}
                        onClick={() => jump(seg.start_seq)}
                    >
                        {segmentLabel(seg.title)}
                    </span>
                ))}
            </div>
            <div className="scrub">
                {segs.map(({ seg, a, b }) => (
                    <button
                        key={seg.id}
                        type="button"
                        className="scrub-seg"
                        style={{ left: `${a * 100}%`, width: `${(b - a) * 100}%` }}
                        title={`${segmentLabel(seg.title)} - ${fmtDuration(seg.duration_ms) ?? ""} · ${seg.rollup.tool_calls} tools${seg.rollup.failures ? ` · ${seg.rollup.failures} failures` : ""}`}
                        onClick={() => jump(seg.start_seq)}
                    />
                ))}
                {ticks("checkpoint").map((x, i) => <i key={`c${i}`} className="scrub-commit" style={{ left: `${x * 100}%` }} />)}
                {ticks("failure").map((x, i) => <i key={`f${i}`} className="scrub-fail" style={{ left: `${x * 100}%` }} />)}
            </div>
            {lanes.length > 0 ? (
                <div className="scrub-lanes" style={{ height: lanes.length * 8 + 2 }}>
                    {lanes.map((row, r) =>
                        row.map((b, i) => (
                            <i
                                key={`${r}-${i}`}
                                className={b.failed ? "lane-bar failed" : "lane-bar"}
                                style={{
                                    left: `${b.x * 100}%`,
                                    width: `${Math.max(b.w * 100, 0.4)}%`,
                                    top: r * 8,
                                    opacity: 0.35 + 0.6 * (b.cost / maxCost),
                                }}
                                title={b.label}
                            />
                        )))}
                </div>
            ) : null}
            <div className="scrub-axis">
                <span>{fmtClock(t0)}</span>
                <span>commits ↓ · failures ↑{lanes.length > 0 ? " · bars = subagents (darker = costlier)" : ""} - click a phase to jump</span>
                <span>{fmtClock(t1)}</span>
            </div>
        </div>
    );
}

/** Outcome-first header for a shared session: verdict, a one-sentence lede
 *  built from the run's own numbers, and the wall-clock scrubber - so a cold
 *  reader gets the story AND the shape before the transcript. */
function ShareOutcomeHeader(props: {
    readonly summary?: string;
    readonly source: string;
    readonly model?: string;
    readonly project?: string;
    readonly startedAt?: string;
    readonly turns: number;
    readonly toolCalls: number;
    readonly files: number;
    readonly subagents: number;
    readonly failures: number;
    readonly costUsd: number | null;
    readonly durationMs: number | null;
    readonly timeline?: SessionTimelinePayload | null;
    readonly spawnCards?: ReadonlyArray<ShareSubagentCard>;
}) {
    const cost = fmtUsd(props.costUsd);
    const duration = fmtDuration(props.durationMs);
    const date = fmtShareDate(props.startedAt);
    const tl = props.timeline ?? null;
    const commits = tl?.highlights.event_counts.checkpoint ?? 0;
    const failEvents = tl ? tl.events.filter((e) => e.kind === "failure") : [];
    const recovered = failEvents.filter((e) => e.recovered_by_seq != null).length;
    const right = [cost, duration, date, props.model ?? props.source].filter(Boolean).join(" · ");
    // The lede: the headline numbers assembled into one readable sentence
    // (a stat grid makes the reader do the assembly; a sentence does it).
    const failPhrase = props.failures > 0
        ? `${props.failures} failed tool calls${failEvents.length > 0 && recovered === failEvents.length ? " - recovered" : ""}`
        : null;
    return (
        <div className="share-hero">
            <div className="share-hero-top">
                <h2 className="share-hero-title">
                    {commits > 0 ? <span className="share-hero-verdict">✔ {commits} commits</span> : null}
                    {cleanShareSummary(props.summary) ?? "Shared agent session"}
                </h2>
                {right ? <span className="share-hero-right">{right}</span> : null}
            </div>
            <p className="share-hero-lede">
                An agent{props.subagents > 0 ? <> and <b>{props.subagents} subagents</b></> : null}
                {" - "}<b>{props.turns.toLocaleString()}</b> turns, <b>{props.toolCalls.toLocaleString()}</b> tool calls
                {props.files > 0 ? <>, <b>{props.files}</b> files</> : null}
                {failPhrase ? <>, <span className="share-hero-fail">{failPhrase}</span></> : null}.
            </p>
            {tl ? <SessionScrubber timeline={tl} spawnCards={props.spawnCards} /> : null}
            <div className="share-hero-brand">
                <span>{[props.project, fmtShareDate(props.startedAt)].filter(Boolean).join(" · ")}</span>
                <span>recorded with <b>ax</b> · ax.necmttn.com</span>
            </div>
        </div>
    );
}

/** Share summaries are raw first-turn text and can open with harness XML
 *  (`<local-command-stdout>…`) - strip tags/envelopes so the largest type on
 *  the page reads as a story, not a debug dump. */
export function cleanShareSummary(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const text = raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    return text.length > 0 ? text : null;
}

/** v3 multi-file share: manifest-first render + lazy/prefetch session files. */
function MultiFileShareView(props: {
    readonly owner: string;
    readonly gistId: string;
    readonly manifest: ShareManifest;
}) {
    const { owner, gistId, manifest } = props;
    const qc = useQueryClient();
    // Selected session is URL-driven (?sub=<file>) so browser back/forward walks
    // the parent <-> subagent navigation instead of being trapped in local state.
    const navigate = useNavigate();
    const search = useSearch({ strict: false }) as { readonly sub?: string; readonly view?: string };
    const selectedFile = search.sub && manifest.subagents.some((c) => c.file === search.sub)
        ? search.sub
        : manifest.root_file;
    const view: "transcript" | "timeline" = search.view === "timeline" ? "timeline" : "transcript";
    // This view mounts on both the studio index ("/studio/?shareOwner&gistId",
    // the public iframe entry) and the "/share/$owner/$gistId" route, so
    // navigate()'s search-updater can't resolve a single route type. The call
    // is valid at runtime on either - it swaps search params on the current
    // location and clears the #turn anchor when switching sessions.
    const navigateLoose = navigate as unknown as (opts: {
        readonly search: (prev: Record<string, unknown>) => Record<string, unknown>;
        readonly hash?: string;
    }) => void;
    const setSelectedFile = (file: string, anchorSeq?: number | null) => {
        const sub = file === manifest.root_file ? undefined : file;
        // Drop the #turn anchor BEFORE the navigate re-renders: the freshly
        // keyed InspectBody reads location.hash at mount, and a stale anchor
        // would scroll the new session to the old session's turn number.
        // `anchorSeq` re-anchors deliberately (back-nav returns to the spawn turn).
        if (window.location.hash) {
            window.history.replaceState(null, "", window.location.pathname + window.location.search);
        }
        const go = () =>
            navigateLoose({
                search: (prev) => ({ ...prev, sub }),
                hash: anchorSeq != null ? `turn-${anchorSeq}` : "",
            });
        // Crossfade the session switch where the View Transitions API exists.
        const startViewTransition = (document as { startViewTransition?: (cb: () => unknown) => unknown })
            .startViewTransition?.bind(document);
        if (startViewTransition) startViewTransition(go);
        else go();
    };
    const setView = (next: "transcript" | "timeline") => {
        navigateLoose({
            search: (prev) => ({ ...prev, view: next === "transcript" ? undefined : next }),
            // Preserve the #turn anchor across the toggle: a timeline event's
            // "→ turn N" link sets the hash first, then flips the view, and the
            // mounting transcript scrolls to it.
            hash: window.location.hash.replace(/^#/, ""),
        });
    };
    // Landing position on session switch lives in InspectBody's mount effect
    // (anchor > first turn > top), so nothing scrolls here.
    // Timeline event rows link to `#turn-N` anchors that only exist in the
    // transcript - a hash jump while on the timeline flips back to it.
    useEffect(() => {
        if (view !== "timeline") return;
        const onHash = () => {
            if (window.location.hash.startsWith("#turn-")) setView("transcript");
        };
        window.addEventListener("hashchange", onHash);
        return () => window.removeEventListener("hashchange", onHash);
    }, [view]);
    // Mirror the selected subagent + view onto the embedding page's URL (the
    // public /s/<owner>/<gistId> shell iframes this same-origin), so copying
    // the address bar shares exactly what is on screen. replaceState bypasses
    // the parent's router, so the iframe src stays stable - no reload loop.
    const subParam = selectedFile === manifest.root_file ? undefined : selectedFile;
    useEffect(() => {
        if (window.parent === window) return;
        try {
            const url = new URL(window.parent.location.href);
            if (subParam) url.searchParams.set("sub", subParam);
            else url.searchParams.delete("sub");
            if (view === "timeline") url.searchParams.set("view", view);
            else url.searchParams.delete("view");
            window.parent.history.replaceState(null, "", url.toString());
        } catch {
            // Cross-origin embed: leave the parent URL alone.
        }
    }, [subParam, view]);

    const fileQuery = useQuery({
        queryKey: ["share-file", owner, gistId, selectedFile],
        queryFn: () => fetchShareFile(owner, gistId, selectedFile),
        ...IMMUTABLE_SHARE_QUERY,
    });
    const data = useMemo(
        () => fileQuery.data ? inspectPayloadFromShare(fileQuery.data, `gist:${owner}/${gistId}/${selectedFile}`) : null,
        [fileQuery.data, owner, gistId, selectedFile],
    );

    const prefetch = (file: string) =>
        qc.prefetchQuery({
            queryKey: ["share-file", owner, gistId, file],
            queryFn: () => fetchShareFile(owner, gistId, file),
            ...IMMUTABLE_SHARE_QUERY,
        });

    const totals = manifest.totals;

    // Which session is on screen, its direct children grouped by spawn turn
    // (-> inline markers), and a back-link when viewing a subagent.
    const selectedSessionId = selectedFile === manifest.root_file
        ? manifest.session.id
        : manifest.subagents.find((c) => c.file === selectedFile)?.id ?? null;
    const subagentsByTurn = useMemo(() => {
        const map = new Map<number, ShareSubagentCard[]>();
        for (const card of manifest.subagents) {
            if (card.parent_id !== selectedSessionId) continue;
            if (card.spawn_turn_seq == null) continue;
            const list = map.get(card.spawn_turn_seq) ?? [];
            list.push(card);
            map.set(card.spawn_turn_seq, list);
        }
        return map;
    }, [manifest.subagents, selectedSessionId]);
    const directChildren = manifest.subagents.filter((c) => c.parent_id === selectedSessionId);
    const selectedCard = selectedFile === manifest.root_file
        ? null
        : manifest.subagents.find((c) => c.file === selectedFile) ?? null;
    const parentCard = selectedCard && selectedCard.parent_id !== manifest.session.id
        ? manifest.subagents.find((c) => c.id === selectedCard.parent_id) ?? null
        : null;
    const parentFile = parentCard ? parentCard.file : manifest.root_file;
    const parentLabel = parentCard
        ? (parentCard.task_label ?? `${shortSessionId(parentCard.id)}…`)
        : "main session";

    return (
        <section className="panel">
            <header>
                <h2>Shared session inspect</h2>
                <span className="meta">
                    <code>{shortSessionId(manifest.session.id)}…</code>
                    {" · gist share"}
                </span>
            </header>
            {/* Hero follows the session ON SCREEN: a subagent view shows the
                subagent's task + stats, not the parent's (which read as a
                missing context switch). */}
            {selectedCard ? (
                <ShareOutcomeHeader
                    summary={selectedCard.task_label ?? "Subagent session"}
                    source={selectedCard.source}
                    model={selectedCard.model}
                    project={manifest.session.project}
                    startedAt={selectedCard.started_at}
                    turns={selectedCard.stats.turns}
                    toolCalls={selectedCard.stats.tool_calls}
                    files={selectedCard.stats.files_changed}
                    subagents={directChildren.length}
                    failures={selectedCard.stats.failures}
                    costUsd={selectedCard.cost_usd}
                    durationMs={selectedCard.duration_ms}
                    timeline={fileQuery.data?.session_timeline ?? null}
                    spawnCards={directChildren}
                />
            ) : (
                <ShareOutcomeHeader
                    summary={manifest.session.summary}
                    source={manifest.session.source}
                    model={manifest.session.model}
                    project={manifest.session.project}
                    startedAt={manifest.session.started_at}
                    turns={totals.turns}
                    toolCalls={totals.tool_calls}
                    files={manifest.stats.files_changed}
                    subagents={totals.subagents}
                    failures={totals.failures}
                    costUsd={totals.cost_usd}
                    durationMs={totals.duration_ms}
                    timeline={fileQuery.data?.session_timeline ?? null}
                    spawnCards={directChildren}
                />
            )}
            {manifest.subagents.length > 0 ? (
                <ShareSessionMap
                    manifest={manifest}
                    selectedFile={selectedFile}
                    onSelect={setSelectedFile}
                    onPrefetch={prefetch}
                />
            ) : null}
            {directChildren.length > 0 ? (
                <details style={SUBAGENT_BAR_STYLE}>
                    <summary style={{
                        font: "700 10px/1.5 ui-monospace, monospace",
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                        color: "var(--muted)",
                        cursor: "pointer",
                    }}>
                        {directChildren.length} subagent session{directChildren.length === 1 ? "" : "s"} · {fmtUsd(directChildren.reduce((acc, c) => acc + (c.cost_usd ?? 0), 0)) ?? ""} - browse all, or open them inline at their spawn points ↓
                    </summary>
                    <span style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
                        {directChildren.map((c) => (
                            <button
                                key={c.id}
                                type="button"
                                onClick={() => setSelectedFile(c.file)}
                                onMouseEnter={() => prefetch(c.file)}
                                onFocus={() => prefetch(c.file)}
                                style={SUBAGENT_LINK_STYLE}
                            >
                                {subagentChipLabel(c.task_label) ?? `${shortSessionId(c.id)}…`}
                                {fmtUsd(c.cost_usd) ? <span style={{ color: "var(--muted)", marginLeft: 6 }}>{fmtUsd(c.cost_usd)}</span> : null}
                            </button>
                        ))}
                    </span>
                </details>
            ) : null}
            {selectedCard ? (
                <div style={SUBAGENT_BAR_STYLE}>
                    <button
                        type="button"
                        onClick={() => setSelectedFile(parentFile, selectedCard.spawn_turn_seq)}
                        onMouseEnter={() => prefetch(parentFile)}
                        style={{ ...SUBAGENT_LINK_STYLE, fontWeight: 700 }}
                    >
                        ↑ back to {subagentChipLabel(parentLabel) ?? parentLabel}
                    </button>
                </div>
            ) : null}
            {fileQuery.error ? <div className="error">Error: {String(fileQuery.error)}</div> : null}
            {fileQuery.isLoading && !data ? <div className="loading">Loading session…</div> : null}
            {fileQuery.data?.session_timeline ? (
                <div style={VIEW_TOGGLE_BAR_STYLE}>
                    {(["transcript", "timeline"] as const).map((mode) => (
                        <button
                            key={mode}
                            type="button"
                            onClick={() => setView(mode)}
                            aria-pressed={view === mode}
                            style={{
                                ...VIEW_TOGGLE_BUTTON_STYLE,
                                ...(view === mode
                                    ? { background: "var(--ink)", color: "var(--page)", borderColor: "var(--ink)" }
                                    : {}),
                            }}
                        >
                            {mode === "transcript" ? "Read the transcript" : "Scan the timeline"}
                        </button>
                    ))}
                </div>
            ) : null}
            {view === "timeline" && fileQuery.data?.session_timeline ? (
                <SessionTimelineBody data={fileQuery.data.session_timeline} />
            ) : data ? (
                <InspectBody
                    // Keyed by file: jump-cursor/anchor state must not leak from
                    // one session's transcript into another's.
                    key={selectedFile}
                    data={data}
                    subagentsByTurn={subagentsByTurn}
                    harnessHooks={fileQuery.data?.harness_hooks}
                    onSelectSubagent={setSelectedFile}
                    onPrefetchSubagent={prefetch}
                    landOnFirstTurn={selectedFile !== manifest.root_file}
                />
            ) : null}
        </section>
    );
}

/** Legacy single-file share (schema v1/v2): `ax-session.json`. */
function LegacyShareView(props: { readonly owner: string; readonly gistId: string }) {
    const { owner, gistId } = props;
    const query = useQuery({
        queryKey: ["share-inspect", owner, gistId],
        queryFn: () => fetchShareArtifact(owner, gistId),
        ...IMMUTABLE_SHARE_QUERY,
    });
    const data = useMemo(
        () => query.data ? inspectPayloadFromShare(query.data, `gist:${owner}/${gistId}`) : null,
        [gistId, owner, query.data],
    );
    return (
        <section className="panel">
            <header>
                <h2>Shared session inspect</h2>
                <span className="meta">
                    <code>{query.data ? `${shortSessionId(query.data.session.id)}…` : `${owner}/${gistId}`}</code>
                    {" · gist share"}
                </span>
            </header>
            {query.data ? (
                <ShareOutcomeHeader
                    summary={query.data.session.summary}
                    source={query.data.session.source}
                    model={query.data.session.model}
                    project={query.data.session.project}
                    startedAt={query.data.session.started_at}
                    turns={query.data.stats.turns}
                    toolCalls={query.data.stats.tool_calls}
                    files={query.data.stats.files_changed}
                    subagents={0}
                    failures={query.data.stats.failures}
                    costUsd={query.data.token_usage?.estimated_cost_usd ?? null}
                    timeline={query.data.session_timeline ?? null}
                    durationMs={
                        query.data.session.started_at && query.data.session.ended_at
                            ? new Date(query.data.session.ended_at).getTime() - new Date(query.data.session.started_at).getTime()
                            : null
                    }
                />
            ) : null}
            {query.error ? <div className="error">Error: {String(query.error)}</div> : null}
            {query.isLoading && !data ? <div className="loading">Loading shared session…</div> : null}
            {data ? <InspectBody data={data} harnessHooks={query.data?.harness_hooks} /> : null}
        </section>
    );
}

export function ShareInspectView(props: { readonly owner: string; readonly gistId: string }) {
    const { owner, gistId } = props;
    const manifestQuery = useQuery({
        queryKey: ["share-manifest", owner, gistId],
        queryFn: () => fetchShareManifest(owner, gistId),
        ...IMMUTABLE_SHARE_QUERY,
    });

    if (manifestQuery.isLoading) {
        return (
            <section className="panel">
                <header><h2>Shared session inspect</h2></header>
                <div className="loading">Loading shared session…</div>
            </section>
        );
    }
    if (manifestQuery.error) {
        return (
            <section className="panel">
                <header><h2>Shared session inspect</h2></header>
                <div className="error">Error: {String(manifestQuery.error)}</div>
            </section>
        );
    }
    return manifestQuery.data
        ? <MultiFileShareView owner={owner} gistId={gistId} manifest={manifestQuery.data} />
        : <LegacyShareView owner={owner} gistId={gistId} />;
}
