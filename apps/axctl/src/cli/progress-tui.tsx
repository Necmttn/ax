/**
 * OpenTUI-based ingest progress UI. Replaces the hand-rolled ANSI renderer
 * (`PipelineProgress` in `progress.ts`) for interactive TTY runs. Renders the
 * progress board in a pinned `split-footer` region so terminal scrollback
 * above stays intact.
 *
 * Use via `initTuiProgress(opts)` from CLI code: returns a `ProgressReporter`
 * plus a `teardown()` to clear the pinned region and unmount React. The
 * existing non-TTY paths (plain, json, off) keep using `createProgressReporter`.
 */

import { useSyncExternalStore } from "react";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import type { ProgressReporter, ProgressStage } from "./progress.ts";
import { computeStageMetrics } from "./progress.ts";

type Status = "pending" | "running" | "done" | "failed";

interface StageView {
    readonly source: string;
    readonly stage: string;
    status: Status;
    counts: Record<string, number>;
    startedAt?: number;
    finishedAt?: number;
    error?: string;
}

interface StoreState {
    readonly stages: StageView[];
    readonly startedAt: number;
    readonly now: number;
    readonly frame: number;
}

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const countDisplayOrder = [
    "files", "bytes", "lines", "fileTurns", "fileToolCalls", "activeFiles",
    "sessions", "subagents", "written", "missingParent", "skippedExisting",
    "turns", "toolCalls", "tool_calls", "invocations", "commits", "repos",
    "produced", "touched", "edits", "planSnapshots", "skills", "commands",
    "count", "insights", "signals", "pairs", "recoveries",
] as const;

