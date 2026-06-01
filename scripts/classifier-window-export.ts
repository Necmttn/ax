#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect } from "effect";
import { Surreal } from "surrealdb";
import {
    buildEventWindows,
    enrichEventWindowsWithToolCalls,
    type ClassifierToolCallRow,
    type ClassifierTurnRow,
} from "../src/classifiers/event-window.ts";
import { ClassifierRunner, ClassifierRunnerLive, type ClassifierResult, type EventWindow } from "../src/classifiers/core.ts";
import { builtInClassifiers } from "../src/classifiers/registry.ts";
import { envConfig } from "@ax/lib/db";
import { recordKeyPart } from "@ax/lib/shared/derive-keys";

export interface WindowExportArgs {
    readonly days: number;
    readonly limit: number;
    readonly out: string;
    readonly json: boolean;
}

export interface EditedFileRow {
    readonly turn: unknown;
    readonly file: unknown;
    readonly session?: unknown;
    readonly seq?: number | null;
    readonly ts: string | Date;
}

export interface ModelWindowEvidenceRef {
    readonly kind: string;
    readonly ref: string;
}

export interface ModelWindowRecord {
    readonly id: string;
    readonly session: string | null;
    readonly turn: string;
    readonly seq: number;
    readonly ts: string | Date;
    readonly text: string;
    readonly approx_tokens: number;
    readonly light_labels: readonly string[];
    readonly light_results: readonly {
        readonly classifier_key: string;
        readonly label: string;
        readonly target: string;
        readonly polarity: string;
        readonly durability: string;
        readonly confidence: number;
    }[];
    readonly evidence: readonly ModelWindowEvidenceRef[];
}

export interface WindowExportReport {
    readonly days: number;
    readonly limit: number;
    readonly out: string;
    readonly sourceTurns: number;
    readonly exportedWindows: number;
    readonly labeledWindows: number;
    readonly approxTokenP50: number;
    readonly approxTokenP95: number;
    readonly over384: number;
    readonly percentUnder384: number;
    readonly percentWithPreviousAssistant: number;
    readonly percentWithToolOrFileEvidence: number;
    readonly failures: readonly string[];
}

const usage = (code = 0): never => {
    console.error(`Usage:
  bun scripts/classifier-window-export.ts [options]

Options:
  --days=N       Look back N days for turns/tool/file evidence. Default: 7
  --limit=N      Maximum model windows to export. Default: 1000
  --out=PATH     JSONL output path. Default: .ax/experiments/model-windows.jsonl
  --json         Print JSON report
`);
    process.exit(code);
};

const parsePositiveInt = (raw: string | undefined, name: string, fallback: number): number => {
    if (raw === undefined || raw.length === 0) return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
    return parsed;
};

export function parseArgs(argv: readonly string[]): WindowExportArgs {
    let days = 7;
    let limit = 1000;
    let out = ".ax/experiments/model-windows.jsonl";
    let json = false;

    for (const arg of argv) {
        if (arg === "--help" || arg === "-h") usage(0);
        if (arg === "--json") {
            json = true;
            continue;
        }
        if (arg.startsWith("--days=")) {
            days = parsePositiveInt(arg.slice("--days=".length), "--days", days);
            continue;
        }
        if (arg.startsWith("--limit=")) {
            limit = parsePositiveInt(arg.slice("--limit=".length), "--limit", limit);
            continue;
        }
        if (arg.startsWith("--out=")) {
            const value = arg.slice("--out=".length).trim();
            if (!value) throw new Error("--out must not be empty");
            out = value;
            continue;
        }
        throw new Error(`unknown argument: ${arg}`);
    }

    return { days, limit, out, json };
}

const textBlock = (heading: string, value: string | null | undefined): string | null => {
    const text = (value ?? "").trim();
    return text ? `${heading}:\n${text}` : null;
};

const compact = (value: string | null | undefined, maxChars: number): string => {
    const text = (value ?? "").replace(/\s+/g, " ").trim();
    if (text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
};

export const approxTokenCount = (text: string): number => {
    const trimmed = text.trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).length;
};

const ref = (table: string, key: string | null | undefined): string | null =>
    key ? `${table}:${key}` : null;

export function enrichWindowsWithRecentEditedFiles(
    windows: readonly EventWindow[],
    editedFiles: readonly EditedFileRow[],
): EventWindow[] {
    const editedBySession = new Map<string, Array<{ readonly fileKey: string; readonly seq: number }>>();
    for (const row of editedFiles) {
        const sessionKey = recordKeyPart(row.session, "session");
        const fileKey = recordKeyPart(row.file, "file");
        if (!sessionKey || !fileKey || typeof row.seq !== "number" || !Number.isFinite(row.seq)) continue;
        const rows = editedBySession.get(sessionKey) ?? [];
        rows.push({ fileKey, seq: row.seq });
        editedBySession.set(sessionKey, rows);
    }
    for (const rows of editedBySession.values()) rows.sort((a, b) => a.seq - b.seq);

    return windows.map((window) => {
        if (!window.sessionId) return window;
        const recentFiles = (editedBySession.get(window.sessionId) ?? [])
            .filter((row) => row.seq <= window.userTurn.seq)
            .slice(-5)
            .map((row) => row.fileKey);
        return { ...window, recentFiles };
    });
}

