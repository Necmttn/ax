#!/usr/bin/env bun
// Demo harness to SEE the two ingest progress renderers side by side, without
// running a real ingest. Drives the same fake stage sequence (with realistic
// rows/speed counts) through either renderer.
//
//   bun scripts/demo-progress.ts ansi      # the current hand-rolled ANSI renderer
//   bun scripts/demo-progress.ts tui       # the unwired OpenTUI + React renderer
//
// Open two terminal panes and run one in each to compare.
import { createProgressReporter, type ProgressReporter, type ProgressStage } from "../apps/axctl/src/cli/progress.ts";
import { initTuiProgress } from "../apps/axctl/src/cli/progress-tui.tsx";

const mode = (process.argv[2] ?? "ansi").toLowerCase();
if (mode !== "ansi" && mode !== "tui" && mode !== "opentui") {
    console.error("usage: bun scripts/demo-progress.ts [ansi|tui]");
    process.exit(2);
}

const stages: ProgressStage[] = [
    { source: "ingest", stage: "skills" },
    { source: "ingest", stage: "commands" },
    { source: "ingest", stage: "claude" },
    { source: "ingest", stage: "codex" },
    { source: "ingest", stage: "git" },
    { source: "ingest", stage: "signals" },
];

// Per-stage scripted "work": how many rows it produces and how long it takes.
const work: Record<string, { rows: number; ticks: number }> = {
    skills: { rows: 312, ticks: 4 },
    commands: { rows: 87, ticks: 3 },
    claude: { rows: 5400, ticks: 12 },
    codex: { rows: 1200, ticks: 8 },
    git: { rows: 940, ticks: 6 },
    signals: { rows: 2100, ticks: 7 },
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function drive(reporter: ProgressReporter): Promise<void> {
    for (const s of stages) {
        const w = work[s.stage] ?? { rows: 500, ticks: 5 };
        reporter.start(s);
        for (let i = 1; i <= w.ticks; i++) {
            await sleep(220);
            const records = Math.round((w.rows * i) / w.ticks);
            reporter.update(s, { records, currentFile: i, totalFiles: w.ticks });
        }
        reporter.finish(s, { records: w.rows });
        await sleep(120);
    }
    reporter.stop();
}

if (mode === "tui" || mode === "opentui") {
    if (!process.stdout.isTTY) {
        console.error("[demo] the OpenTUI renderer needs a real TTY - run this in a terminal, not piped.");
        process.exit(1);
    }
    const handle = await initTuiProgress({ command: "ingest", runId: "demo", stages });
    await drive(handle.progress);
    await handle.teardown();
} else {
    const reporter = createProgressReporter({
        command: "ingest",
        runId: "demo",
        mode: "pipeline",
        stages,
        sink: process.stderr,
    });
    await drive(reporter);
}
