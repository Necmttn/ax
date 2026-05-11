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
const countDisplayOrder = [
    "files",
    "sessions",
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
        "sessions",
        "turns",
        "toolCalls",
        "tool_calls",
        "skills",
        "commands",
        "count",
        "commits",
        "files",
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

function summarizeCounts(counts: Record<string, number>): string {
    const status = typeof counts.currentFile === "number" && typeof counts.totalFiles === "number"
        ? `processing ${formatCount(counts.currentFile)}/${formatCount(counts.totalFiles)}`
        : typeof counts.totalFiles === "number"
            ? `discovered ${formatCount(counts.totalFiles)} files`
            : "";
    const entries = Object.entries(counts)
        .filter(([key]) => key !== "currentFile" && key !== "totalFiles")
        .filter(([, value]) => Number.isFinite(value))
        .sort(([a], [b]) => {
            const ai = countDisplayOrder.indexOf(a as (typeof countDisplayOrder)[number]);
            const bi = countDisplayOrder.indexOf(b as (typeof countDisplayOrder)[number]);
            if (ai !== -1 || bi !== -1) return (ai === -1 ? Number.POSITIVE_INFINITY : ai) - (bi === -1 ? Number.POSITIVE_INFINITY : bi);
            return a.localeCompare(b);
        });
    if (entries.length === 0) return status;
    const summary = entries.slice(0, 4).map(([key, value]) => `${key}=${formatCount(value)}`).join(" ");
    return status ? `${status}  ${summary}` : summary;
}

function shouldUsePipeline(mode: ProgressMode, sink: ProgressSink, env: Record<string, string | undefined>): boolean {
    if (mode !== "auto" && mode !== "pipeline") return false;
    if (env.AGENTCTL_PROGRESS_FORCE_PIPELINE === "1") return true;
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
            kind: "agentctl.progress",
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

    constructor(private readonly sink: ProgressSink, private readonly now: () => number) {}

    start(stage: ProgressStage): void {
        this.sink.write(`[agentctl] ${stageKey(stage)} started\n`);
    }

    update(): void {}

    finish(stage: ProgressStage, counts: Record<string, number>): void {
        const summary = summarizeCounts(counts);
        this.sink.write(`[agentctl] ${stageKey(stage)} done${summary ? ` ${summary}` : ""}\n`);
    }

    fail(stage: ProgressStage, message: string): void {
        this.sink.write(`[agentctl] ${stageKey(stage)} failed ${message}\n`);
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

    private lines(): string[] {
        const now = this.options.now();
        const elapsed = now - this.startedAt;
        const done = this.states.filter((state) => state.status === "done").length;
        const total = this.states.length;
        const current = this.states.find((state) => state.status === "running");
        const observedRows = this.states.reduce((sum, state) => sum + totalRows(state.counts), 0);
        const speed = elapsed > 0 ? observedRows / (elapsed / 1000) : 0;
        const eta = done > 0 && done < total ? formatDuration((elapsed / done) * (total - done)) : "--";
        const rows = [
            `agentctl ${this.options.command}  run=${this.options.runId.slice(0, 8)}  elapsed=${formatDuration(elapsed)}  eta=${eta}`,
            `speed ${speed > 0 ? `${formatCount(speed)}/s` : "--"}  current=${current ? stageKey(current) : "idle"}`,
            "",
            "stage       progress              rows       speed       time",
        ];
        for (const state of this.states) {
            rows.push(this.stageLine(state, now));
        }
        if (current) {
            rows.push("");
            rows.push(`current ${stageKey(current)}`);
            const summary = summarizeCounts(current.counts);
            rows.push(summary || `${spinnerFrames[this.frame]} discovering work`);
        }
        return rows;
    }

    private stageLine(state: StageState, now: number): string {
        const elapsed = state.startedAt ? (state.finishedAt ?? now) - state.startedAt : 0;
        const rows = totalRows(state.counts);
        const speed = elapsed > 0 && rows > 0 ? rows / (elapsed / 1000) : 0;
        const icon =
            state.status === "done" ? "✓" :
            state.status === "failed" ? "✗" :
            state.status === "running" ? spinnerFrames[this.frame] :
            "·";
        const bar =
            state.status === "done" ? "████████████████████" :
            state.status === "failed" ? "██████░░░░░░░░░░░░░░" :
            state.status === "running" ? this.activeBar() :
            "░░░░░░░░░░░░░░░░░░░░";
        const label = `${state.source}`.padEnd(10);
        const rowText = rows > 0 ? formatCount(rows) : state.status === "pending" ? "pending" : "--";
        const speedText = speed > 0 ? `${formatCount(speed)}/s` : "--";
        const timeText = state.startedAt ? formatDuration(elapsed) : "--";
        const suffix = state.error ? `  ${state.error}` : "";
        return `${icon} ${label} ${bar}  ${rowText.padStart(8)}  ${speedText.padStart(10)}  ${timeText.padStart(7)}${suffix}`;
    }

    private activeBar(): string {
        const width = 20;
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
    if (options.mode === "plain") return new PlainProgress(sink, now);
    if (shouldUsePipeline(options.mode, sink, env)) {
        return new PipelineProgress({
            ...base,
            sink,
            intervalMs: options.intervalMs ?? 120,
        }, options.stages);
    }
    if (options.mode === "auto") return new JsonProgress({ ...base, sink });
    return new PlainProgress(sink, now);
}
