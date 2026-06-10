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
    padding: "8px var(--strip-x)",
    background: "var(--page)",
    borderTop: "1px solid var(--line)",
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

/** Outcome-first header for a shared session: what it did + the headline stats,
 *  so a cold reader gets the story before the transcript. */
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
}) {
    const cost = fmtUsd(props.costUsd);
    const duration = fmtDuration(props.durationMs);
    const date = fmtShareDate(props.startedAt);
    const sub = [props.model ?? props.source, props.project, date].filter(Boolean).join(" · ");
    const stat = (n: string, label: string) => (
        <span className="share-hero-stat"><b>{n}</b><span>{label}</span></span>
    );
    // Hero totals roll up the whole spawn tree; the cost rail below counts
    // only the session on screen - qualify the labels so the two figures
    // don't read as a contradiction.
    const all = props.subagents > 0 ? " (incl. subagents)" : "";
    return (
        <div className="share-hero">
            <h2 className="share-hero-title">{cleanShareSummary(props.summary) ?? "Shared agent session"}</h2>
            {sub ? <div className="share-hero-sub">{sub}</div> : null}
            <div className="share-hero-stats">
                {stat(props.turns.toLocaleString(), `turns${all}`)}
                {stat(props.toolCalls.toLocaleString(), "tool calls")}
                {stat(props.files.toLocaleString(), "files")}
                {props.subagents > 0 ? stat(props.subagents.toLocaleString(), "subagents") : null}
                {cost ? stat(cost, `cost${all}`) : null}
                {duration ? stat(duration, "duration") : null}
                <span className="share-hero-outcome" style={{ color: props.failures > 0 ? "var(--red)" : "var(--green)" }}>
                    {props.failures > 0 ? `✗ ${props.failures} failed tool calls` : "✓ no failed tool calls"}
                </span>
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
                />
            )}
            {directChildren.length > 0 ? (
                <div style={SUBAGENT_BAR_STYLE}>
                    <span style={{
                        display: "block",
                        font: "700 10px/1 ui-monospace, monospace",
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                        color: "var(--muted)",
                        margin: "2px 0 8px",
                    }}>
                        ↓ {directChildren.length} subagent session{directChildren.length === 1 ? "" : "s"} - tap to open
                    </span>
                    <span style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {directChildren.slice(0, 8).map((c) => (
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
                        {directChildren.length > 8 ? (
                            <span style={{ alignSelf: "center", color: "var(--muted)", fontFamily: "ui-monospace, monospace" }}>
                                +{directChildren.length - 8} more inline ↓
                            </span>
                        ) : null}
                    </span>
                </div>
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
                            {mode}
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
