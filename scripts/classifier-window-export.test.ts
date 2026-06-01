import { describe, expect, test } from "bun:test";
import type { EventWindow, ClassifierResult } from "../apps/axctl/src/classifiers/core.ts";
import {
    approxTokenCount,
    buildWindowExportReport,
    enrichWindowsWithRecentEditedFiles,
    evaluateWindowExportReport,
    parseArgs,
    projectWindowForModel,
} from "./classifier-window-export.ts";

const windowFixture = (overrides: Partial<EventWindow> = {}): EventWindow => ({
    key: "session1__turn1",
    subjectType: "event_window",
    subjectId: "turn1",
    sessionId: "session1",
    userTurn: {
        id: "turn1",
        key: "turn1",
        seq: 10,
        role: "user",
        text: "Can you use UV here?",
        ts: "2026-05-30T00:00:00Z",
    },
    previousAssistantTurn: {
        id: "turn0",
        key: "turn0",
        seq: 9,
        role: "assistant",
        text: "I tried pip install and hit dependency issues.",
        ts: "2026-05-30T00:00:00Z",
    },
    recentToolCalls: [],
    recentToolFailures: [{
        id: "tc1",
        sourceTable: "tool_call",
        name: "shell",
        text: "pip install failed with dependency conflict",
        ts: "2026-05-30T00:00:00Z",
    }],
    recentFiles: ["pyproject_toml"],
    existingLabels: [],
    ...overrides,
});

const resultFixture = (overrides: Partial<ClassifierResult> = {}): ClassifierResult => ({
    key: "result1",
    classifierKey: "direction-event",
    classifierVersion: "0.1.0",
    subjectType: "event_window",
    subjectId: "turn1",
    sessionId: "session1",
    turnId: "turn1",
    label: "direction",
    target: "tooling_preference",
    polarity: "accept",
    durability: "repo_preference",
    confidence: 0.9,
    method: "heuristic",
    evidenceJson: "{}",
    signals: ["use_uv"],
    ts: "2026-05-30T00:00:00Z",
    ...overrides,
});

describe("classifier window export", () => {
    test("parses export args", () => {
        expect(parseArgs(["--days=3", "--limit=25", "--out=.ax/tmp.jsonl", "--json"])).toEqual({
            days: 3,
            limit: 25,
            out: ".ax/tmp.jsonl",
            json: true,
        });
    });

    test("projects an event window into model-ready text with evidence and light labels", () => {
        const record = projectWindowForModel(windowFixture(), [resultFixture()]);

        expect(record.id).toBe("event_window:turn1");
        expect(record.session).toBe("session:session1");
        expect(record.turn).toBe("turn:turn1");
        expect(record.text).toContain("USER:");
        expect(record.text).toContain("PREVIOUS_ASSISTANT:");
        expect(record.text).toContain("RECENT_TOOL_FAILURES:");
        expect(record.text).toContain("RECENT_FILES:");
        expect(record.light_labels).toEqual(["direction"]);
        expect(record.light_results[0]?.target).toBe("tooling_preference");
        expect(record.evidence).toEqual([
            { kind: "previous_assistant", ref: "turn:turn0" },
            { kind: "recent_tool_failure", ref: "tool_call:tc1" },
            { kind: "recent_edited_file", ref: "file:pyproject_toml" },
        ]);
        expect(record.approx_tokens).toBeGreaterThan(0);
    });

    test("adds recent edited files by session and turn sequence", () => {
        const [window] = enrichWindowsWithRecentEditedFiles([windowFixture({ recentFiles: [] })], [
            { turn: "turn:turn0", file: "file:old_file", session: "session:session1", seq: 7, ts: "2026-05-30T00:00:00Z" },
            { turn: "turn:turn2", file: "file:future_file", session: "session:session1", seq: 11, ts: "2026-05-30T00:00:00Z" },
        ]);

        expect(window?.recentFiles).toEqual(["old_file"]);
    });

    test("evaluates E1 gates", () => {
        const passing = evaluateWindowExportReport({
            days: 7,
            limit: 1000,
            out: ".ax/model-windows.jsonl",
            sourceTurns: 1000,
            exportedWindows: 1000,
            labeledWindows: 100,
            approxTokenP50: 120,
            approxTokenP95: 300,
            over384: 10,
            percentUnder384: 99,
            percentWithPreviousAssistant: 80,
            percentWithToolOrFileEvidence: 35,
        });
        expect(passing.failures).toEqual([]);

        const failing = evaluateWindowExportReport({
            ...passing,
            exportedWindows: 100,
            percentUnder384: 70,
            percentWithPreviousAssistant: 60,
        });
        expect(failing.failures).toContain("less than 500 model windows exported from local source data");
        expect(failing.failures).toContain("less than 80% of projected windows are under 384 approximate tokens");
        expect(failing.failures).toContain("less than 70% of projected windows have prior assistant context evidence");
    });

    test("builds aggregate export metrics", async () => {
        const windows = Array.from({ length: 5 }, (_, index) =>
            windowFixture({
                subjectId: `turn${index}`,
                userTurn: { ...windowFixture().userTurn, id: `turn${index}`, key: `turn${index}` },
            }),
        );
        const { report, records } = await buildWindowExportReport(
            { days: 7, limit: 5, out: ".ax/model-windows.jsonl", json: false },
            windows,
            [resultFixture({ subjectId: "turn0" })],
            5,
        );

        expect(records).toHaveLength(5);
        expect(report.exportedWindows).toBe(5);
        expect(report.labeledWindows).toBe(1);
        expect(report.percentWithPreviousAssistant).toBe(100);
    });

    test("counts approximate tokens with whitespace normalization", () => {
        expect(approxTokenCount(" one\n two\tthree ")).toBe(3);
    });
});
