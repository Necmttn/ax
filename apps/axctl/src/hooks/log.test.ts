import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { publishCacheFixture, readFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { buildHookLogQuery, formatHookLogRowsTsv, queryHookLog, type HookLogRow } from "./log.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("hook log", { requireFts: true });

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

    test("since adds a now-minus-N-hours lower bound on ts, double-cast so it binds", () => {
        const { sql, params } = buildHookLogQuery({ tail: 5, sinceHours: 2 });
        // Both casts matter and are pinned here: CURRENT_TIMESTAMP -> TIMESTAMP
        // (a TIMESTAMPTZ has no `-(TIMESTAMPTZ, INTERVAL)` overload without the
        // ICU extension, which this build does not have) and the placeholder ->
        // INTEGER (an untyped `?` cannot resolve the multiplication into an
        // INTERVAL). See @ax/lib/duckdb/clause's `agoExpr` for the full story;
        // dtest("actually filters by the window against a real DuckDB", ...)
        // below is the part a SQL-text assertion like this one cannot cover.
        expect(sql).toContain("ts >= CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - (CAST(? AS INTEGER) * INTERVAL '1 hour')");
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
        expect(sql).toContain("ts >= CAST(CURRENT_TIMESTAMP AS TIMESTAMP)");
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

describe("queryHookLog", () => {
    const hookFireRow = (id: string, ts: Date) => ({
        id,
        ts,
        kind: "hook_fire",
        session: "session:abc",
        file: null,
        file_path: "src/a.ts",
        harness: "claude",
        ok: true,
        latency_ms: 5,
        event: "pre-edit",
        inject: true,
        reason: "high_signal",
        prior_sessions_considered: 1,
        task_excerpt: "test",
        top_prior_sessions: "[]",
        injected_titles: "[]",
    });

    // The bug this pins: `ts >= CURRENT_TIMESTAMP - (? * INTERVAL '1 hour')`
    // is SQL text that LOOKS right and never binds against real DuckDB (see
    // @ax/lib/duckdb/clause's `agoExpr` doc). A SQL-text assertion like the
    // ones in "buildHookLogQuery" above cannot tell that apart from a query
    // that actually filters correctly - only running it can.
    dtest("actually filters by the --since window against a real DuckDB", async () => {
        const now = new Date();
        const recent = new Date(now.getTime() - 10 * 60_000); // 10 minutes ago
        const old = new Date(now.getTime() - 5 * 60 * 60_000); // 5 hours ago
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-hook-log-since-"), dylibPath, (write: CacheWriteService) =>
                write.putMany("hook_fire", [
                    hookFireRow("hook-recent", recent),
                    hookFireRow("hook-old", old),
                ]),
            ),
        );

        const rows = await Effect.runPromise(
            queryHookLog({ tail: 100, sinceHours: 1 }).pipe(
                Effect.provide(readFixture(fixture.snapshotPath, dylibPath)),
                Effect.scoped,
            ),
        );

        expect(rows.map((r) => r.file_path)).toEqual(["src/a.ts"]);
        expect(rows).toHaveLength(1);
    });

    dtest("with no --since, both rows come back regardless of age", async () => {
        const now = new Date();
        const recent = new Date(now.getTime() - 10 * 60_000);
        const old = new Date(now.getTime() - 5 * 60 * 60_000);
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-hook-log-nosince-"), dylibPath, (write: CacheWriteService) =>
                write.putMany("hook_fire", [
                    hookFireRow("hook-recent", recent),
                    hookFireRow("hook-old", old),
                ]),
            ),
        );

        const rows = await Effect.runPromise(
            queryHookLog({ tail: 100 }).pipe(
                Effect.provide(readFixture(fixture.snapshotPath, dylibPath)),
                Effect.scoped,
            ),
        );

        expect(rows).toHaveLength(2);
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