const formatCount = (n: number) => Math.round(n).toLocaleString("en-US");
const formatBytes = (v: number): string => {
    if (!Number.isFinite(v) || v <= 0) return "0B";
    if (v < 1024) return `${Math.round(v)}B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)}KiB`;
    if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)}MiB`;
    return `${(v / 1024 / 1024 / 1024).toFixed(1)}GiB`;
};
const formatMetric = (k: string, v: number) =>
    k.toLowerCase().includes("bytes") ? formatBytes(v) : formatCount(v);
const formatDuration = (ms: number): string => {
    if (!Number.isFinite(ms) || ms < 0) return "--";
    if (ms < 1000) return `${Math.max(0.1, ms / 1000).toFixed(1)}s`;
    const sec = Math.round(ms / 1000);
    const min = Math.floor(sec / 60);
    const s = sec % 60;
    return min === 0 ? `${s}s` : `${min}:${String(s).padStart(2, "0")}`;
};

const ROW_KEYS = [
    "records", "files", "sessions", "subagents", "turns", "toolCalls",
    "tool_calls", "skills", "commands", "count", "commits", "insights",
    "signals", "pairs", "recoveries",
];
const totalRows = (counts: Record<string, number>): number => {
    for (const k of ROW_KEYS) {
        const v = counts[k];
        if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    }
    return 0;
};

const stageKey = (s: ProgressStage) => `${s.source}/${s.stage}`;

const summarizeCounts = (counts: Record<string, number>): string => {
    const phase = typeof counts.phase === "number"
        ? counts.phase === 1 ? "reading"
        : counts.phase === 2 ? "writing"
        : counts.phase === 3 ? "snapshotting" : "working"
        : "";
    const status = typeof counts.currentFile === "number" && typeof counts.totalFiles === "number"
        ? `${phase ? `${phase} ` : "processing "}${formatCount(counts.currentFile)}/${formatCount(counts.totalFiles)}${
            typeof counts.currentFileBytes === "number" ? ` (${formatBytes(counts.currentFileBytes)})` : ""
        }`
        : typeof counts.currentSubagent === "number" && typeof counts.totalSubagents === "number"
        ? `${phase ? `${phase} ` : "processing "}${formatCount(counts.currentSubagent)}/${formatCount(counts.totalSubagents)} subagents`
        : typeof counts.totalFiles === "number"
        ? `discovered ${formatCount(counts.totalFiles)} files${
            typeof counts.totalBytes === "number" ? ` / ${formatBytes(counts.totalBytes)}` : ""
        }`
        : typeof counts.totalSubagents === "number"
        ? `discovered ${formatCount(counts.totalSubagents)} subagents`
        : phase ? `${phase} work` : "";
    const entries = Object.entries(counts)
        .filter(([k]) => ![
            "currentFile", "totalFiles", "currentFileBytes", "totalBytes",
            "currentSubagent", "totalSubagents", "records", "phase",
        ].includes(k))
        .filter(([, v]) => Number.isFinite(v))
        .sort(([a], [b]) => {
            const ai = countDisplayOrder.indexOf(a as (typeof countDisplayOrder)[number]);
            const bi = countDisplayOrder.indexOf(b as (typeof countDisplayOrder)[number]);
            if (ai !== -1 || bi !== -1) {
                return (ai === -1 ? Number.POSITIVE_INFINITY : ai)
                    - (bi === -1 ? Number.POSITIVE_INFINITY : bi);
            }
            return a.localeCompare(b);
        });
    if (entries.length === 0) return status;
    const summary = entries.slice(0, 4)
        .map(([k, v]) => `${k}=${formatMetric(k, v)}`)
        .join(" ");
    return status ? `${status}  ${summary}` : summary;
};

const runningBar = (ratio: number | undefined, frame: number): string => {
    const width = 20;
    if (ratio !== undefined) {
        const filled = Math.max(1, Math.round(ratio * width));
        return "█".repeat(filled) + "░".repeat(width - filled);
    }
    const pos = frame % width;
    return Array.from({ length: width }, (_, i) =>
        Math.abs(i - pos) <= 1 ? "█" : "░",
    ).join("");
};

class ProgressStore {
    private listeners = new Set<() => void>();
    private snapshot: StoreState;

    constructor(stages: readonly ProgressStage[], startedAt: number) {
        this.snapshot = {
            stages: stages.map((s) => ({ ...s, status: "pending", counts: {} })),
            startedAt,
            now: startedAt,
            frame: 0,
        };
    }

    subscribe = (fn: () => void): (() => void) => {
        this.listeners.add(fn);
        return () => { this.listeners.delete(fn); };
    };

    getSnapshot = (): StoreState => this.snapshot;

    private emit(): void {
        this.snapshot = { ...this.snapshot, stages: this.snapshot.stages.slice() };
        this.listeners.forEach((fn) => fn());
    }

    private findOrCreate(stage: ProgressStage): StageView {
        const existing = this.snapshot.stages.find(
            (s) => s.source === stage.source && s.stage === stage.stage,
        );
        if (existing) return existing;
        const created: StageView = { ...stage, status: "pending", counts: {} };
        this.snapshot.stages.push(created);
        return created;
    }

    start(stage: ProgressStage, now: number): void {
        const s = this.findOrCreate(stage);
        s.status = "running";
        s.startedAt = now;
        this.emit();
    }

    update(stage: ProgressStage, counts: Record<string, number>, now: number): void {
        const s = this.findOrCreate(stage);
        if (s.status === "pending") { s.status = "running"; s.startedAt = now; }
        s.counts = counts;
        this.emit();
    }

    finish(stage: ProgressStage, counts: Record<string, number>, now: number): void {
        const s = this.findOrCreate(stage);
        s.status = "done";
        s.finishedAt = now;
        s.counts = counts;
        this.emit();
    }

    fail(stage: ProgressStage, message: string, now: number): void {
        const s = this.findOrCreate(stage);
        s.status = "failed";
        s.finishedAt = now;
        s.error = message;
        this.emit();
    }

    tick(now: number): void {
        this.snapshot = { ...this.snapshot, now, frame: (this.snapshot.frame + 1) % spinnerFrames.length };
        this.listeners.forEach((fn) => fn());
    }
}

interface ViewProps {
    readonly store: ProgressStore;
    readonly command: string;
    readonly runId: string;
}

function IngestProgressView({ store, command, runId }: ViewProps) {
    const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const { stages, startedAt, now, frame } = state;
    const elapsed = now - startedAt;
    const done = stages.filter((s) => s.status === "done").length;
    const total = stages.length;
    const running = stages.filter((s) => s.status === "running");
    const currentLabel = running.length > 0 ? running.map(stageKey).join(" + ") : "idle";
    const observedRows = stages.reduce((sum, s) => sum + totalRows(s.counts), 0);
    const speed = elapsed > 0 ? observedRows / (elapsed / 1000) : 0;
    const eta = done > 0 && done < total ? formatDuration((elapsed / done) * (total - done)) : "--";
    const labelW = Math.max(12, ...stages.map((s) => stageKey(s).length));

    const headerLine = `axctl ${command}  run=${runId.slice(0, 8)}  [${done}/${total}]  elapsed=${formatDuration(elapsed)}  eta=${eta}`;
    const speedLine = `speed ${speed > 0 ? `${formatCount(speed)}/s` : "--"}  current=${currentLabel}`;
    const colHeader = `  ${"stage".padEnd(labelW)}  progress              ${"rows".padStart(8)}  ${"speed".padStart(10)}  ${"time".padStart(7)}`;

    return (
        <box style={{ flexDirection: "column", flexGrow: 1 }}>
            <Row fg="#7aa2f7" line={headerLine} />
            <Row fg="#a9b1d6" line={speedLine} />
            <Row fg="#414868" line={colHeader} />
            {stages.map((s) => (
                <StageRow key={stageKey(s)} s={s} labelW={labelW} frame={frame} now={now} />
            ))}
            {running.map((s) => (
                <Row key={`detail-${stageKey(s)}`} fg="#a9b1d6"
                    line={`${stageKey(s)}: ${summarizeCounts(s.counts) || "discovering work"}`}
                />
            ))}
        </box>
    );
}

/** Wraps a single `<text>` in a fixed-height box. Without this wrapper, OpenTUI
 *  reuses TextRenderable instances across frames in split-footer mode and a
 *  shorter new string can leak prior cells onto adjacent rows. */
function Row({ fg, line }: { fg: string; line: string }) {
    return (
        <box style={{ height: 1, flexShrink: 0 }}>
            <text fg={fg}>{line}</text>
        </box>
    );
}

function StageRow({ s, labelW, frame, now }: {
    s: StageView; labelW: number; frame: number; now: number;
}) {
    const elapsed = s.startedAt ? (s.finishedAt ?? now) - s.startedAt : 0;
    const rows = totalRows(s.counts);
    const speed = elapsed > 0 && rows > 0 ? rows / (elapsed / 1000) : 0;
    const cur = s.counts.currentFile ?? s.counts.currentSubagent;
    const tot = s.counts.totalFiles ?? s.counts.totalSubagents;
    const ratio = typeof cur === "number" && typeof tot === "number" && tot > 0
        ? Math.min(1, cur / tot) : undefined;
    const icon = s.status === "done" ? "✓"
        : s.status === "failed" ? "✗"
        : s.status === "running" ? spinnerFrames[frame]
        : "·";
    const bar = s.status === "done" ? "████████████████████"
        : s.status === "failed" ? "██████░░░░░░░░░░░░░░"
        : s.status === "running" ? runningBar(ratio, frame)
        : "                    ";
    const label = stageKey(s).padEnd(labelW);
    const rowText = rows > 0 ? formatCount(rows)
        : s.status === "running" && typeof cur === "number" && typeof tot === "number"
        ? `${formatCount(cur)}/${formatCount(tot)}`
        : "--";
    const speedText = speed > 0 ? `${formatCount(speed)}/s` : "--";
    const timeText = s.startedAt ? formatDuration(elapsed) : "--";
    const etaLeftMs = s.status === "running" ? computeStageMetrics(s.counts, elapsed).etaLeftMs : undefined;
    const etaText = etaLeftMs !== undefined ? `  ~${formatDuration(etaLeftMs)} left` : "";
    const color = s.status === "done" ? "#9ece6a"
        : s.status === "failed" ? "#f7768e"
        : s.status === "running" ? "#7dcfff"
        : "#414868";
    const line = `${icon} ${label}  ${bar}  ${rowText.padStart(8)}  ${speedText.padStart(10)}  ${timeText.padStart(7)}${s.error ? `  ${s.error}` : etaText}`;
    return (
        <box style={{ height: 1, flexShrink: 0 }}>
            <text fg={color}>{line}</text>
        </box>
    );
}

export interface TuiProgressHandle {
    readonly progress: ProgressReporter;
    /** Tear down the renderer and print a one-line summary inline so it
     *  survives in scrollback after the pinned region is dropped. */
    teardown(): Promise<void>;
}

/**
 * Spin up a split-footer renderer mounting the React progress view.
 * `footerHeight` is set to fit header (3 rows) + stage rows + running detail
 * margin (up to ~3) so the pinned region never wraps.
 */
export async function initTuiProgress(opts: {
    readonly command: string;
    readonly runId: string;
    readonly stages: readonly ProgressStage[];
    readonly intervalMs?: number;
    readonly stdout?: NodeJS.WriteStream;
}): Promise<TuiProgressHandle> {
    const startedAt = Date.now();
    const store = new ProgressStore(opts.stages, startedAt);
    const stdout = opts.stdout ?? process.stdout;

    // Header (3 lines) + col header (1) + stages (N) + up to 3 running-detail
    // lines. Cap to (rows - 5) so the user's shell prompt has room above.
    const baseHeight = 3 + 1 + opts.stages.length + 3;
    const terminalRows = stdout.rows ?? 40;
    const footerHeight = Math.max(8, Math.min(baseHeight, Math.max(8, terminalRows - 5)));

    const renderer = await createCliRenderer({
        screenMode: "split-footer",
        footerHeight,
        exitOnCtrlC: true,
        stdout,
    });
    const root = createRoot(renderer);
    const { createElement } = await import("react");
    root.render(createElement(IngestProgressView, { store, command: opts.command, runId: opts.runId }));

    const timer = setInterval(() => store.tick(Date.now()), opts.intervalMs ?? 120);

    const progress: ProgressReporter = {
        live: true,
        start: (stage) => store.start(stage, Date.now()),
        update: (stage, counts) => store.update(stage, counts, Date.now()),
        finish: (stage, counts) => store.finish(stage, counts, Date.now()),
        fail: (stage, message) => store.fail(stage, message, Date.now()),
        stop: () => { /* teardown handles real cleanup */ },
    };

    const teardown = async (): Promise<void> => {
        clearInterval(timer);
        store.tick(Date.now());
        await new Promise((r) => setTimeout(r, 50));
        try { root.unmount(); } catch { /* best effort */ }
        try { (renderer as { destroy?: () => void }).destroy?.(); } catch { /* best effort */ }
        // Print a one-line summary inline so completion persists in scrollback.
        const snap = store.getSnapshot();
        const elapsed = formatDuration(snap.now - snap.startedAt);
        const ok = snap.stages.filter((s) => s.status === "done").length;
        const fail = snap.stages.filter((s) => s.status === "failed").length;
        const total = snap.stages.length;
        const tag = fail > 0 ? "✗" : "✓";
        stdout.write(`${tag} ${opts.command} done  ${ok}/${total} stages  elapsed=${elapsed}${fail > 0 ? `  failed=${fail}` : ""}\n`);
    };

    return { progress, teardown };
}

/** Convenience used by CLI code: detect TTY + pipeline mode and route to the
 *  TUI renderer; otherwise return null so the caller falls back to the sync
 *  text reporter in `progress.ts`. */
export const shouldUseTui = (
    isTty: boolean,
    mode: string,
    env: Record<string, string | undefined> = process.env,
): boolean => {
    if (!isTty) return false;
    if (mode !== "auto" && mode !== "pipeline") return false;
    if (env.CI === "true" || env.TERM === "dumb") return false;
    if (env.AXCTL_DISABLE_TUI === "1") return false;
    return true;
};
