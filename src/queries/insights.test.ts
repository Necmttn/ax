import { describe, expect, test } from "bun:test";
import {
    SCHEMA_TABLES,
    checkoutActivitySql,
    gitCorrelationSql,
    recentFrictionSql,
    repositoryOverviewSql,
    schemaCoverageSql,
    sessionEvidenceSql,
    fileEvidenceSql,
    feedbackLoopsSql,
    userLanguageSql,
    verificationGapsSql,
    tokenImpactSql,
    cacheHealthSql,
    workflowImpactSql,
    codexHealthSql,
    closureSql,
    postFeatureFixesSql,
    skillCandidatesSql,
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

    test("fileEvidenceSql summarizes provider-neutral edit/read/search relations", () => {
        const sql = fileEvidenceSql(4);

        expect(sql).toContain("RETURN [");
        expect(sql).toContain('relation: "edited"');
        expect(sql).toContain("FROM edited");
        expect(sql).toContain("session.source AS source");
        expect(sql).toContain('relation: "read_file"');
        expect(sql).toContain("FROM read_file");
        expect(sql).toContain("in.session.source AS source");
        expect(sql).toContain('relation: "searched_file"');
        expect(sql).toContain("FROM searched_file");
        expect(sql).toContain("GROUP BY source, tool, evidence");
        expect(sql).toContain("LIMIT 4");
        expect(sql).not.toContain("raw_kind");
        expect(sql).not.toContain("identity_kind");
    });

    test("schemaCoverageSql returns scalar counts for active and staged tables", () => {
        const sql = schemaCoverageSql();

        expect(sql).toContain("RETURN [");
        expect(sql).toContain('table: "tool_call"');
        expect(sql).toContain('stage: "active"');
        expect(sql).toContain('table: "file_memory"');
        expect(sql).toContain('stage: "staged"');
        expect(sql).toContain('table: "guidance_source"');
        expect(sql).toContain('table: "guidance_revision"');
        expect(sql).toContain('table: "harness_learning"');
        expect(sql).toContain('table: "intervention_observation"');
        expect(sql).toContain('table: "command_outcome"');
        expect(sql).toContain('table: "user_message_ngram"');
        expect(sql).toContain('table: "workflow_epoch"');
        expect(sql).toContain('table: "session_token_usage"');
        expect(sql).toContain('table: "session_health"');
        expect(sql).toContain('table: "commit_classification"');
        expect(sql).toContain('table: "skill_candidate"');
        expect(sql).toContain('table: "later_fixed_by"');
        expect(sql).toContain('table: "gotcha"');
        expect(sql).toContain('table: "learning_match"');
        expect(sql).toContain('table: "adoption"');
        expect(sql).toContain("SELECT count() AS count FROM tool_call GROUP ALL");
        expect(sql).not.toContain("AS table");
        expect(SCHEMA_TABLES.some((spec) => spec.stage === "conditional")).toBe(true);
    });

    test("feedbackLoopsSql reads semantic command outcome rows", () => {
        const sql = feedbackLoopsSql(10);

        expect(sql).toContain("FROM command_outcome");
        expect(sql).toContain('WHERE kind != "success" AND command_norm IS NOT NONE');
        expect(sql).toContain("GROUP BY kind, command_norm");
        expect(sql).toContain("ORDER BY errors DESC, runs DESC");
        expect(sql).toContain("LIMIT 10");
    });

    test("verificationGapsSql finds edited sessions without verification outcomes", () => {
        const sql = verificationGapsSql(10);

        expect(sql).toContain("FROM edited");
        expect(sql).toContain("GROUP BY session");
        expect(sql).toContain("FROM command_outcome WHERE session = $parent.session");
        expect(sql).toContain("verification_commands = 0");
    });

    test("userLanguageSql reads user-message ngrams", () => {
        const sql = userLanguageSql(10);

        expect(sql).toContain("FROM user_message_ngram");
        expect(sql).toContain("near_correction_count");
        expect(sql).toContain("AS signal_count");
        expect(sql).toContain("ORDER BY signal_count DESC");
    });

    test("token and workflow health builders read derived session health tables", () => {
        expect(tokenImpactSql(5)).toContain("FROM session_token_usage");
        expect(tokenImpactSql(5)).toContain("GROUP BY workflow_epoch, source");
        expect(cacheHealthSql(5)).toContain("cache_read_input_tokens / prompt_tokens");
        expect(workflowImpactSql(5)).toContain("FROM session_health");
        expect(workflowImpactSql(5)).toContain("avg_interruptions");
        expect(codexHealthSql(5)).toContain('WHERE source = "codex" AND estimated_tokens > 0');
        expect(codexHealthSql(5)).toContain("ORDER BY estimated_tokens DESC");
    });

    test("closure builders read commit lifecycle and skill candidate tables", () => {
        expect(closureSql(5)).toContain("FROM commit_classification");
        expect(postFeatureFixesSql(5)).toContain("FROM later_fixed_by");
        expect(postFeatureFixesSql(5)).toContain("overlap_count");
        expect(skillCandidatesSql(5)).toContain("FROM skill_candidate");
        expect(skillCandidatesSql(5)).toContain("proposed_behavior");
        expect(skillCandidatesSql(5)).toContain("AS confidence_score");
    });

    test("builders reject non-positive or fractional limits before interpolation", () => {
        expect(() => repositoryOverviewSql(0)).toThrow("positive integer");
        expect(() => recentFrictionSql(-1)).toThrow("positive integer");
        expect(() => toolFailuresSql(1.5)).toThrow("positive integer");
        expect(() => sessionEvidenceSql(Number.NaN)).toThrow("positive integer");
    });
});
