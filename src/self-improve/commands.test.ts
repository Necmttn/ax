import { describe, expect, test } from "bun:test";
import { guidanceNextSql, parseSelfImproveArgs, sessionSummarySql, weeklyEvidenceSql } from "./commands.ts";

describe("self improve command args", () => {
    test("guidance next requires json flag for machine output", () => {
        expect(parseSelfImproveArgs("guidance", ["next", "--json"])).toEqual({ command: "guidance-next", json: true });
    });

    test("session summary accepts json flag", () => {
        expect(parseSelfImproveArgs("session", ["summary", "--json"])).toEqual({ command: "session-summary", json: true });
    });

    test("self-improve weekly accepts json flag", () => {
        expect(parseSelfImproveArgs("self-improve", ["weekly", "--json"])).toEqual({ command: "weekly", json: true });
    });
});

test("weeklyEvidenceSql loads sessions and tool calls", () => {
    const sql = weeklyEvidenceSql(7);
    expect(sql).toContain("FROM session");
    expect(sql).toContain("FROM tool_call");
});

test("guidanceNextSql selects fields used for ordering", () => {
    const sql = guidanceNextSql();
    expect(sql).toContain("created_at");
    expect(sql).toContain("ORDER BY created_at DESC");
});

test("sessionSummarySql orders by a selected alias", () => {
    const sql = sessionSummarySql();
    expect(sql).toContain("(ended_at ?? started_at) AS last_seen_at");
    expect(sql).toContain("ORDER BY last_seen_at DESC");
    expect(sql).not.toContain("ORDER BY (ended_at ?? started_at)");
});
