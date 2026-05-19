import { describe, expect, test } from "bun:test";
import { buildHookLogQuery, formatHookLogRowsTsv, type HookLogRow } from "./log.ts";

describe("buildHookLogQuery", () => {
    test("default query orders by ts desc and limits to tail", () => {
        const sql = buildHookLogQuery({ tail: 20 });
        expect(sql).toContain("FROM hook_fire");
        expect(sql).toContain("ORDER BY ts DESC");
        expect(sql).toContain("LIMIT 20");
        // No WHERE clause when no filters provided.
        expect(sql).not.toContain("WHERE");
    });

    test("since adds a time::now() lower bound on ts", () => {
        const sql = buildHookLogQuery({ tail: 5, sinceHours: 2 });
        expect(sql).toMatch(/WHERE.*ts >= time::now\(\) - 2h/);
    });

    test("reason filter is escaped as a string literal", () => {
        const sql = buildHookLogQuery({ tail: 10, reason: "suppressed_path" });
        expect(sql).toContain("reason = 'suppressed_path'");
    });

    test("file filter targets file_path", () => {
        const sql = buildHookLogQuery({ tail: 10, file: "src/a.ts" });
        expect(sql).toContain("file_path = 'src/a.ts'");
    });

    test("inject filter accepts true and false", () => {
        expect(buildHookLogQuery({ tail: 5, inject: true })).toContain("inject = true");
        expect(buildHookLogQuery({ tail: 5, inject: false })).toContain("inject = false");
    });

    test("harness filter is a string literal", () => {
        const sql = buildHookLogQuery({ tail: 5, harness: "claude" });
        expect(sql).toContain("harness = 'claude'");
    });

    test("combines multiple filters with AND", () => {
        const sql = buildHookLogQuery({ tail: 5, sinceHours: 1, harness: "codex", inject: false });
        expect(sql).toContain("ts >= time::now() - 1h");
        expect(sql).toContain("harness = 'codex'");
        expect(sql).toContain("inject = false");
        expect((sql.match(/ AND /g) ?? []).length).toBeGreaterThanOrEqual(2);
    });

    test("rejects single quotes in literal values to prevent injection", () => {
        expect(() => buildHookLogQuery({ tail: 5, reason: "no'malicious" })).toThrow();
    });
});

describe("formatHookLogRowsTsv", () => {
    test("emits a header and one row per record, tab-separated", () => {
        const rows: HookLogRow[] = [
            {
                ts: new Date("2026-05-17T10:00:00Z"),
                harness: "claude",
                event: "pre-edit",
                file_path: "src/a.ts",
                inject: true,
                reason: "high_signal",
                latency_ms: 42,
                injected_titles: ["fix bug in foo", "refactor bar"],
            },
        ];
        const tsv = formatHookLogRowsTsv(rows);
        const lines = tsv.split("\n");
        expect(lines[0]).toBe(["ts", "harness", "event", "file", "inject", "reason", "latency_ms", "injected"].join("\t"));
        expect(lines[1]).toBe([
            "2026-05-17T10:00:00.000Z",
            "claude",
            "pre-edit",
            "src/a.ts",
            "true",
            "high_signal",
            "42",
            "fix bug in foo | refactor bar",
        ].join("\t"));
    });

    test("returns just the header when there are no rows", () => {
        const tsv = formatHookLogRowsTsv([]);
        expect(tsv).toBe(["ts", "harness", "event", "file", "inject", "reason", "latency_ms", "injected"].join("\t"));
    });

    test("empty injected_titles renders as empty trailing column", () => {
        const tsv = formatHookLogRowsTsv([{
            ts: new Date("2026-05-17T10:00:00Z"),
            harness: "claude",
            event: "read",
            file_path: "bun.lock",
            inject: false,
            reason: "suppressed_path",
            latency_ms: 0,
            injected_titles: [],
        }]);
        // 8 columns separated by 7 tabs; last column empty.
        const dataLine = tsv.split("\n")[1]!;
        expect(dataLine.split("\t").length).toBe(8);
        expect(dataLine.endsWith("\t")).toBe(true);
    });
});
