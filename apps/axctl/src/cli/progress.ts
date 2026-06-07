export type ProgressMode = "auto" | "pipeline" | "plain" | "json" | "off";

export interface ProgressStage {
    readonly source: string;
    readonly stage: string;
}

export interface ProgressSink {
    readonly isTTY?: boolean;
    readonly columns?: number;
    write(chunk: string): unknown;
}

export interface ProgressReporter {
    readonly live: boolean;
    start(stage: ProgressStage): void;
    update(stage: ProgressStage, counts: Record<string, number>): void;
    finish(stage: ProgressStage, counts: Record<string, number>): void;
    fail(stage: ProgressStage, message: string): void;
    stop(): void;
}

type StageStatus = "pending" | "running" | "done" | "failed";

interface StageState extends ProgressStage {
    status: StageStatus;
    startedAt?: number;
    finishedAt?: number;
    counts: Record<string, number>;
    error?: string;
}

export interface ProgressOptions {
    readonly command: string;
    readonly mode: ProgressMode;
    readonly runId: string;
    readonly stages: readonly ProgressStage[];
    readonly sink?: ProgressSink;
    readonly now?: () => number;
    readonly intervalMs?: number;
    readonly env?: Record<string, string | undefined>;
}

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Below this, a stage's wall-clock is dominated by measurement noise (a single
 *  bulk insert finishes in ~1ms), so rows/elapsed yields absurd throughput like
 *  "4,339,000/s". Display floors sub-100ms times to "0.1s" anyway - suppress the
 *  rate to "--" rather than divide by the true sub-millisecond elapsed. */
const minSpeedElapsedMs = 100;
const countDisplayOrder = [
    "files",
    "bytes",
    "lines",
    "fileTurns",
    "fileToolCalls",
    "activeFiles",
    "sessions",
    "subagents",
    "written",
    "missingParent",
    "skippedExisting",
    "turns",
    "toolCalls",
    "tool_calls",
    "invocations",
    "commits",
    "repos",
    "produced",
    "touched",
    "edits",
    "planSnapshots",
    "skills",
    "commands",
    "count",
    "insights",
    "signals",
    "pairs",
    "recoveries",
] as const;

export function parseProgressMode(raw: string | undefined): ProgressMode {
    if (raw === undefined || raw === "") return "auto";
    if (raw === "auto" || raw === "pipeline" || raw === "plain" || raw === "json" || raw === "off") {
        return raw;
    }
    throw new Error(`unknown progress mode "${raw}" (expected auto, pipeline, plain, json, or off)`);
}

function stageKey(stage: ProgressStage): string {
    return `${stage.source}/${stage.stage}`;
}

function formatCount(value: number): string {
    return Math.round(value).toLocaleString("en-US");
}

