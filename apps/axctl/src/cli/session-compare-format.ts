/**
 * Renderers for `ax sessions compare`. Table for humans (TTY), JSON for
 * machines. Layout: rows = metrics, columns = sessions. The winning cell on
 * each ranked axis is starred (`*`).
 */
import type {
    SessionCompareEntry,
    SessionComparePayload,
    SessionCompareTurn,
    SessionId,
} from "@ax/lib/shared/dashboard-types";
import { isEstimatedPricingSource } from "../metrics/cost-estimate.ts";

/** Lane tag for a session column, 1-indexed: [1], [2], … Synthetic subagent
 *  ids share a long common prefix, so a truncated short-id is ambiguous as a
 *  column header; the lane tag + legend keeps columns distinct at any N. */
const laneTag = (index: number): string => `[${index + 1}]`;

export const renderCompareJson = (payload: SessionComparePayload): string =>
    JSON.stringify(payload, null, 2);

const fmtDuration = (ms: number | null): string => {
    if (ms === null) return "-";
    const totalSec = Math.round(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
    if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
    return `${s}s`;
};

const fmtTokens = (n: number | null | undefined): string => {
    if (n === null || n === undefined) return "-";
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
};

/** `~$x.xx` when the cost was estimated at read time (pricing_source carries
 *  the `estimated:` provenance prefix - #175) vs. priced at ingest. */
const fmtCost = (n: number | null | undefined, pricingSource?: string | null): string =>
    n === null || n === undefined
        ? "-"
        : `${isEstimatedPricingSource(pricingSource) ? "~" : ""}$${n.toFixed(2)}`;

const fmtInt = (n: number | null | undefined): string =>
    n === null || n === undefined ? "-" : String(n);

interface MetricRow {
    readonly label: string;
    readonly values: ReadonlyArray<string>;
    /** Index of the winning session column, or null for unranked rows. */
    readonly winner: number | null;
}

const winnerIndex = (
    entries: ReadonlyArray<SessionCompareEntry>,
    winnerId: SessionId | null,
): number | null => {
    if (winnerId === null) return null;
    const idx = entries.findIndex((e) => e.session_id === winnerId);
    return idx >= 0 ? idx : null;
};

/** Lane tag for a winner id, or null when no winner / not present. */
const winnerLane = (
    entries: ReadonlyArray<SessionCompareEntry>,
    winnerId: SessionId | null,
): string | null => {
    const idx = winnerIndex(entries, winnerId);
    return idx === null ? null : laneTag(idx);
};

const buildRows = (payload: SessionComparePayload): ReadonlyArray<MetricRow> => {
    const s = payload.sessions;
    const col = <T,>(pick: (entry: SessionCompareEntry) => T): ReadonlyArray<T> =>
        s.map(pick);
    return [
        { label: "source", values: col((e) => e.source), winner: null },
        { label: "model", values: col((e) => e.model ?? "-"), winner: null },
        {
            label: "duration",
            values: col((e) => fmtDuration(e.duration_ms)),
            winner: winnerIndex(s, payload.winners.fastest),
        },
        {
            label: "turns",
            values: col((e) => fmtInt(e.health?.turns ?? null)),
            winner: null,
        },
        {
            label: "tokens",
            values: col((e) => fmtTokens(e.token_usage?.estimated_tokens ?? null)),
            winner: winnerIndex(s, payload.winners.fewest_tokens),
        },
        {
            label: "cost",
            values: col((e) =>
                fmtCost(
                    e.token_usage?.estimated_cost_usd ?? null,
                    e.token_usage?.pricing_source ?? null,
                )),
            winner: winnerIndex(s, payload.winners.cheapest),
        },
        {
            label: "tool calls",
            values: col((e) => fmtInt(e.health?.tool_calls ?? null)),
            winner: null,
        },
        {
            label: "tool errors",
            values: col((e) => fmtInt(e.health?.tool_errors ?? null)),
            winner: null,
        },
        {
            label: "corrections",
            values: col((e) => fmtInt(e.health?.user_corrections ?? null)),
            winner: null,
        },
        {
            label: "interruptions",
            values: col((e) => fmtInt(e.health?.interruptions ?? null)),
            winner: null,
        },
        {
            label: "noise (err+corr+int)",
            values: col((e) => fmtInt(e.noise_score)),
            winner: winnerIndex(s, payload.winners.cleanest),
        },
        {
            label: "commits",
            values: col((e) => fmtInt(e.commit_count)),
            winner: null,
        },
    ];
};

const pad = (text: string, width: number): string =>
    text + " ".repeat(Math.max(0, width - text.length));

const fmtTurnGap = (ms: number | null): string => {
    if (ms === null) return "";
    const s = Math.round(ms / 1000);
    if (s >= 60) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}`;
    return `${s}s`;
};

/** Per-turn appendix: index-aligned lanes (turn N of session [1] vs turn N of
 *  [2] …). Cell = tokens + optional gap, `!` flags an error turn. Empty cell
 *  when a session has no turn at that index (ragged → padded). Returns [] when
 *  no session carries per-turn data. */
const renderTurnsBlock = (
    sessions: ReadonlyArray<SessionCompareEntry>,
): ReadonlyArray<string> => {
    const lanes = sessions.map((e) => e.turns ?? null);
    if (!lanes.some((l) => l !== null && l.length > 0)) return [];

    const maxTurns = Math.max(...lanes.map((l) => l?.length ?? 0));

    const cell = (turn: SessionCompareTurn | undefined): string => {
        if (!turn) return "";
        const tok = fmtTokens(turn.est_tokens);
        const gap = fmtTurnGap(turn.gap_ms);
        const base = gap ? `${tok} ${gap}` : tok;
        return turn.has_error ? `${base} !` : base;
    };

    const headers = ["turn", ...sessions.map((_, i) => laneTag(i))];
    const body: string[][] = [];
    for (let i = 0; i < maxTurns; i++) {
        body.push([
            String(i + 1),
            ...lanes.map((lane) => cell(lane?.[i])),
        ]);
    }

    const widths = headers.map((h, c) =>
        Math.max(h.length, ...body.map((r) => r[c]!.length)),
    );
    const renderLine = (cells: ReadonlyArray<string>): string =>
        cells.map((c, i) => pad(c, widths[i]!)).join(" | ");

    const lines: string[] = [];
    lines.push("");
    lines.push("Per-turn (index-aligned · cell = tokens [gap], ! = error turn)");
    lines.push(renderLine(headers));
    lines.push(widths.map((w) => "-".repeat(w)).join("-+-"));
    for (const r of body) lines.push(renderLine(r));
    return lines;
};

export const renderCompareTable = (payload: SessionComparePayload): string => {
    const sessions = payload.sessions;
    const lines: string[] = [];

    const taskLine = payload.task_label
        ? `task: ${payload.task_label}`
        : "task: (mixed / unlabeled)";
    lines.push(`Comparing ${sessions.length} sessions  ·  ${taskLine}`);

    // Legend maps each lane tag to its full session id (+ project), so the
    // table can use compact, unambiguous [n] column headers.
    for (let i = 0; i < sessions.length; i++) {
        const e = sessions[i]!;
        const project = e.project ? `  (${e.project})` : "";
        lines.push(`  ${laneTag(i)} ${e.session_id}${project}`);
    }
    lines.push("");

    // Cell text per row, winner star applied.
    const headers = ["metric", ...sessions.map((_, i) => laneTag(i))];
    const rows = buildRows(payload);
    const body: string[][] = rows.map((row) => [
        row.label,
        ...row.values.map((v, i) => (row.winner === i ? `${v} *` : v)),
    ]);

    // Column widths across header + body.
    const colCount = headers.length;
    const widths = Array.from({ length: colCount }, (_, c) =>
        Math.max(headers[c]!.length, ...body.map((r) => r[c]!.length)),
    );

    const renderLine = (cells: ReadonlyArray<string>): string =>
        cells.map((cell, c) => pad(cell, widths[c]!)).join(" | ");

    lines.push(renderLine(headers));
    lines.push(widths.map((w) => "-".repeat(w)).join("-+-"));
    for (const r of body) lines.push(renderLine(r));

    lines.push("");
    const w = payload.winners;
    const winnerBits: string[] = [];
    const fastest = winnerLane(sessions, w.fastest);
    const cheapest = winnerLane(sessions, w.cheapest);
    const fewest = winnerLane(sessions, w.fewest_tokens);
    const cleanest = winnerLane(sessions, w.cleanest);
    if (fastest) winnerBits.push(`fastest ${fastest}`);
    if (cheapest) winnerBits.push(`cheapest ${cheapest}`);
    if (fewest) winnerBits.push(`fewest tokens ${fewest}`);
    if (cleanest) winnerBits.push(`cleanest ${cleanest}`);
    lines.push(winnerBits.length > 0 ? `Winners: ${winnerBits.join(" · ")}` : "Winners: (no clear winner)");

    if (sessions.some((e) => isEstimatedPricingSource(e.token_usage?.pricing_source))) {
        lines.push("~ = cost estimated from token counts × model pricing (not provider-reported)");
    }

    if (payload.not_found.length > 0) {
        lines.push(`Not found: ${payload.not_found.join(", ")}`);
    }

    lines.push(...renderTurnsBlock(sessions));

    return lines.join("\n");
};
