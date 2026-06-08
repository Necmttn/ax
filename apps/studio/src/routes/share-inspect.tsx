import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import type {
    HookFireDto,
    InspectTurnContentDto,
    InspectSpanKind,
    InspectTurnDto,
    SessionInspectPayload,
    SessionTokenUsageDetail,
    TurnTokenUsageDetail,
} from "@ax/lib/shared/dashboard-types";
import { shortSessionId } from "@ax/lib/shared/session-id";
import { spliceHookFires } from "@ax/lib/shared/hook-fire-splice";
import { FilterBar } from "./inspector-filter-bar.tsx";
import { DockedRail, HookFireMarker, InspectGuide, KIND_STYLE, Turn, useInspectSelection, useVisibleTurnSeq } from "./session-inspect.tsx";

type ShareSchemaVersion = 1 | 2 | 3;

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

const SUPPORTED_VERSIONS = new Set<number>([1, 2, 3]);

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
    readonly schema_version: 3;
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
        value.schema_version === 3 &&
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
}: {
    readonly data: SessionInspectPayload;
    readonly subagentsByTurn?: ReadonlyMap<number, ReadonlyArray<ShareSubagentCard>>;
    readonly harnessHooks?: ReadonlyArray<ShareHarnessHookView>;
    readonly onSelectSubagent?: (file: string) => void;
    readonly onPrefetchSubagent?: (file: string) => void;
}) {
    const [anchoredSeq, setAnchoredSeq] = useState<number | null>(() => hashSeq());
    const turnsRef = useRef<ReadonlyArray<InspectTurnDto>>([]);
    turnsRef.current = data.turns;
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

    useEffect(() => {
        if (anchoredSeq == null) return;
        document.getElementById(`turn-${anchoredSeq}`)?.scrollIntoView({ behavior: "auto", block: "start" });
    }, [anchoredSeq, data.turns.length]);

    return (
        <>
            <div style={{ padding: "8px 24px", color: "#64748b", fontSize: 12, fontFamily: "ui-monospace, monospace" }}>
                {data.turns.length} turns · {data.total_chars.toLocaleString()} chars
                {" · source: "}<code>{data.source_path}</code>
            </div>
            <FilterBar
                turns={data.turns}
                anchorSeqs={spawnAnchorSeqs}
                loadedCount={data.turns.length}
                totalCount={data.total_turns}
                appendLoading={false}
                loadMore={() => Promise.resolve()}
                getTurns={() => turnsRef.current}
                getCurrentSeq={() => anchoredSeq}
                hookFireIdxs={hookFireIdxs}
                getHookFireIdxs={() => hookFireIdxsRef.current}
                totalHookFires={data.total_hook_fires + (harnessHooks?.length ?? 0)}
            />
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
                        const spawned = subagentsByTurn?.get(turn.seq);
                        const hooks = harnessByTurn.get(turn.seq);
                        return (
                            // content-visibility virtualizes paint/layout for
                            // off-screen turns while keeping every turn in the
                            // DOM, so #turn-N anchors, jumps, find, and the cost
                            // rail keep working on huge (100k+ px) transcripts.
                            <div
                                key={`turn-${turn.seq}`}
                                style={{ contentVisibility: "auto", containIntrinsicSize: "auto 200px" }}
                            >
                                <Turn
                                    turn={turn}
                                    anchored={anchoredSeq === turn.seq}
                                    activeTarget={selection?.turnSeq === turn.seq ? selection.target : null}
                                    onInspect={setSelection}
                                />
                                {hooks && hooks.length > 0 ? (
                                    <div style={{ padding: "2px 24px 4px" }}>
                                        {hooks.map((hook) => (
                                            <HarnessHookMarker key={`hh-${hook.idx}`} hook={hook} />
                                        ))}
                                    </div>
                                ) : null}
                                {spawned && spawned.length > 0 ? (
                                    <div style={{ padding: "2px 24px 6px" }}>
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
                            </div>
                        );
                    })}
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

const SUBAGENT_BAR_STYLE: CSSProperties = {
    padding: "6px 24px",
    background: "#fff1f2",
    borderTop: "1px solid #fecdd3",
    borderBottom: "1px solid #fecdd3",
    fontSize: 12,
};

const SUBAGENT_LINK_STYLE: CSSProperties = {
    background: "transparent",
    border: "none",
    padding: 0,
    cursor: "pointer",
    color: "#9f1239",
    fontFamily: "ui-monospace, monospace",
    fontSize: 12,
    textDecoration: "underline",
};

/** DOM-id offset so harness-hook markers don't collide with file-context
 *  hook_fire markers (both use `hook-<n>` ids for the shared jump). */
const HARNESS_HOOK_IDX_BASE = 1_000_000;

const HARNESS_EFFECT_TONE: Record<string, { bg: string; fg: string; bar: string }> = {
    blocked: { bg: "#fef2f2", fg: "#991b1b", bar: "#ef4444" },
    modified_input: { bg: "#fffbeb", fg: "#92400e", bar: "#f59e0b" },
    injected_context: { bg: "#ecfdf5", fg: "#065f46", bar: "#10b981" },
    notified: { bg: "#eff6ff", fg: "#1e40af", bar: "#3b82f6" },
};

/** Inline marker for a harness hook that did something (blocked / modified /
 *  injected). Shows the guardrail activity inline in the shared transcript. */
function HarnessHookMarker(props: { readonly hook: ShareHarnessHookView }) {
    const { hook } = props;
    const tone = HARNESS_EFFECT_TONE[hook.effect] ?? { bg: "#f8fafc", fg: "#334155", bar: "#94a3b8" };
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
function ShareSpawnMarker(props: {
    readonly card: ShareSubagentCard;
    readonly onSelect: () => void;
    readonly onPrefetch: () => void;
}) {
    const { card } = props;
    const cost = fmtUsd(card.cost_usd);
    const duration = fmtDuration(card.duration_ms);
    return (
        <button
            type="button"
            onClick={props.onSelect}
            onMouseEnter={props.onPrefetch}
            onFocus={props.onPrefetch}
            style={{
                display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
                width: "100%", textAlign: "left", cursor: "pointer",
                margin: "4px 0", padding: "7px 10px", background: "#fff1f2",
                border: "1px solid #fecdd3", borderLeft: "4px solid #e11d48", borderRadius: 3,
                fontSize: 11, fontFamily: "ui-monospace, monospace", color: "#9f1239",
            }}
        >
            <span style={{ fontWeight: 700 }}>↳ spawned subagent</span>
            <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 420 }}>
                {card.task_label ? `"${card.task_label}"` : `${card.id.slice(0, 24)}…`}
            </span>
            <span style={{ background: "#fecdd3", color: "#7f1d1d", padding: "0 6px", borderRadius: 2, fontSize: 10, fontWeight: 600 }}>
                {card.model ?? card.source}
            </span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                {cost ? <span>{cost}</span> : null}
                {duration ? <span>{duration}</span> : null}
                <span>{card.stats.turns} turns</span>
                <span style={{ opacity: 0.7 }}>open →</span>
            </span>
        </button>
    );
}

