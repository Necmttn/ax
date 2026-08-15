import { describe, expect, test } from "bun:test";
import { buildHookLogQuery, formatHookLogRowsTsv, type HookLogRow } from "./log.ts";

describe("buildHookLogQuery", () => {
    test("default query orders by ts desc and limits to tail", () => {
        const { sql, params } = buildHookLogQuery({ tail: 20 });
        expect(sql).toContain("FROM hook_fire");
        expect(sql).toContain("ORDER BY ts DESC");
        expect(sql).toContain("LIMIT 20");
        // No WHERE clause when no filters provided.
        expect(sql).not.toContain("WHERE");
        expect(params).toEqual([]);
    });

    test("since adds a time::now() lower bound on ts", () => {
        const { sql, params } = buildHookLogQuery({ tail: 5, sinceHours: 2 });
        expect(sql).toContain("ts >= CURRENT_TIMESTAMP");
        expect(params).toEqual([2]);
    });

    test("reason filter is escaped as a string literal", () => {
        const { sql, params } = buildHookLogQuery({ tail: 10, reason: "suppressed_path" });
        expect(sql).toContain("reason = ?");
        expect(params).toEqual(["suppressed_path"]);
    });

    test("file filter targets file_path", () => {
        const { sql, params } = buildHookLogQuery({ tail: 10, file: "src/a.ts" });
        expect(sql).toContain("file_path = ?");
        expect(params).toEqual(["src/a.ts"]);
    });

    test("inject filter accepts true and false", () => {
        expect(buildHookLogQuery({ tail: 5, inject: true }).params).toEqual([true]);
        expect(buildHookLogQuery({ tail: 5, inject: false }).params).toEqual([false]);
    });

    test("harness filter is a string literal", () => {
        const { sql, params } = buildHookLogQuery({ tail: 5, harness: "claude" });
        expect(sql).toContain("harness = ?");
        expect(params).toEqual(["claude"]);
    });

    test("combines multiple filters with AND", () => {
        const { sql, params } = buildHookLogQuery({ tail: 5, sinceHours: 1, harness: "codex", inject: false });
        expect(sql).toContain("ts >= CURRENT_TIMESTAMP");
        expect(sql).toContain("harness = ?");
        expect(sql).toContain("inject = ?");
        expect((sql.match(/ AND /g) ?? []).length).toBeGreaterThanOrEqual(2);
        expect(params).toEqual([1, false, "codex"]);
    });

    test("binds single quotes instead of putting them in SQL", () => {
        const query = buildHookLogQuery({ tail: 5, reason: "no'malicious" });
        expect(query.sql).not.toContain("no'malicious");
        expect(query.params).toEqual(["no'malicious"]);
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
