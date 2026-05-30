import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
    SCHEMA_TABLES,
    checkoutActivitySql,
    gitCorrelationSql,
    recentFrictionSql,
    repositoryOverviewSql,
    schemaCoverageSql,
    sessionEvidenceSql,
    feedbackLoopsSql,
    feedbackLanguageSql,
    messageSignalsSql,
    reactionThemesSql,
    reactionEventThemesSql,
    reactionEventsSql,
    classifierResultsSql,
    classifierFactsSql,
    correctionContextsSql,
    classifierOutcomesSql,
    harnessCandidatesSql,
    classifierThemesSql,
    reactionsSql,
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

function liveSchemaTables(): string[] {
    const schema = readFileSync("schema/schema.surql", "utf8");
    const defined = [...schema.matchAll(/^DEFINE TABLE(?: IF NOT EXISTS)? ([A-Za-z_][A-Za-z0-9_]*)/gm)]
        .map((match) => match[1]!);
    return [...new Set(defined)].sort();
}

function expectNoStaleFields(sql: string) {
    for (const field of STALE_FIELDS) {
        expect(sql).not.toMatch(new RegExp(`\\b${field}\\b`));
    }
}

describe("insights query builders", () => {
    test("SCHEMA_TABLES mirrors schema tables", () => {
        expect(SCHEMA_TABLES.map((spec) => spec.table).sort()).toEqual(liveSchemaTables());
    });

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
        expect(sql).toContain('table: "agent_provider"');
        expect(sql).toContain('table: "agent_event"');
        expect(sql).toContain('table: "role"');
        expect(sql).toContain('table: "plays_role"');
        expect(sql).toContain('table: "guidance_source"');
        expect(sql).toContain('table: "guidance_revision"');
        expect(sql).toContain('table: "command_outcome"');
        expect(sql).toContain('table: "user_message_ngram"');
        expect(sql).toContain('table: "turn_analysis"');
        expect(sql).toContain('table: "reaction_event"');
        expect(sql).toContain('table: "semantic_signal"');
        expect(sql).toContain('table: "expresses"');
        expect(sql).toContain('table: "reacts_to"');
        expect(sql).toContain('table: "workflow_epoch"');
        expect(sql).toContain('table: "session_token_usage"');
        expect(sql).toContain('table: "session_health"');
        expect(sql).toContain('table: "commit_classification"');
        expect(sql).toContain('table: "skill_candidate"');
        expect(sql).toContain('table: "later_fixed_by"');
        expect(sql).toContain('table: "proposal"');
        expect(sql).toContain('table: "experiment"');
        expect(sql).toContain('table: "checkpoint"');
        expect(sql).toContain('table: "harness_hook_event"');
        expect(sql).toContain('table: "hook_command_invocation"');
        expect(sql).toContain('table: "hook_fire"');
        expect(sql).toContain('table: "feedback_case_type"');
        expect(sql).toContain('table: "feedback_case_result"');
        expect(sql).toContain('table: "retro"');
        expect(sql).toContain('table: "reviewed"');
        expect(sql).toContain('table: "ingest_run"');
        expect(sql).toContain('table: "ingest_stage"');
        expect(sql).toContain('table: "ingest_event"');
        expect(sql).toContain("SELECT count() AS count FROM tool_call GROUP ALL");
        expect(sql).not.toContain("AS table");
        expect(SCHEMA_TABLES.some((spec) => spec.stage === "conditional")).toBe(false);
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

    test("feedbackLanguageSql reads promoted user feedback signals with examples", () => {
        const sql = feedbackLanguageSql(10);

        expect(sql).toContain("FROM semantic_signal");
        expect(sql).toContain('kind IN ["feedback", "correction"]');
        expect(sql).not.toContain('"ask"');
        expect(sql).toContain('out = $parent.id AND in.role = "user"');
        expect(sql).toContain("canonical_text");
        expect(sql).toContain("examples");
        expect(sql).toContain("LIMIT 10");
    });

    test("messageSignalsSql reads all semantic signals with example turns", () => {
        const sql = messageSignalsSql(10);

        expect(sql).toContain("FROM semantic_signal");
        expect(sql).toContain("SELECT id FROM expresses WHERE out = $parent.id");
        expect(sql).toContain("SELECT id FROM turn_analysis");
        expect(sql).toContain("AS avg_confidence");
        expect(sql).toContain("in.text_excerpt AS text");
        expect(sql).toContain("ORDER BY turns DESC");
    });

    test("reactionsSql reads user reaction turns with prior assistant context", () => {
        const sql = reactionsSql(10);

        expect(sql).toContain("FROM reacts_to");
        expect(sql).toContain("polarity");
        expect(sql).toContain("signal.label AS signal");
        expect(sql).toContain("in.text_excerpt AS user_text");
        expect(sql).toContain("out.text_excerpt AS assistant_text");
        expect(sql).toContain("ORDER BY ts DESC");
        expect(sql).toContain("LIMIT 10");
    });

    test("reactionThemesSql groups reaction edges by promoted semantic signal", () => {
        const sql = reactionThemesSql(10);

        expect(sql).toContain("FROM semantic_signal");
        expect(sql).toContain('kind IN ["feedback", "correction"]');
        expect(sql).toContain("SELECT id FROM reacts_to WHERE signal = $parent.id");
        expect(sql).toContain('polarity = "revise"');
        expect(sql).toContain("in.text_excerpt AS user_text");
        expect(sql).toContain("out.text_excerpt AS assistant_text");
        expect(sql).toContain("ORDER BY reactions DESC");
        expect(sql).toContain("LIMIT 10");
    });

    test("reactionEventsSql reads context-aware reaction events", () => {
        const sql = reactionEventsSql(10);

        expect(sql).toContain("FROM reaction_event");
        expect(sql).toContain("reaction_type");
        expect(sql).toContain("target");
        expect(sql).toContain("durability");
        expect(sql).toContain("user_text");
        expect(sql).toContain("assistant_text");
        expect(sql).toContain("context_json");
        expect(sql).toContain("ORDER BY ts DESC");
    });

    test("reactionEventThemesSql clusters context-aware reaction events", () => {
        const sql = reactionEventThemesSql(10);

        expect(sql).toContain("FROM reaction_event");
        expect(sql).toContain("GROUP BY reaction_type, target, durability");
        expect(sql).toContain("array::len(array::distinct(session)) AS sessions");
        expect(sql).toContain("ORDER BY events DESC");
    });

    test("classifier result insights read generic classifier tables", () => {
        const sql = classifierResultsSql(10);

        expect(sql).toContain("FROM classifier_result");
        expect(sql).toContain("classifier_key");
        expect(sql).toContain("evidence_json");
        expect(sql).toContain("ORDER BY ts DESC");
    });

    test("classifierFactsSql joins facts to user turn, prior assistant, and tool failures", () => {
        const sql = classifierFactsSql(10);

        expect(sql).toContain("FROM classifier_result");
        expect(sql).toContain("turn.text_excerpt AS user_text");
        expect(sql).toContain("AS previous_assistant");
        expect(sql).toContain('role = "assistant"');
        expect(sql).toContain("seq < $parent.turn.seq");
        expect(sql).toContain("FROM tool_call");
        expect(sql).toContain("has_error = true");
        expect(sql).toContain("AS recent_tool_failures");
        expect(sql).toContain("WHERE turn IS NOT NONE");
        expect(sql).toContain("ORDER BY ts DESC");
    });

    test("correctionContextsSql focuses correction facts with causal context", () => {
        const sql = correctionContextsSql(10);

        expect(sql).toContain("FROM classifier_result");
        expect(sql).toContain('classifier_key = "correction-event" OR label = "correction"');
        expect(sql).toContain("turn.text_excerpt AS user_text");
        expect(sql).toContain("AS previous_assistant");
        expect(sql).toContain("FROM tool_call");
        expect(sql).toContain("has_error = true");
        expect(sql).toContain("LIMIT 5");
    });

    test("classifierOutcomesSql connects facts to later tools, outcomes, and user turns", () => {
        const sql = classifierOutcomesSql(10);

        expect(sql).toContain("FROM classifier_result");
        expect(sql).toContain("turn.text_excerpt AS user_text");
        expect(sql).toContain("AS later_tool_calls");
        expect(sql).toContain("FROM tool_call");
        expect(sql).toContain("ts > $parent.ts");
        expect(sql).toContain("AS later_command_outcomes");
        expect(sql).toContain("FROM command_outcome");
        expect(sql).toContain("AS later_user_turns");
        expect(sql).toContain('role = "user"');
        expect(sql).toContain("seq > $parent.turn.seq");
    });

    test("harnessCandidatesSql groups repeated facts into suggested harness actions", () => {
        const sql = harnessCandidatesSql(10);

        expect(sql).toContain("FROM classifier_result");
        expect(sql).toContain('["classifier_harness_candidate", classifier_key, label, target, durability] AS candidate_id');
        expect(sql).toContain("[classifier_key, label, target, durability] AS dedupe_signature");
        expect(sql).toContain("AS proposed_layer");
        expect(sql).toContain("AS proposed_action");
        expect(sql).toContain("add_verification_gate");
        expect(sql).toContain("record_environment_preference");
        expect(sql).toContain("add_context_guardrail");
        expect(sql).toContain("AS examples");
        expect(sql).toContain("FROM cites_evidence");
        expect(sql).toContain("AS evidence");
        expect(sql).toContain("GROUP BY classifier_key, label, target, durability");
    });

    test("classifierThemesSql groups versioned classifier labels", () => {
        const sql = classifierThemesSql(10);

        expect(sql).toContain("FROM classifier_result");
        expect(sql).toContain("GROUP BY classifier_key, label, target, durability");
        expect(sql).toContain("array::len(array::distinct(session)) AS sessions");
        expect(sql).toContain("ORDER BY results DESC");
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
