/**
 * Pure renderers over a QuotaSnapshot: human table (`ax quota`), one-line
 * statusline (`--statusline`, wired into the Claude Code statusLine command),
 * and SwiftBar/xbar plugin output (`--swiftbar`, menubar). All take nowMs +
 * an optional IANA timeZone so tests are deterministic.
 */
import type { QuotaSnapshot, QuotaWindow } from "./schema.ts";

export interface RenderOptions {
    readonly nowMs: number;
    /** IANA zone for reset times; defaults to the system zone. */
    readonly timeZone?: string;
}

const pct = (utilization: number): string => `${Math.round(utilization)}%`;

const DAY_MS = 24 * 60 * 60 * 1000;

/** "15:30" when the reset lands within 24h, "Thu 21:00" otherwise. */
export const fmtReset = (iso: string, options: RenderOptions): string => {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return "?";
    const date = new Date(ms);
    const time = date.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: options.timeZone,
    });
    if (ms - options.nowMs < DAY_MS) return time;
    const day = date.toLocaleDateString("en-US", {
        weekday: "short",
        timeZone: options.timeZone,
    });
    return `${day} ${time}`;
};

export const agoText = (fetchedAtIso: string, nowMs: number): string => {
    const ms = Date.parse(fetchedAtIso);
    if (!Number.isFinite(ms)) return "?";
    const seconds = Math.max(0, Math.round((nowMs - ms) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    return `${Math.round(minutes / 60)}h ago`;
};

interface LabeledWindow {
    readonly label: string;
    readonly window: QuotaWindow;
}

const labeledWindows = (snapshot: QuotaSnapshot): LabeledWindow[] => {
    const rows: LabeledWindow[] = [];
    if (snapshot.five_hour) rows.push({ label: "5h", window: snapshot.five_hour });
    if (snapshot.seven_day) rows.push({ label: "7d", window: snapshot.seven_day });
    if (snapshot.seven_day_opus) rows.push({ label: "7d opus", window: snapshot.seven_day_opus });
    if (snapshot.seven_day_sonnet) rows.push({ label: "7d sonnet", window: snapshot.seven_day_sonnet });
    return rows;
};

// ---------------------------------------------------------------------------
// ax quota (table)
// ---------------------------------------------------------------------------

export const renderQuotaTable = (
    snapshot: QuotaSnapshot,
    options: RenderOptions & { readonly sourceNote: string },
): string => {
    const rows = labeledWindows(snapshot);
    if (rows.length === 0) return "(usage endpoint returned no quota windows)";
    const lines: string[] = [];
    lines.push(`${"window".padEnd(10)}  ${"used".padStart(5)}  resets`);
    for (const { label, window } of rows) {
        lines.push(
            `${label.padEnd(10)}  ${pct(window.utilization).padStart(5)}  ${fmtReset(window.resets_at, options)}`,
        );
    }
    const extra = snapshot.extra_usage;
    if (extra !== null) {
        const detail =
            extra.is_enabled && extra.utilization !== null
                ? pct(extra.utilization)
                : extra.is_enabled
                    ? "on"
                    : "off";
        lines.push(`${"extra".padEnd(10)}  ${detail.padStart(5)}`);
    }
    lines.push("");
    lines.push(`(fetched ${agoText(snapshot.fetched_at, options.nowMs)}, ${options.sourceNote})`);
    return lines.join("\n");
};

// ---------------------------------------------------------------------------
// --statusline (one line, no ANSI - composes into any statusline command)
// ---------------------------------------------------------------------------

export const renderStatusline = (snapshot: QuotaSnapshot, options: RenderOptions): string => {
    const parts: string[] = [];
    if (snapshot.five_hour) {
        parts.push(
            `5h ${pct(snapshot.five_hour.utilization)} → ${fmtReset(snapshot.five_hour.resets_at, options)}`,
        );
    }
    if (snapshot.seven_day) {
        parts.push(`7d ${pct(snapshot.seven_day.utilization)}`);
    }
    return parts.length > 0 ? parts.join(" · ") : "quota n/a";
};

// ---------------------------------------------------------------------------
// --swiftbar (SwiftBar/xbar plugin body: title, ---, dropdown lines)
// ---------------------------------------------------------------------------

const TITLE_GLYPHS: ReadonlyArray<readonly [number, string]> = [
    [90, "●"],
    [75, "◕"],
    [50, "◑"],
    [25, "◔"],
    [0, "○"],
];

const titleGlyph = (utilization: number): string => {
    for (const [threshold, glyph] of TITLE_GLYPHS) {
        if (utilization >= threshold) return glyph;
    }
    return "○";
};

export const renderSwiftBar = (snapshot: QuotaSnapshot, options: RenderOptions): string => {
    const rows = labeledWindows(snapshot);
    const peak = Math.max(0, ...rows.map((r) => r.window.utilization));
    const color = peak >= 90 ? " | color=red" : peak >= 75 ? " | color=orange" : "";
    const headline = snapshot.five_hour ?? snapshot.seven_day;
    const title =
        headline === null
            ? "◌ quota n/a"
            : `${titleGlyph(peak)} ${pct(headline.utilization)}${color}`;
    const lines: string[] = [title, "---", "Claude plan usage"];
    for (const { label, window } of rows) {
        lines.push(
            `${label}: ${pct(window.utilization)} - resets ${fmtReset(window.resets_at, options)}`,
        );
    }
    const extra = snapshot.extra_usage;
    if (extra !== null) {
        lines.push(
            extra.is_enabled
                ? `extra usage: ${extra.utilization !== null ? pct(extra.utilization) : "on"}`
                : "extra usage: off",
        );
    }
    lines.push(`fetched ${agoText(snapshot.fetched_at, options.nowMs)}`);
    return lines.join("\n");
};