/** v3 multi-file share: manifest-first render + lazy/prefetch session files. */
function MultiFileShareView(props: {
    readonly owner: string;
    readonly gistId: string;
    readonly manifest: ShareManifest;
}) {
    const { owner, gistId, manifest } = props;
    const qc = useQueryClient();
    const [selectedFile, setSelectedFile] = useState<string>(manifest.root_file);

    const fileQuery = useQuery({
        queryKey: ["share-file", owner, gistId, selectedFile],
        queryFn: () => fetchShareFile(owner, gistId, selectedFile),
    });
    const data = useMemo(
        () => fileQuery.data ? inspectPayloadFromShare(fileQuery.data, `gist:${owner}/${gistId}/${selectedFile}`) : null,
        [fileQuery.data, owner, gistId, selectedFile],
    );

    const prefetch = (file: string) =>
        qc.prefetchQuery({
            queryKey: ["share-file", owner, gistId, file],
            queryFn: () => fetchShareFile(owner, gistId, file),
        });

    const totals = manifest.totals;
    const totalCost = fmtUsd(totals.cost_usd);
    const totalDuration = fmtDuration(totals.duration_ms);

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
                    {" · gist share · "}
                    {totals.subagents} subagent{totals.subagents === 1 ? "" : "s"}
                    {totalCost ? ` · ${totalCost}` : ""}
                    {totalDuration ? ` · ${totalDuration}` : ""}
                </span>
            </header>
            {directChildren.length > 0 ? (
                <div style={SUBAGENT_BAR_STYLE}>
                    <strong style={{ color: "#9f1239" }}>
                        ↓ spawned {directChildren.length} subagent{directChildren.length === 1 ? "" : "s"}
                    </strong>
                    <span style={{ marginLeft: 12, color: "#9f1239", opacity: 0.85 }}>
                        {directChildren.slice(0, 8).map((c, i) => (
                            <span key={c.id}>
                                {i > 0 ? " · " : " "}
                                <button
                                    type="button"
                                    onClick={() => setSelectedFile(c.file)}
                                    onMouseEnter={() => prefetch(c.file)}
                                    onFocus={() => prefetch(c.file)}
                                    style={SUBAGENT_LINK_STYLE}
                                >
                                    {c.task_label ? `"${c.task_label.slice(0, 40)}${c.task_label.length > 40 ? "…" : ""}"` : `${shortSessionId(c.id)}…`}
                                    {fmtUsd(c.cost_usd) ? ` (${fmtUsd(c.cost_usd)})` : ""}
                                </button>
                            </span>
                        ))}
                        {directChildren.length > 8 ? <span> · …+{directChildren.length - 8}</span> : null}
                    </span>
                </div>
            ) : null}
            {selectedCard ? (
                <div style={SUBAGENT_BAR_STYLE}>
                    <button
                        type="button"
                        onClick={() => setSelectedFile(parentFile)}
                        onMouseEnter={() => prefetch(parentFile)}
                        style={{ ...SUBAGENT_LINK_STYLE, fontWeight: 700 }}
                    >
                        ↑ back to {parentLabel}
                    </button>
                    <span style={{ color: "#9f1239", marginLeft: 8, opacity: 0.7 }}>
                        Viewing subagent{selectedCard.task_label ? `: "${selectedCard.task_label.slice(0, 60)}${selectedCard.task_label.length > 60 ? "…" : ""}"` : ""}.
                    </span>
                </div>
            ) : null}
            {fileQuery.error ? <div className="error">Error: {String(fileQuery.error)}</div> : null}
            {fileQuery.isLoading && !data ? <div className="loading">Loading session…</div> : null}
            {data ? (
                <InspectBody
                    data={data}
                    subagentsByTurn={subagentsByTurn}
                    harnessHooks={fileQuery.data?.harness_hooks}
                    onSelectSubagent={setSelectedFile}
                    onPrefetchSubagent={prefetch}
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
