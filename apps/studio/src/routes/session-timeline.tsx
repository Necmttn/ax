/**
 * The "highlight" zoom level for a session - L2 segments (phases) each with a
 * rollup, and the L1 important events nested under them. Fed by the LLM-free
 * SessionTimelineService via /api/sessions/:id/timeline. Sits one level up from
 * the raw transcript inspector.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type SessionTimelinePayload, type TimelineEvent, type TimelineEventKind, type TimelineSegment } from "../api.ts";

const KIND_GLYPH: Record<TimelineEventKind, string> = {
    decision: "◆", tool_call: "⚙", file_edit: "✎", skill_invocation: "↳",
    failure: "✖", correction: "⟲", checkpoint: "⎉", outcome: "★",
};
const KIND_COLOR: Record<TimelineEventKind, string> = {
    decision: "var(--gold)", tool_call: "var(--blue)", file_edit: "var(--green)",
    skill_invocation: "var(--blue)", failure: "var(--red)", correction: "var(--gold)",
    checkpoint: "var(--green)", outcome: "var(--green)",
};
const BOUNDARY_LABEL: Record<TimelineSegment["boundary"], string> = {
    session_start: "start", ask: "ask", commit: "commit", compaction: "compacted", time_gap: "resumed",
};

const fmtDur = (ms: number | null): string => {
    if (ms == null) return "";
    if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
    if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
    return `${Math.round(ms / 1000)}s`;
};
const fmtUsd = (n: number | null): string => (n == null ? "" : `$${n.toFixed(2)}`);

function Stat({ n, label }: { n: string; label: string }) {
    return (
        <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <b style={{ fontSize: 15, color: "var(--ink)", fontVariantNumeric: "tabular-nums" }}>{n}</b>
            <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted)" }}>{label}</span>
        </span>
    );
}

function EventRow({ e }: { e: TimelineEvent }) {
    const color = KIND_COLOR[e.kind];
    // Tool/edit rows dominate a segment - repeating their uppercase label per
    // row is over-labeling (the glyph + color already encode the kind, the
    // hover carries the word). Keep the text label for the rarer, story-level
    // kinds where the word IS the signal.
    const showLabel = e.kind !== "tool_call" && e.kind !== "file_edit";
    return (
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "3px 0", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 }}>
            <span title={e.kind.replace("_", " ")} style={{ color, width: 14, textAlign: "center", flex: "0 0 auto" }}>{KIND_GLYPH[e.kind]}</span>
            <span style={{ color: "var(--muted)", textTransform: "uppercase", fontSize: 10, letterSpacing: "0.04em", flex: "0 0 92px" }}>
                {showLabel ? e.kind.replace("_", " ") : ""}
            </span>
            <span style={{ color: "var(--ink)", minWidth: 0, overflowWrap: "anywhere" }}>
                {e.title}
                {e.recovered_by_seq != null ? (
                    <span style={{ color: "var(--green)", marginLeft: 6 }}>→ fixed #{e.recovered_by_seq}</span>
                ) : null}
            </span>
            {e.seq != null ? (
                <a href={`#turn-${e.seq}`} style={{ marginLeft: "auto", flex: "0 0 auto", color: "var(--blue)", fontSize: 11, textDecoration: "none", padding: "4px 0 4px 8px" }}>
                    → turn {e.seq}
                </a>
            ) : null}
        </div>
    );
}

function SegmentBlock({ seg, events }: { seg: TimelineSegment; events: ReadonlyArray<TimelineEvent> }) {
    const r = seg.rollup;
    const parts = [
        r.tool_calls ? `${r.tool_calls} tools` : null,
        r.file_edits ? `${r.file_edits} edits${r.files ? `/${r.files}f` : ""}` : null,
        r.failures ? `${r.failures} fail${r.recovered ? `·${r.recovered} fixed` : ""}` : null,
        r.decisions ? `${r.decisions} dec` : null,
        r.checkpoints ? `${r.checkpoints} commit` : null,
        r.corrections ? `${r.corrections} corr` : null,
    ].filter(Boolean);
    return (
        <div style={{ borderLeft: "3px solid var(--line)", paddingLeft: 14, marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted)", background: "var(--track)", padding: "1px 7px", borderRadius: 3 }}>
                    {BOUNDARY_LABEL[seg.boundary]}
                </span>
                <span style={{ fontFamily: "Georgia, serif", fontSize: 15, color: "var(--ink)", minWidth: 0, overflowWrap: "anywhere" }}>{seg.title}</span>
                <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--muted)", fontFamily: "ui-monospace, monospace" }}>
                    {fmtDur(seg.duration_ms)}{seg.event_count ? ` · ${seg.event_count} evts` : ""}
                </span>
            </div>
            {parts.length > 0 ? (
                <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "ui-monospace, monospace", margin: "3px 0 6px" }}>
                    {parts.join("  ·  ")}
                </div>
            ) : null}
            <div>{events.map((e, i) => <EventRow key={`${e.kind}-${e.seq}-${i}`} e={e} />)}</div>
        </div>
    );
}

function Highlights({ data }: { data: SessionTimelinePayload }) {
    const h = data.highlights;
    const sub = [h.model, h.repository, h.started_at?.slice(0, 10)].filter(Boolean).join(" · ");
    return (
        <div style={{ background: "var(--track)", borderLeft: "4px solid var(--green)", padding: "14px 18px", marginBottom: 16 }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted)", fontFamily: "ui-monospace, monospace" }}>{sub}</div>
            <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 12, fontFamily: "ui-monospace, monospace" }}>
                <Stat n={fmtDur(h.duration_ms) || "-"} label="duration" />
                <Stat n={h.turns.toLocaleString()} label="turns" />
                <Stat n={h.tool_calls.toLocaleString()} label="tools" />
                <Stat n={h.files_changed.toLocaleString()} label="files" />
                {h.tool_errors ? <Stat n={String(h.tool_errors)} label="failures" /> : null}
                {fmtUsd(h.cost_usd) ? <Stat n={fmtUsd(h.cost_usd)} label="cost" /> : null}
                <Stat n={`${data.segments.length}`} label="segments" />
                <Stat n={data.events.length.toLocaleString()} label="key events" />
            </div>
        </div>
    );
}

/** Pure presentational timeline (highlights + segments). Shared by the live
 *  daemon-backed view below and the static share viewer, which reads a
 *  precomputed `session_timeline` straight off the gist artifact. */
export function SessionTimelineBody({ data }: { readonly data: SessionTimelinePayload }) {
    const eventsBySegment = useMemo(() => {
        const m = new Map<string, TimelineEvent[]>();
        for (const e of data.events) {
            const id = e.segment_id ?? "seg-0";
            (m.get(id) ?? m.set(id, []).get(id)!).push(e);
        }
        return m;
    }, [data]);

    return (
        <div style={{ padding: "8px 24px 40px" }}>
            <Highlights data={data} />
            {data.segments.map((seg) => (
                <SegmentBlock key={seg.id} seg={seg} events={eventsBySegment.get(seg.id) ?? []} />
            ))}
        </div>
    );
}

export function SessionTimelineView({ sessionId }: { readonly sessionId: string }) {
    const q = useQuery({
        queryKey: ["session-timeline", sessionId],
        queryFn: () => api.sessionTimeline(sessionId),
        staleTime: 60_000,
    });

    if (q.isLoading) return <div className="loading" style={{ padding: 24 }}>Building timeline…</div>;
    if (q.error) return <div className="error" style={{ padding: 24 }}>Error: {String(q.error)}</div>;
    if (!q.data) return null;

    return <SessionTimelineBody data={q.data} />;
}