export function projectWindowForModel(
    window: EventWindow,
    results: readonly ClassifierResult[] = [],
): ModelWindowRecord {
    const toolFailureText = window.recentToolFailures
        .slice(-3)
        .map((failure) => compact([
            failure.name,
            failure.text,
        ].filter(Boolean).join(" "), 360))
        .filter((text) => text.length > 0)
        .join("\n");
    const recentFilesText = window.recentFiles
        .slice(-5)
        .map((file) => `- ${file}`)
        .join("\n");
    const blocks = [
        textBlock("USER", compact(window.userTurn.text, 1200)),
        textBlock("PREVIOUS_ASSISTANT", compact(window.previousAssistantTurn?.text, 1200)),
        textBlock("RECENT_TOOL_FAILURES", toolFailureText),
        textBlock("RECENT_FILES", recentFilesText),
    ].filter((block): block is string => block !== null);
    const text = blocks.join("\n\n");
    const evidence: ModelWindowEvidenceRef[] = [
        ...(window.previousAssistantTurn
            ? [{ kind: "previous_assistant", ref: ref("turn", window.previousAssistantTurn.id) ?? window.previousAssistantTurn.id }]
            : []),
        ...window.recentToolFailures.slice(-3).flatMap((failure) => {
            const table = failure.sourceTable ?? "turn";
            const evidenceRef = ref(table, failure.id);
            return evidenceRef ? [{ kind: "recent_tool_failure", ref: evidenceRef }] : [];
        }),
        ...window.recentFiles.slice(-5).map((file) => ({ kind: "recent_edited_file", ref: ref("file", file) ?? file })),
    ];
    const lightResults = results.map((result) => ({
        classifier_key: result.classifierKey,
        label: result.label,
        target: result.target,
        polarity: result.polarity,
        durability: result.durability,
        confidence: result.confidence,
    }));
    return {
        id: `event_window:${window.subjectId}`,
        session: window.sessionId ? `session:${window.sessionId}` : null,
        turn: `turn:${window.subjectId}`,
        seq: window.userTurn.seq,
        ts: window.userTurn.ts,
        text,
        approx_tokens: approxTokenCount(text),
        light_labels: [...new Set(results.map((result) => result.label))],
        light_results: lightResults,
        evidence,
    };
}

const percentile = (values: readonly number[], p: number): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[index] ?? 0;
};

export function evaluateWindowExportReport(input: Omit<WindowExportReport, "failures">): WindowExportReport {
    const failures: string[] = [];
    if (input.sourceTurns > 0 && input.exportedWindows < 500) {
        failures.push("less than 500 model windows exported from local source data");
    }
    if (input.exportedWindows > 0 && input.percentUnder384 < 80) {
        failures.push("less than 80% of projected windows are under 384 approximate tokens");
    }
    if (input.exportedWindows > 0 && input.percentWithPreviousAssistant < 70) {
        failures.push("less than 70% of projected windows have prior assistant context evidence");
    }
    return { ...input, failures };
}

export async function buildWindowExportReport(
    args: WindowExportArgs,
    windows: readonly EventWindow[],
    results: readonly ClassifierResult[],
    sourceTurns: number,
): Promise<{ readonly report: WindowExportReport; readonly records: readonly ModelWindowRecord[] }> {
    const resultsBySubject = new Map<string, ClassifierResult[]>();
    for (const result of results) {
        const rows = resultsBySubject.get(result.subjectId) ?? [];
        rows.push(result);
        resultsBySubject.set(result.subjectId, rows);
    }
    const records = windows
        .slice(0, args.limit)
        .map((window) => projectWindowForModel(window, resultsBySubject.get(window.subjectId) ?? []));
    const tokenCounts = records.map((record) => record.approx_tokens);
    const withPrevious = records.filter((record) => record.evidence.some((evidence) => evidence.kind === "previous_assistant")).length;
    const withToolOrFile = records.filter((record) =>
        record.evidence.some((evidence) => evidence.kind === "recent_tool_failure" || evidence.kind === "recent_edited_file"),
    ).length;
    const over384 = records.filter((record) => record.approx_tokens > 384).length;
    const exportedWindows = records.length;
    const report = evaluateWindowExportReport({
        days: args.days,
        limit: args.limit,
        out: args.out,
        sourceTurns,
        exportedWindows,
        labeledWindows: records.filter((record) => record.light_labels.length > 0).length,
        approxTokenP50: percentile(tokenCounts, 50),
        approxTokenP95: percentile(tokenCounts, 95),
        over384,
        percentUnder384: exportedWindows === 0 ? 0 : Number((((exportedWindows - over384) / exportedWindows) * 100).toFixed(1)),
        percentWithPreviousAssistant: exportedWindows === 0 ? 0 : Number(((withPrevious / exportedWindows) * 100).toFixed(1)),
        percentWithToolOrFileEvidence: exportedWindows === 0 ? 0 : Number(((withToolOrFile / exportedWindows) * 100).toFixed(1)),
    });
    return { report, records };
}

