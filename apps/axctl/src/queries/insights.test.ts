import { describe, expect, test } from "bun:test";
import schemaSurql from "@ax/schema/schema.surql" with { type: "text" };
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
    const defined = [...schemaSurql.matchAll(/^DEFINE TABLE(?: IF NOT EXISTS)? ([A-Za-z_][A-Za-z0-9_]*)/gm)]
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

        expect(sql).toContain("FROM repository r");
        expect(sql).toContain("r.name AS name");
        expect(sql).toContain("r.remote_url AS remote_url");
        expect(sql).toContain("r.root_path AS root_path");
        expect(sql).toContain("r.initial_commit AS initial_commit");
        expect(sql).toContain("r.default_branch AS default_branch");
        expect(sql).toContain("COALESCE(r.updated_at, r.created_at) AS last_seen");
        expect(sql).toContain("LEFT JOIN has_checkout hc ON hc.in_id = r.id");
        expect(sql).toContain("LEFT JOIN checkout c ON c.id = hc.out_id");
        expect(sql).toContain("checkout_count");
        expect(sql).toContain("ORDER BY last_seen DESC");
        expect(sql).toContain("LIMIT 12");
        expectNoStaleFields(sql);
    });

    test("gitCorrelationSql summarizes session to git history links", () => {
        const sql = gitCorrelationSql(6);

        expect(sql).toContain("FROM repository r");
        expect(sql).toContain("SELECT COUNT(*) FROM session s WHERE s.repository = r.id");
        expect(sql).toContain('SELECT COUNT(*) FROM "commit" cm WHERE cm.repository = r.id');
        expect(sql).toContain("SELECT COUNT(*) FROM touched WHERE repository = r.id");
        expect(sql).toContain("SELECT COUNT(*) FROM produced WHERE repository = r.id");
        expect(sql).toContain("checkout_linked_session_count");
        expect(sql).toContain("ORDER BY session_count DESC");
        expect(sql).toContain("LIMIT 6");
        expectNoStaleFields(sql);
    });

    test("checkoutActivitySql summarizes worktree-level activity", () => {
        const sql = checkoutActivitySql(8);

        expect(sql).toContain("FROM checkout c");
        expect(sql).toContain("r.name AS repository_name");
        expect(sql).toContain("worktree_name");
        expect(sql).toContain("SELECT COUNT(*) FROM session s WHERE s.checkout = c.id");
        expect(sql).toContain(
            "SELECT COUNT(*) FROM turn t JOIN session s ON s.id = t.session WHERE s.checkout = c.id",
        );
        expect(sql).toContain(
            "SELECT COUNT(*) FROM tool_call tc JOIN session s ON s.id = tc.session WHERE s.checkout = c.id",
        );
        expect(sql).toContain(
            "SELECT COUNT(*) FROM tool_call tc JOIN session s ON s.id = tc.session WHERE s.checkout = c.id AND tc.has_error = TRUE",
        );
        expect(sql).toContain("SELECT COUNT(*) FROM produced p WHERE p.checkout = c.id");
        expect(sql).toContain("SELECT COUNT(*) FROM touched WHERE checkout = c.id");
        expect(sql).toContain("ORDER BY session_count DESC, turn_count DESC");
        expect(sql).toContain("LIMIT 8");
        expectNoStaleFields(sql);
    });


    test("recentFrictionSql reads JSON payload fields without flattened evidence columns", () => {
        const sql = recentFrictionSql(25);

        expect(sql).toContain("FROM friction_event fe");
        expect(sql).toContain("fe.kind AS kind");
        expect(sql).toContain("fe.text AS text");
        expect(sql).toContain("fe.labels AS labels");
        expect(sql).toContain("fe.metrics AS metrics");
        expect(sql).toContain("fe.raw AS raw");
        expect(sql).toContain("ORDER BY fe.ts DESC");
        expect(sql).toContain("LIMIT 25");
        expectNoStaleFields(sql);
    });

    test("toolFailuresSql groups current tool_call error fields", () => {
        const sql = toolFailuresSql(7);

        expect(sql).toContain("FROM tool_call");
        expect(sql).toContain("WHERE has_error = TRUE");
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

        expect(sql).toContain("FROM session s");
        expect(sql).toContain("SELECT COUNT(*) FROM tool_call tc WHERE tc.session = s.id");
        expect(sql).toContain(
            "SELECT COUNT(*) FROM tool_call tc WHERE tc.session = s.id AND tc.has_error = TRUE",
        );
        expect(sql).toContain("SELECT COUNT(*) FROM friction_event fe WHERE fe.session = s.id");
        expect(sql).toContain("SELECT COUNT(*) FROM plan_snapshot ps WHERE ps.session = s.id");
        expect(sql).toContain("COALESCE(s.ended_at, s.started_at) AS last_seen");
        expect(sql).toContain("ORDER BY last_seen DESC");
        expect(sql).toContain("LIMIT 9");
        expectNoStaleFields(sql);
    });

    test("fileEvidenceSql summarizes provider-neutral edit/read/search relations", () => {
        const sql = fileEvidenceSql(4);

        // SurrealDB's RETURN [{relation, rows}] shape has no DuckDB equivalent
        // in one statement - this is a flat UNION ALL rowset with `relation`
        // as the discriminator column instead.
        expect(sql).toContain("UNION ALL");
        expect(sql).toContain("'edited' AS relation");
        expect(sql).toContain("FROM edited e");
        expect(sql).toContain("s.source AS source");
        expect(sql).toContain("'read_file' AS relation");
        expect(sql).toContain("FROM read_file rf");
        expect(sql).toContain("'searched_file' AS relation");
        expect(sql).toContain("FROM searched_file sf");
        expect(sql).toContain("GROUP BY s.source, e.tool");
        expect(sql).toContain("LIMIT 4");
        expect(sql).not.toContain("raw_kind");
        expect(sql).not.toContain("identity_kind");
    });

    test("schemaCoverageSql returns scalar counts for active and staged tables", () => {
        const sql = schemaCoverageSql();

        // SurrealDB's RETURN [{table, stage, note, count}] shape has no
        // DuckDB equivalent in one statement - this UNIONs one flat row per
        // registered table instead.
        expect(sql).toContain("UNION ALL");
        expect(sql).toContain("'tool_call' AS table_name");
        expect(sql).toContain("'active' AS stage");
        expect(sql).toContain("'workspace' AS table_name");
        expect(sql).toContain("'staged' AS stage");
        expect(sql).toContain("'agent_provider' AS table_name");
        expect(sql).toContain("'agent_event' AS table_name");
        expect(sql).toContain("'role' AS table_name");
        expect(sql).toContain("'plays_role' AS table_name");
        expect(sql).toContain("'guidance_source' AS table_name");
        expect(sql).toContain("'guidance_revision' AS table_name");
        expect(sql).toContain("'command_outcome' AS table_name");
        expect(sql).toContain("'user_message_ngram' AS table_name");
        expect(sql).toContain("'turn_analysis' AS table_name");
        expect(sql).toContain("'reaction_event' AS table_name");
        expect(sql).toContain("'semantic_signal' AS table_name");
        expect(sql).toContain("'expresses' AS table_name");
        expect(sql).toContain("'reacts_to' AS table_name");
        expect(sql).toContain("'workflow_epoch' AS table_name");
        expect(sql).toContain("'session_token_usage' AS table_name");
        expect(sql).toContain("'session_health' AS table_name");
        expect(sql).toContain("'commit_classification' AS table_name");
        expect(sql).toContain("'skill_candidate' AS table_name");
        expect(sql).toContain("'later_fixed_by' AS table_name");
        expect(sql).toContain("'proposal' AS table_name");
        expect(sql).toContain("'experiment' AS table_name");
        expect(sql).toContain("'checkpoint' AS table_name");
        expect(sql).toContain("'harness_hook_event' AS table_name");
        expect(sql).toContain("'hook_command_invocation' AS table_name");
        expect(sql).toContain("'hook_fire' AS table_name");
        expect(sql).toContain("'feedback_case_type' AS table_name");
        expect(sql).toContain("'feedback_case_result' AS table_name");
        expect(sql).toContain("'retro' AS table_name");
        expect(sql).toContain("'reviewed' AS table_name");
        expect(sql).toContain("'ingest_run' AS table_name");
        expect(sql).toContain("'ingest_stage' AS table_name");
        expect(sql).toContain("'ingest_event' AS table_name");
        expect(sql).toContain('(SELECT COUNT(*) FROM "tool_call") AS count');
        expect(SCHEMA_TABLES.some((spec) => spec.stage === "conditional")).toBe(false);
    });

    // packages/schema/src/schema.duckdb.sql has not landed DDL for every
    // SCHEMA_TABLES entry yet (the improve/proposal/experiment/retro/dogfood
    // subsystem, and the plays_role edge - owned by other in-flight chunks).
    // A live-catalog check against the real snapshot confirmed `FROM "role"`
    // hard-errors the ENTIRE UNION ALL statement (a Catalog Error, unlike
    // SurrealDB which returns 0 rows for an undefined table under SCHEMAFULL).
    // Those rows degrade to a literal 0 instead of a live subquery so the view
    // stays usable; re-check this list once those chunks land their tables.
    test("schemaCoverageSql degrades not-yet-migrated tables to a literal 0 count", () => {
        const sql = schemaCoverageSql();

        expect(sql).toContain("'role' AS table_name, 'active' AS stage");
        expect(sql).toContain("Skill role labels used for weighting and grouping.' AS note, 0 AS count");
        expect(sql).not.toContain('FROM "role"');
        expect(sql).not.toContain('FROM "proposal"');
        expect(sql).not.toContain('FROM "plays_role"');
        // A table WITH DuckDB DDL keeps its live subquery.
        expect(sql).toContain('(SELECT COUNT(*) FROM "skill") AS count');
    });

    test("feedbackLoopsSql reads semantic command outcome rows", () => {
        const sql = feedbackLoopsSql(10);

        expect(sql).toContain("FROM command_outcome");
        expect(sql).toContain("WHERE kind != 'success' AND command_norm IS NOT NULL");
        expect(sql).toContain("GROUP BY kind, command_norm");
        expect(sql).toContain("ORDER BY errors DESC, runs DESC");
        expect(sql).toContain("LIMIT 10");
    });

    test("verificationGapsSql finds edited sessions without verification outcomes", () => {
        const sql = verificationGapsSql(10);

        expect(sql).toContain("FROM edited e");
        expect(sql).toContain("GROUP BY t.session");
        // Anti-join against the verified-session set (computed once), not a
        // per-row correlated `session = $parent.session` subquery.
        expect(sql).not.toContain("$parent.session");
        expect(sql).toContain("NOT IN");
        expect(sql).toContain("FROM command_outcome");
        expect(sql).toContain("0 AS verification_commands");
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

        expect(sql).toContain("FROM semantic_signal ss");
        expect(sql).toContain("ss.kind IN ('feedback', 'correction')");
        expect(sql).not.toContain('"ask"');
        expect(sql).toContain("e.out_id = ss.id AND t.role = 'user'");
        expect(sql).toContain("canonical_text");
        expect(sql).toContain("examples");
        expect(sql).toContain("LIMIT 10");
    });

    test("messageSignalsSql reads all semantic signals with example turns", () => {
        const sql = messageSignalsSql(10);

        expect(sql).toContain("FROM semantic_signal ss");
        expect(sql).toContain("SELECT COUNT(*) FROM expresses e WHERE e.out_id = ss.id");
        expect(sql).toContain("FROM turn_analysis ta");
        expect(sql).toContain("AS avg_confidence");
        expect(sql).toContain("t.text_excerpt AS text");
        expect(sql).toContain("ORDER BY turns DESC");
    });

    test("reactionsSql reads user reaction turns with prior assistant context", () => {
        const sql = reactionsSql(10);

        expect(sql).toContain("FROM reacts_to rt");
        expect(sql).toContain("rt.polarity AS polarity");
        expect(sql).toContain("ss.label AS signal");
        expect(sql).toContain("ut.text_excerpt AS user_text");
        expect(sql).toContain("atn.text_excerpt AS assistant_text");
        expect(sql).toContain("ORDER BY rt.ts DESC");
        expect(sql).toContain("LIMIT 10");
    });

    test("reactionThemesSql groups reaction edges by promoted semantic signal", () => {
        const sql = reactionThemesSql(10);

        expect(sql).toContain("FROM semantic_signal ss");
        expect(sql).toContain("ss.kind IN ('feedback', 'correction')");
        expect(sql).toContain("SELECT COUNT(*) FROM reacts_to rt WHERE rt.signal = ss.id");
        expect(sql).toContain("rt.polarity = 'revise'");
        expect(sql).toContain("ut.text_excerpt AS user_text");
        expect(sql).toContain("atn.text_excerpt AS assistant_text");
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
        expect(sql).toContain("COUNT(DISTINCT session) AS sessions");
        expect(sql).toContain("ORDER BY events DESC");
    });

    test("classifier result insights read generic classifier tables", () => {
        const sql = classifierResultsSql(10);

        expect(sql).toContain("FROM classifier_result");
        expect(sql).toContain("classifier_key");
        expect(sql).toContain("evidence_json");
        expect(sql).toContain("ORDER BY ts DESC");
    });

    // The per-row context (previous assistant / failures / later activity) is
    // resolved post-query by enrichInsightRows with literal session ids; the
    // view SQL itself must stay free of correlated $parent.* subqueries.
    test("classifierFactsSql selects classifier rows without correlated context subqueries", () => {
        const sql = classifierFactsSql(10);

        expect(sql).toContain("FROM classifier_result cr");
        expect(sql).toContain("t.text_excerpt AS user_text");
        expect(sql).toContain("WHERE cr.turn IS NOT NULL");
        expect(sql).toContain("ORDER BY cr.ts DESC");
        expect(sql).not.toContain("$parent");
    });

    test("correctionContextsSql focuses correction facts without correlated subqueries", () => {
        const sql = correctionContextsSql(10);

        expect(sql).toContain("FROM classifier_result cr");
        expect(sql).toContain("cr.classifier_key = 'correction-event' OR cr.label = 'correction'");
        expect(sql).toContain("t.text_excerpt AS user_text");
        expect(sql).not.toContain("$parent");
    });

    test("classifierOutcomesSql selects classifier rows without correlated subqueries", () => {
        const sql = classifierOutcomesSql(10);

        expect(sql).toContain("FROM classifier_result cr");
        expect(sql).toContain("t.text_excerpt AS user_text");
        expect(sql).toContain("WHERE cr.turn IS NOT NULL");
        expect(sql).not.toContain("$parent");
    });

    test("harnessCandidatesSql groups repeated facts into suggested harness actions", () => {
        const sql = harnessCandidatesSql(10);

        expect(sql).toContain("FROM classifier_result");
        expect(sql).toContain(
            "to_json(['classifier_harness_candidate', g.classifier_key, g.label, g.target, g.durability]) AS candidate_id",
        );
        expect(sql).toContain("to_json([g.classifier_key, g.label, g.target, g.durability]) AS dedupe_signature");
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
        expect(sql).toContain("COUNT(DISTINCT session) AS sessions");
        expect(sql).toContain("ORDER BY results DESC");
    });

    test("token and workflow health builders read derived session health tables", () => {
        expect(tokenImpactSql(5)).toContain("FROM session_token_usage stu");
        expect(tokenImpactSql(5)).toContain("GROUP BY we.name, stu.source");
        expect(cacheHealthSql(5)).toContain(
            "CAST(stu.cache_read_input_tokens AS DOUBLE) / NULLIF(stu.prompt_tokens, 0)",
        );
        expect(workflowImpactSql(5)).toContain("FROM session_health sh");
        expect(workflowImpactSql(5)).toContain("avg_interruptions");
        expect(codexHealthSql(5)).toContain(
            "WHERE sh.source IN ('codex', 'codex-subagent') AND sh.estimated_tokens > 0",
        );
        expect(codexHealthSql(5)).toContain("ORDER BY sh.estimated_tokens DESC");
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
