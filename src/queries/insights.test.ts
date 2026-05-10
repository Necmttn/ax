import { describe, expect, test } from "bun:test";
import {
    SCHEMA_TABLES,
    checkoutActivitySql,
    gitCorrelationSql,
    recentFrictionSql,
    repositoryOverviewSql,
    schemaCoverageSql,
    sessionEvidenceSql,
    toolFailuresSql,
} from "./insights.ts";

const STALE_FIELDS = [
    "raw_kind",
    "identity_kind",
    "source",
    "confidence",
    "evidence_text",
    "remote_url_normalized",
    "last_seen_at",
] as const;

function expectNoStaleFields(sql: string) {
    for (const field of STALE_FIELDS) {
        expect(sql).not.toMatch(new RegExp(`\\b${field}\\b`));
    }
}

describe("insights query builders", () => {
    test("repositoryOverviewSql reads current repository fields and checkout relation", () => {
        const sql = repositoryOverviewSql(12);

        expect(sql).toContain("FROM repository");
        expect(sql).toContain("name");
        expect(sql).toContain("remote_url");
        expect(sql).toContain("root_path");
        expect(sql).toContain("initial_commit");
        expect(sql).toContain("default_branch");
        expect(sql).toContain("updated_at ?? created_at");
        expect(sql).toContain("->has_checkout->checkout");
        expect(sql).toContain("checkout_count");
        expect(sql).toContain("ORDER BY last_seen DESC");
        expect(sql).toContain("LIMIT 12");
        expectNoStaleFields(sql);
    });

    test("gitCorrelationSql summarizes session to git history links", () => {
        const sql = gitCorrelationSql(6);

        expect(sql).toContain("FROM repository");
        expect(sql).toContain("SELECT id FROM session WHERE repository = $parent.id");
        expect(sql).toContain("SELECT id FROM commit WHERE repository = $parent.id");
        expect(sql).toContain("SELECT id FROM touched WHERE repository = $parent.id");
        expect(sql).toContain("SELECT id FROM produced WHERE out.repository = $parent.id");
        expect(sql).toContain("checkout_linked_session_count");
        expect(sql).toContain("ORDER BY session_count DESC");
        expect(sql).toContain("LIMIT 6");
        expectNoStaleFields(sql);
    });

    test("checkoutActivitySql summarizes worktree-level activity", () => {
        const sql = checkoutActivitySql(8);

        expect(sql).toContain("FROM checkout");
        expect(sql).toContain("repository.name AS repository_name");
        expect(sql).toContain("worktree_name");
        expect(sql).toContain("SELECT id FROM session WHERE checkout = $parent.id");
        expect(sql).toContain("SELECT id FROM turn WHERE session.checkout = $parent.id");
        expect(sql).toContain("SELECT id FROM tool_call WHERE session.checkout = $parent.id");
        expect(sql).toContain(
            "SELECT id FROM tool_call WHERE session.checkout = $parent.id AND has_error = true",
        );
        expect(sql).toContain("SELECT id FROM produced WHERE in.checkout = $parent.id");
        expect(sql).toContain("SELECT id FROM touched WHERE checkout = $parent.id");
        expect(sql).toContain("ORDER BY session_count DESC, turn_count DESC");
        expect(sql).toContain("LIMIT 8");
        expectNoStaleFields(sql);
    });


    test("recentFrictionSql reads JSON payload fields without flattened evidence columns", () => {
        const sql = recentFrictionSql(25);

        expect(sql).toContain("FROM friction_event");
        expect(sql).toContain("kind");
        expect(sql).toContain("text");
        expect(sql).toContain("labels");
        expect(sql).toContain("metrics");
        expect(sql).toContain("raw");
        expect(sql).toContain("ORDER BY ts DESC");
        expect(sql).toContain("LIMIT 25");
        expectNoStaleFields(sql);
    });

    test("toolFailuresSql groups current tool_call error fields", () => {
        const sql = toolFailuresSql(7);

        expect(sql).toContain("FROM tool_call");
        expect(sql).toContain("WHERE has_error = true");
        expect(sql).toContain("GROUP BY name, command_norm, command_tool, exit_code");
        expect(sql).toContain("ORDER BY failure_count DESC");
        expect(sql).toContain("command_norm");
        expect(sql).toContain("command_tool");
        expect(sql).toContain("exit_code");
        expect(sql).toContain("LIMIT 7");
        expectNoStaleFields(sql);
    });

    test("sessionEvidenceSql summarizes sessions through current evidence tables", () => {
        const sql = sessionEvidenceSql(9);

        expect(sql).toContain("FROM session");
        expect(sql).toContain("SELECT id FROM tool_call WHERE session = $parent.id");
        expect(sql).toContain(
            "SELECT id FROM tool_call WHERE session = $parent.id AND has_error = true",
        );
        expect(sql).toContain("SELECT id FROM friction_event WHERE session = $parent.id");
        expect(sql).toContain("SELECT id FROM plan_snapshot WHERE session = $parent.id");
        expect(sql).toContain("ended_at ?? started_at");
        expect(sql).toContain("ORDER BY last_seen DESC");
        expect(sql).toContain("LIMIT 9");
        expectNoStaleFields(sql);
    });

    test("schemaCoverageSql returns scalar counts for active and staged tables", () => {
        const sql = schemaCoverageSql();

        expect(sql).toContain("RETURN [");
        expect(sql).toContain('table: "tool_call"');
        expect(sql).toContain('stage: "active"');
        expect(sql).toContain('table: "file_memory"');
        expect(sql).toContain('stage: "staged"');
        expect(sql).toContain("SELECT count() AS count FROM tool_call GROUP ALL");
        expect(sql).not.toContain("AS table");
        expect(SCHEMA_TABLES.some((spec) => spec.stage === "conditional")).toBe(true);
    });

    test("builders reject non-positive or fractional limits before interpolation", () => {
        expect(() => repositoryOverviewSql(0)).toThrow("positive integer");
        expect(() => recentFrictionSql(-1)).toThrow("positive integer");
        expect(() => toolFailuresSql(1.5)).toThrow("positive integer");
        expect(() => sessionEvidenceSql(Number.NaN)).toThrow("positive integer");
    });
});
