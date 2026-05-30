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
