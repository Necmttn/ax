/**
 * Parse-level assertions for schema/schema.surql.
 * Verifies that commit FTS analyzer + index are present and not duplicated.
 * No live DB required.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCHEMA_PATH = join(new URL("..", import.meta.url).pathname, "schema/schema.surql");
const schema = readFileSync(SCHEMA_PATH, "utf8");

describe("commit FTS schema (F4)", () => {
    test("DEFINE ANALYZER commit_text is present exactly once", () => {
        const matches = schema.match(/DEFINE ANALYZER IF NOT EXISTS commit_text/g);
        expect(matches).not.toBeNull();
        expect(matches!.length).toBe(1);
    });

    test("DEFINE INDEX commit_message_fts ON commit FIELDS message is present exactly once", () => {
        const matches = schema.match(/DEFINE INDEX IF NOT EXISTS commit_message_fts\s+ON commit FIELDS message/g);
        expect(matches).not.toBeNull();
        expect(matches!.length).toBe(1);
    });

    test("commit_message_fts uses FULLTEXT ANALYZER commit_text BM25 HIGHLIGHTS", () => {
        expect(schema).toContain("FULLTEXT ANALYZER commit_text BM25 HIGHLIGHTS");
    });
});

describe("skill roles schema (P3.1)", () => {
    test("DEFINE TABLE role SCHEMAFULL is present exactly once", () => {
        const matches = schema.match(/DEFINE TABLE IF NOT EXISTS role SCHEMAFULL/g);
        expect(matches).not.toBeNull();
        expect(matches!.length).toBe(1);
    });

    test("plays_role RELATION is present exactly once", () => {
        const matches = schema.match(/DEFINE TABLE IF NOT EXISTS plays_role TYPE RELATION FROM skill TO role/g);
        expect(matches).not.toBeNull();
        expect(matches!.length).toBe(1);
    });

    test("role_name_uq unique index is present exactly once", () => {
        const matches = schema.match(/DEFINE INDEX IF NOT EXISTS role_name_uq ON role FIELDS name UNIQUE/g);
        expect(matches).not.toBeNull();
        expect(matches!.length).toBe(1);
    });

    test("plays_role_in index is present exactly once", () => {
        const matches = schema.match(/DEFINE INDEX IF NOT EXISTS plays_role_in\s+ON plays_role FIELDS in/g);
        expect(matches).not.toBeNull();
        expect(matches!.length).toBe(1);
    });

    test("plays_role_out index is present exactly once", () => {
        const matches = schema.match(/DEFINE INDEX IF NOT EXISTS plays_role_out\s+ON plays_role FIELDS out/g);
        expect(matches).not.toBeNull();
        expect(matches!.length).toBe(1);
    });

    test("turn_index field on invoked is present", () => {
        expect(schema).toContain("DEFINE FIELD turn_index   ON invoked TYPE option<int>");
    });

    test("total_turns field on invoked is present", () => {
        expect(schema).toContain("DEFINE FIELD total_turns  ON invoked TYPE option<int>");
    });

    test("is_first field on invoked is present", () => {
        expect(schema).toContain("DEFINE FIELD is_first     ON invoked TYPE option<bool>");
    });
});

describe("file evidence schema", () => {
    test("tool-call file evidence relations store normalized absolute paths", () => {
        expect(schema).toContain("DEFINE TABLE read_file TYPE RELATION FROM tool_call TO file");
        expect(schema).toContain("DEFINE TABLE searched_file TYPE RELATION FROM tool_call TO file");
        expect(schema).toContain("DEFINE FIELD absolute_path_seen ON read_file TYPE option<string>");
        expect(schema).toContain("DEFINE FIELD absolute_path_seen ON searched_file TYPE option<string>");
    });
});

describe("turn feedback graph schema", () => {
    test("turn_analysis table and read indexes are defined", () => {
        expect(schema).toContain("DEFINE TABLE IF NOT EXISTS turn_analysis SCHEMAFULL");
        expect(schema).toContain("DEFINE FIELD turn           ON turn_analysis TYPE record<turn>");
        expect(schema).toContain("DEFINE FIELD act            ON turn_analysis TYPE string");
        expect(schema).toContain("DEFINE FIELD polarity       ON turn_analysis TYPE string");
        expect(schema).toContain("DEFINE INDEX IF NOT EXISTS turn_analysis_turn ON turn_analysis FIELDS turn UNIQUE");
        expect(schema).toContain("DEFINE INDEX IF NOT EXISTS turn_analysis_session_act ON turn_analysis FIELDS session, act");
    });

    test("semantic_signal nodes are defined for promoted meanings", () => {
        expect(schema).toContain("DEFINE TABLE IF NOT EXISTS semantic_signal SCHEMAFULL");
        expect(schema).toContain("DEFINE FIELD kind           ON semantic_signal TYPE string");
        expect(schema).toContain("DEFINE FIELD label          ON semantic_signal TYPE string");
        expect(schema).toContain("DEFINE INDEX IF NOT EXISTS semantic_signal_kind_label ON semantic_signal FIELDS kind, label UNIQUE");
    });

    test("expresses and reacts_to graph edges are queryable", () => {
        expect(schema).toContain("DEFINE TABLE IF NOT EXISTS expresses TYPE RELATION FROM turn TO semantic_signal SCHEMAFULL");
        expect(schema).toContain("DEFINE TABLE IF NOT EXISTS reacts_to TYPE RELATION FROM turn TO turn SCHEMAFULL");
        expect(schema).toContain("DEFINE INDEX IF NOT EXISTS expresses_out ON expresses FIELDS out");
        expect(schema).toContain("DEFINE INDEX IF NOT EXISTS reacts_to_out ON reacts_to FIELDS out");
    });

    test("generic classifier graph tables are defined", () => {
        expect(schema).toContain("DEFINE TABLE IF NOT EXISTS classifier_definition SCHEMAFULL");
        expect(schema).toContain("DEFINE TABLE IF NOT EXISTS classifier_run SCHEMAFULL");
        expect(schema).toContain("DEFINE TABLE IF NOT EXISTS classifier_result SCHEMAFULL");
        expect(schema).toContain("DEFINE TABLE IF NOT EXISTS has_classification TYPE RELATION FROM turn TO classifier_result SCHEMAFULL");
        expect(schema).toContain("DEFINE INDEX IF NOT EXISTS classifier_result_theme ON classifier_result FIELDS classifier_key, label, target, durability");
    });
});

describe("content block artifact schema", () => {
    test("content document, block, and atom tables are defined", () => {
        expect(schema).toContain("DEFINE TABLE content_document SCHEMAFULL");
        expect(schema).toContain("DEFINE TABLE content_block SCHEMAFULL");
        expect(schema).toContain("DEFINE TABLE content_atom SCHEMAFULL");
        expect(schema).toContain("DEFINE FIELD parse_fingerprint ON content_document TYPE string");
        expect(schema).toContain("DEFINE FIELD search_text    ON content_block TYPE option<string>");
        expect(schema).toContain("DEFINE FIELD source_kind    ON content_atom TYPE string");
    });

    test("content block search indexes capped search text, not raw text", () => {
        expect(schema).toContain("DEFINE ANALYZER IF NOT EXISTS content_text");
        expect(schema).toContain("DEFINE INDEX IF NOT EXISTS content_block_text_fts");
        expect(schema).toContain("ON content_block FIELDS search_text");
        expect(schema).not.toContain("ON content_block FIELDS text\n    FULLTEXT ANALYZER content_text");
    });

    test("content atoms denormalize query dimensions", () => {
        expect(schema).toContain("DEFINE FIELD repository     ON content_atom TYPE option<record<repository>>");
        expect(schema).toContain("DEFINE FIELD workspace      ON content_atom TYPE option<record<workspace>>");
        expect(schema).toContain("DEFINE FIELD artifact_kind  ON content_atom TYPE option<string>");
        expect(schema).toContain("DEFINE INDEX content_atom_source_kind_value ON content_atom FIELDS source_kind, kind, normalized");
        expect(schema).toContain("DEFINE INDEX content_atom_workspace_kind_value ON content_atom FIELDS workspace, kind, normalized");
    });

    test("explicit mention relation tables are defined", () => {
        expect(schema).toContain("DEFINE TABLE mentions_file TYPE RELATION FROM content_atom TO file SCHEMAFULL");
        expect(schema).toContain("DEFINE TABLE mentions_commit TYPE RELATION FROM content_atom TO commit SCHEMAFULL");
        expect(schema).toContain("DEFINE TABLE mentions_artifact TYPE RELATION FROM content_atom TO artifact SCHEMAFULL");
        expect(schema).toContain("DEFINE INDEX mentions_file_document ON mentions_file FIELDS document");
    });
});