async function fetchRows(args: WindowExportArgs): Promise<{
    readonly turns: readonly ClassifierTurnRow[];
    readonly toolCalls: readonly ClassifierToolCallRow[];
    readonly editedFiles: readonly EditedFileRow[];
}> {
    const cfg = envConfig();
    const db = new Surreal();
    await db.connect(cfg.url);
    await db.signin({ username: cfg.user, password: cfg.pass });
    await db.use({ namespace: cfg.ns, database: cfg.db });
    try {
        const turnSql = `
SELECT id, session, seq, role, message_kind, text, text_excerpt, type::string(ts) AS ts
FROM turn
WHERE ts > time::now() - ${args.days}d
ORDER BY session, seq;`.trim();
        const toolSql = `
SELECT id, session, seq, name, command_norm, command_text, output_excerpt, error_text, has_error, type::string(ts) AS ts
FROM tool_call
WHERE ts > time::now() - ${args.days + 1}d
ORDER BY session, ts;`.trim();
        const editedSql = `
SELECT type::string(in) AS turn, type::string(out) AS file, in.session AS session, in.seq AS seq, type::string(ts) AS ts
FROM edited
WHERE ts > time::now() - ${args.days + 1}d
ORDER BY ts;`.trim();
        const [turns, toolCalls, editedFiles] = await Promise.all([
            db.query<[ClassifierTurnRow[]]>(turnSql),
            db.query<[ClassifierToolCallRow[]]>(toolSql),
            db.query<[EditedFileRow[]]>(editedSql),
        ]);
        return {
            turns: turns[0] ?? [],
            toolCalls: toolCalls[0] ?? [],
            editedFiles: editedFiles[0] ?? [],
        };
    } finally {
        await db.close();
    }
}

async function classifyWindows(windows: readonly EventWindow[]): Promise<readonly ClassifierResult[]> {
    const program = Effect.gen(function* () {
        const runner = yield* ClassifierRunner;
        return yield* runner.runBatch({ windows, classifiers: builtInClassifiers });
    });
    return Effect.runPromise(program.pipe(Effect.provide(ClassifierRunnerLive)));
}

function printReport(report: WindowExportReport, json: boolean): void {
    if (json) {
        console.log(JSON.stringify(report, null, 2));
        return;
    }
    console.log("classifier window export report");
    console.log(`days: ${report.days}`);
    console.log(`limit: ${report.limit}`);
    console.log(`out: ${report.out}`);
    console.log(`source turns: ${report.sourceTurns}`);
    console.log(`exported windows: ${report.exportedWindows}`);
    console.log(`labeled windows: ${report.labeledWindows}`);
    console.log(`approx token p50: ${report.approxTokenP50}`);
    console.log(`approx token p95: ${report.approxTokenP95}`);
    console.log(`over 384 approx tokens: ${report.over384}`);
    console.log(`under 384 approx tokens: ${report.percentUnder384}%`);
    console.log(`with previous assistant evidence: ${report.percentWithPreviousAssistant}%`);
    console.log(`with tool/file evidence: ${report.percentWithToolOrFileEvidence}%`);
    if (report.failures.length > 0) {
        console.error("failures:");
        for (const failure of report.failures) console.error(`  - ${failure}`);
    }
}

async function main(): Promise<void> {
    const args = parseArgs(Bun.argv.slice(2));
    const { turns, toolCalls, editedFiles } = await fetchRows(args);
    const windows = enrichWindowsWithRecentEditedFiles(
        enrichEventWindowsWithToolCalls(buildEventWindows(turns), toolCalls),
        editedFiles,
    );
    const selectedWindows = windows.slice(0, args.limit);
    const results = await classifyWindows(selectedWindows);
    const { report, records } = await buildWindowExportReport(args, selectedWindows, results, turns.length);
    await mkdir(dirname(args.out), { recursive: true });
    await writeFile(args.out, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
    printReport(report, args.json);
    if (report.failures.length > 0) process.exit(1);
}

if (import.meta.main) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    });
}
