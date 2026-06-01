import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import type {
    InspectTurnContentDto,
    InspectSpanKind,
    InspectTurnDto,
    SessionInspectPayload,
    SessionTokenUsageDetail,
    TurnTokenUsageDetail,
} from "@shared/dashboard-types.ts";
import { shortSessionId } from "@shared/session-id.ts";
import { FilterBar } from "./inspector-filter-bar.tsx";
import { InspectGuide, KIND_STYLE, Turn } from "./session-inspect.tsx";

interface ShareArtifact {
    readonly schema_version: 1;
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

export function rawSessionFileUrl(owner: string, gistId: string): string {
    return `https://gist.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(gistId)}/raw/ax-session.json`;
}

function validateArtifact(value: unknown): ShareArtifact {
    if (
        !isRecord(value) ||
        value.schema_version !== 1 ||
        !isRecord(value.session) ||
        typeof value.session.id !== "string" ||
        !isRecord(value.stats) ||
        !Array.isArray(value.turns)
    ) {
        throw new Error("Invalid session share artifact");
    }
    return value as ShareArtifact;
}

export async function fetchShareArtifact(owner: string, gistId: string): Promise<ShareArtifact> {
    const artifactResponse = await fetch(rawSessionFileUrl(owner, gistId));
    if (!artifactResponse.ok) throw new Error("Could not fetch ax-session.json");

    return validateArtifact(await artifactResponse.json());
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
        total_chars: totalChars,
        totals_by_kind: totals,
        token_usage: artifact.token_usage ?? null,
        total_turns: turns.length,
        turn_window: { offset: 0, limit: turns.length },
        turns,
        parent_session: null,
        parent_nickname: null,
        children: [],
        hook_fires: [],
        total_hook_fires: 0,
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

export function ShareInspectView(props: { readonly owner: string; readonly gistId: string }) {
    const { owner, gistId } = props;
    const query = useQuery({
        queryKey: ["share-inspect", owner, gistId],
        queryFn: () => fetchShareArtifact(owner, gistId),
    });
    const data = useMemo(
        () => query.data ? inspectPayloadFromShare(query.data, `gist:${owner}/${gistId}`) : null,
        [gistId, owner, query.data],
    );
    const [anchoredSeq, setAnchoredSeq] = useState<number | null>(() => hashSeq());
    const turnsRef = useRef<ReadonlyArray<InspectTurnDto>>([]);
    turnsRef.current = data?.turns ?? [];

    useEffect(() => {
        const onHashChange = () => setAnchoredSeq(hashSeq());
        window.addEventListener("hashchange", onHashChange);
        return () => window.removeEventListener("hashchange", onHashChange);
    }, []);

    useEffect(() => {
        if (anchoredSeq == null) return;
        document.getElementById(`turn-${anchoredSeq}`)?.scrollIntoView({
            behavior: "auto",
            block: "start",
        });
    }, [anchoredSeq, data?.turns.length]);

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
            {data ? (
                <>
                    <div style={{ padding: "8px 24px", color: "#64748b", fontSize: 12, fontFamily: "ui-monospace, monospace" }}>
                        {data.turns.length} turns · {data.total_chars.toLocaleString()} chars
                        {" · source: "}<code>{data.source_path}</code>
                    </div>
                    <FilterBar
                        turns={data.turns}
                        anchorSeqs={new Set()}
                        loadedCount={data.turns.length}
                        totalCount={data.total_turns}
                        appendLoading={false}
                        loadMore={() => Promise.resolve()}
                        getTurns={() => turnsRef.current}
                        getCurrentSeq={() => anchoredSeq}
                        hookFireIdxs={[]}
                        getHookFireIdxs={() => []}
                        totalHookFires={0}
                    />
                    <InspectGuide data={data} />
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", padding: "4px 24px 8px" }}>
                        {(Object.keys(KIND_STYLE) as InspectSpanKind[]).map((kind) => {
                            const c = KIND_STYLE[kind];
                            const n = data.totals_by_kind[kind] ?? 0;
                            const pct = data.total_chars > 0 ? ((n / data.total_chars) * 100).toFixed(1) : "0";
                            return (
                                <span key={kind} style={{ background: c.bg, color: c.fg, padding: "2px 10px", borderRadius: 4, fontSize: 11, fontWeight: 600, borderLeft: `3px solid ${c.bar}` }}>
                                    {c.label} <em style={{ fontStyle: "normal", opacity: 0.7, fontWeight: 400 }}>{pct}%</em>
                                </span>
                            );
                        })}
                    </div>
                    <div>
                        {data.turns.map((turn) => (
                            <Turn
                                key={turn.seq}
                                turn={turn}
                                anchored={anchoredSeq === turn.seq}
                            />
                        ))}
                    </div>
                </>
            ) : null}
        </section>
    );
}