function formatBytes(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return "0B";
    if (value < 1024) return `${Math.round(value)}B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KiB`;
    if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)}MiB`;
    return `${(value / 1024 / 1024 / 1024).toFixed(1)}GiB`;
}

function formatMetric(key: string, value: number): string {
    return key.toLowerCase().includes("bytes") ? formatBytes(value) : formatCount(value);
}

function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return "--";
    if (ms < 1000) return `${Math.max(0.1, ms / 1000).toFixed(1)}s`;
    const totalSeconds = Math.round(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes === 0) return `${seconds}s`;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function totalRows(counts: Record<string, number>): number {
    const preferred = [
        "records",
        "files",
        "sessions",
        "subagents",
        "turns",
        "toolCalls",
        "tool_calls",
        "skills",
        "commands",
        "count",
        "commits",
        "insights",
        "signals",
        "pairs",
        "recoveries",
    ];
    for (const key of preferred) {
        const value = counts[key];
        if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    }
    return 0;
}

const firstFinite = (...values: Array<number | undefined>): number | undefined => {
    for (const v of values) if (typeof v === "number" && Number.isFinite(v)) return v;
    return undefined;
};

/** Per-stage live metrics shared by every renderer (plain log, pipeline board,
 *  TUI, dashboard) so the Paxel-style line is identical everywhere. `current`/
 *  `total` come from the `currentFile`/`totalFiles` (or subagent) convention
 *  keys; `itemsPerSec` is item throughput (files/s, what Paxel shows); `rowsPerSec`
 *  is record throughput; `etaLeftMs` projects the remaining items at the current
 *  item rate. Sub-100ms elapsed suppresses rates to avoid noise-inflated speeds. */
export interface StageMetrics {
    readonly current: number | undefined;
    readonly total: number | undefined;
    readonly ratio: number | undefined;
    readonly rows: number;
    readonly itemsPerSec: number;
    readonly rowsPerSec: number;
    readonly etaLeftMs: number | undefined;
}

export function computeStageMetrics(counts: Record<string, number>, elapsedMs: number): StageMetrics {
    const current = firstFinite(counts.currentFile, counts.currentSubagent);
    const total = firstFinite(counts.totalFiles, counts.totalSubagents);
    const ratio = current !== undefined && total !== undefined && total > 0
        ? Math.min(1, current / total)
        : undefined;
    const rows = totalRows(counts);
    const secs = elapsedMs / 1000;
    const measurable = elapsedMs >= minSpeedElapsedMs && secs > 0;
    const itemsPerSec = measurable && current !== undefined && current > 0 ? current / secs : 0;
    const rowsPerSec = measurable && rows > 0 ? rows / secs : 0;
    const etaLeftMs = itemsPerSec > 0 && total !== undefined && current !== undefined && total > current
        ? ((total - current) / itemsPerSec) * 1000
        : undefined;
    return { current, total, ratio, rows, itemsPerSec, rowsPerSec, etaLeftMs };
}

function summarizeCounts(counts: Record<string, number>): string {
    const phase = typeof counts.phase === "number"
        ? counts.phase === 1 ? "reading" : counts.phase === 2 ? "writing" : counts.phase === 3 ? "snapshotting" : "working"
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
            : phase
                ? `${phase} work`
                : "";
    const entries = Object.entries(counts)
        .filter(([key]) =>
            key !== "currentFile" &&
            key !== "totalFiles" &&
            key !== "currentFileBytes" &&
            key !== "totalBytes" &&
            key !== "currentSubagent" &&
            key !== "totalSubagents" &&
            key !== "records" &&
            key !== "phase"
        )
        .filter(([, value]) => Number.isFinite(value))
        .sort(([a], [b]) => {
            const ai = countDisplayOrder.indexOf(a as (typeof countDisplayOrder)[number]);
            const bi = countDisplayOrder.indexOf(b as (typeof countDisplayOrder)[number]);
            if (ai !== -1 || bi !== -1) return (ai === -1 ? Number.POSITIVE_INFINITY : ai) - (bi === -1 ? Number.POSITIVE_INFINITY : bi);
            return a.localeCompare(b);
        });
    if (entries.length === 0) return status;
    const summary = entries.slice(0, 4).map(([key, value]) => `${key}=${formatMetric(key, value)}`).join(" ");
    return status ? `${status}  ${summary}` : summary;
}

function shouldUsePipeline(mode: ProgressMode, sink: ProgressSink, env: Record<string, string | undefined>): boolean {
    if (mode !== "auto" && mode !== "pipeline") return false;
    if (env.AXCTL_PROGRESS_FORCE_PIPELINE === "1") return true;
    if (!sink.isTTY) return false;
    if (env.CI === "true" || env.TERM === "dumb") return false;
    return true;
}

class NoopProgress implements ProgressReporter {
    readonly live = false;
    start(): void {}
    update(): void {}
    finish(): void {}
    fail(): void {}
    stop(): void {}
}

class JsonProgress implements ProgressReporter {
    readonly live = false;

    constructor(
        private readonly options: Required<Pick<ProgressOptions, "command" | "runId" | "now">> & { sink: ProgressSink },
    ) {}

    start(stage: ProgressStage): void {
        this.write("started", stage, {});
    }

    update(stage: ProgressStage, counts: Record<string, number>): void {
        this.write("updated", stage, { counts });
    }

    finish(stage: ProgressStage, counts: Record<string, number>): void {
        this.write("finished", stage, { counts });
    }

    fail(stage: ProgressStage, message: string): void {
        this.write("failed", stage, { error: message });
    }

    stop(): void {}

    private write(event: string, stage: ProgressStage, extra: Record<string, unknown>): void {
        this.options.sink.write(JSON.stringify({
            kind: "axctl.progress",
            command: this.options.command,
            runId: this.options.runId,
            event,
            source: stage.source,
            stage: stage.stage,
            ts: new Date(this.options.now()).toISOString(),
            ...extra,
        }) + "\n");
    }
}

class PlainProgress implements ProgressReporter {
    readonly live = false;

    // Per-stage start time + ordered keys so update() lines carry a [n/N] step
    // index and an item rate. `lastLine` de-dupes identical consecutive lines so
    // an agent tailing the log isn't flooded when counts haven't changed.
    private readonly startedAt = new Map<string, number>();
    private readonly order: string[] = [];
    private readonly lastLine = new Map<string, string>();

    constructor(
        private readonly sink: ProgressSink,
        private readonly now: () => number,
        private readonly stageCount = 0,
    ) {}

    private track(key: string): void {
        if (!this.startedAt.has(key)) {
            this.startedAt.set(key, this.now());
            this.order.push(key);
        }
    }

    start(stage: ProgressStage): void {
        const key = stageKey(stage);
        this.track(key);
        this.sink.write(`[axctl] ${key} started\n`);
    }

    update(stage: ProgressStage, counts: Record<string, number>): void {
        const key = stageKey(stage);
        this.track(key);
        const m = computeStageMetrics(counts, this.now() - (this.startedAt.get(key) ?? this.now()));
        // Only emit a live line once we have a determinate current/total; pure
        // discovery ticks (totals only) and total-less stages stay quiet here and
        // surface their result on finish().
        if (m.current === undefined || m.total === undefined) return;
        const idx = this.order.indexOf(key) + 1;
        const n = Math.max(this.stageCount, this.order.length);
        const pct = m.ratio !== undefined ? `  ${Math.round(m.ratio * 100)}%` : "";
        const rate = m.itemsPerSec > 0 ? `  ${m.itemsPerSec.toFixed(1)} it/s` : "";
        const eta = m.etaLeftMs !== undefined ? `  ~${formatDuration(m.etaLeftMs)} left` : "";
        const line = `[axctl] [${idx}/${n}] ${key}  ${formatCount(m.current)}/${formatCount(m.total)}${rate}${pct}${eta}`;
        if (this.lastLine.get(key) === line) return;
        this.lastLine.set(key, line);
        this.sink.write(line + "\n");
    }

    finish(stage: ProgressStage, counts: Record<string, number>): void {
        const summary = summarizeCounts(counts);
        this.sink.write(`[axctl] ${stageKey(stage)} done${summary ? ` ${summary}` : ""}\n`);
    }

    fail(stage: ProgressStage, message: string): void {
        this.sink.write(`[axctl] ${stageKey(stage)} failed ${message}\n`);
    }

    stop(): void {
        void this.now;
    }
}

class PipelineProgress implements ProgressReporter {
    readonly live = true;

    private readonly states: StageState[];
    private readonly startedAt: number;
    private timer: ReturnType<typeof setInterval> | undefined;
    private renderedLines = 0;
    private frame = 0;
    private stopped = false;

    constructor(
        private readonly options: Required<Pick<ProgressOptions, "command" | "runId" | "now" | "intervalMs">> & { sink: ProgressSink },
        stages: readonly ProgressStage[],
    ) {
        this.startedAt = options.now();
        this.states = stages.map((stage) => ({
            ...stage,
            status: "pending",
            counts: {},
        }));
        this.timer = setInterval(() => this.render(), options.intervalMs);
        this.render();
    }

    start(stage: ProgressStage): void {
        const state = this.stateFor(stage);
        state.status = "running";
        state.startedAt = this.options.now();
        this.render();
    }

    update(stage: ProgressStage, counts: Record<string, number>): void {
        const state = this.stateFor(stage);
        if (state.status === "pending") {
            state.status = "running";
            state.startedAt = this.options.now();
        }
        state.counts = counts;
        this.render();
    }

    finish(stage: ProgressStage, counts: Record<string, number>): void {
        const state = this.stateFor(stage);
        state.status = "done";
        state.finishedAt = this.options.now();
        state.counts = counts;
        this.render();
    }

    fail(stage: ProgressStage, message: string): void {
        const state = this.stateFor(stage);
        state.status = "failed";
        state.finishedAt = this.options.now();
        state.error = message;
        this.render();
    }

    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        if (this.timer) clearInterval(this.timer);
        this.render();
        this.options.sink.write("\x1b[?25h\n");
    }

    private stateFor(stage: ProgressStage): StageState {
        const key = stageKey(stage);
        const existing = this.states.find((candidate) => stageKey(candidate) === key);
        if (existing) return existing;
        const created: StageState = { ...stage, status: "pending", counts: {} };
        this.states.push(created);
        return created;
    }

    private render(): void {
        if (this.renderedLines > 0) {
            this.options.sink.write(`\x1b[${this.renderedLines}A\x1b[0J`);
        } else {
            this.options.sink.write("\x1b[?25l");
        }
        const lines = this.lines();
        this.renderedLines = lines.length;
        this.options.sink.write(lines.join("\n") + "\n");
        this.frame = (this.frame + 1) % spinnerFrames.length;
    }

    private labelWidth(): number {
        let width = 12;
        for (const state of this.states) {
            const len = stageKey(state).length;
            if (len > width) width = len;
        }
        return width;
    }

    private lines(): string[] {
        const now = this.options.now();
        const elapsed = now - this.startedAt;
        const done = this.states.filter((state) => state.status === "done").length;
        const total = this.states.length;
        const running = this.states.filter((state) => state.status === "running");
        const currentLabel = running.length > 0 ? running.map(stageKey).join(" + ") : "idle";
        const observedRows = this.states.reduce((sum, state) => sum + totalRows(state.counts), 0);
        const speed = elapsed >= minSpeedElapsedMs ? observedRows / (elapsed / 1000) : 0;
        const eta = done > 0 && done < total ? formatDuration((elapsed / done) * (total - done)) : "--";
        const labelW = this.labelWidth();
        const header = `  ${"stage".padEnd(labelW)}  progress              ${"rows".padStart(8)}  ${"speed".padStart(10)}  ${"time".padStart(7)}`;
        const rows = [
            `axctl ${this.options.command}  run=${this.options.runId.slice(0, 8)}  [${done}/${total}]  elapsed=${formatDuration(elapsed)}  eta=${eta}`,
            `speed ${speed > 0 ? `${formatCount(speed)}/s` : "--"}  current=${currentLabel}`,
            "",
            header,
        ];
        for (const state of this.states) {
            rows.push(this.stageLine(state, now, labelW));
        }
        for (const current of running) {
            rows.push("");
            rows.push(`current ${stageKey(current)}`);
            const summary = summarizeCounts(current.counts);
            rows.push(summary || `${spinnerFrames[this.frame]} discovering work`);
        }
        return rows;
    }

    private stageLine(state: StageState, now: number, labelW: number): string {
        const elapsed = state.startedAt ? (state.finishedAt ?? now) - state.startedAt : 0;
        const rows = totalRows(state.counts);
        const speed = elapsed >= minSpeedElapsedMs && rows > 0 ? rows / (elapsed / 1000) : 0;
        const cur = state.counts.currentFile ?? state.counts.currentSubagent;
        const tot = state.counts.totalFiles ?? state.counts.totalSubagents;
        const ratio = typeof cur === "number" && typeof tot === "number" && tot > 0
            ? Math.min(1, cur / tot)
            : undefined;
        const icon =
            state.status === "done" ? "✓" :
            state.status === "failed" ? "✗" :
            state.status === "running" ? spinnerFrames[this.frame] :
            "·";
        const bar =
            state.status === "done" ? "████████████████████" :
            state.status === "failed" ? "██████░░░░░░░░░░░░░░" :
            state.status === "running" ? this.runningBar(ratio) :
            "                    ";
        const label = stageKey(state).padEnd(labelW);
        const rowText = rows > 0
            ? formatCount(rows)
            : state.status === "running" && typeof cur === "number" && typeof tot === "number"
                ? `${formatCount(cur)}/${formatCount(tot)}`
                : "--";
        const speedText = speed > 0 ? `${formatCount(speed)}/s` : "--";
        const timeText = state.startedAt ? formatDuration(elapsed) : "--";
        const etaLeftMs = state.status === "running"
            ? computeStageMetrics(state.counts, elapsed).etaLeftMs
            : undefined;
        const etaText = etaLeftMs !== undefined ? `  ~${formatDuration(etaLeftMs)} left` : "";
        const suffix = state.error ? `  ${state.error}` : etaText;
        return `${icon} ${label}  ${bar}  ${rowText.padStart(8)}  ${speedText.padStart(10)}  ${timeText.padStart(7)}${suffix}`;
    }

    /** Bar for a running stage. When we know `currentFile / totalFiles`, fill
     *  proportionally; otherwise fall back to a bouncing indicator. */
    private runningBar(ratio: number | undefined): string {
        const width = 20;
        if (ratio !== undefined) {
            const filled = Math.max(1, Math.round(ratio * width));
            return "█".repeat(filled) + "░".repeat(width - filled);
        }
        const position = this.frame % width;
        return Array.from({ length: width }, (_, index) =>
            Math.abs(index - position) <= 1 ? "█" : "░",
        ).join("");
    }
}

export function createProgressReporter(options: ProgressOptions): ProgressReporter {
    const sink = options.sink ?? process.stderr;
    const now = options.now ?? Date.now;
    const env = options.env ?? process.env;
    const base = {
        command: options.command,
        runId: options.runId,
        now,
    };
    if (options.mode === "off") return new NoopProgress();
    if (options.mode === "json") return new JsonProgress({ ...base, sink });
    if (options.mode === "plain") return new PlainProgress(sink, now, options.stages.length);
    if (shouldUsePipeline(options.mode, sink, env)) {
        return new PipelineProgress({
            ...base,
            sink,
            intervalMs: options.intervalMs ?? 120,
        }, options.stages);
    }
    if (options.mode === "auto") return new JsonProgress({ ...base, sink });
    return new PlainProgress(sink, now, options.stages.length);
}
