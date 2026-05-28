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
