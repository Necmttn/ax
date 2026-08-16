import { describe, expect, test } from "bun:test";
import { sessionProjectClause } from "./session-filter.ts";

describe("sessionProjectClause", () => {
    test("matches root path, claude slug, exact cwd, and subdirectory cwd", () => {
        const clause = sessionProjectClause("/Users/n/Projects/ax");
        expect(clause).toEqual({
            sql: "AND (project = ? OR project = ? OR cwd = ? OR coalesce(cwd, '') LIKE ?)",
            params: [
                "/Users/n/Projects/ax",
                "-Users-n-Projects-ax",
                "/Users/n/Projects/ax",
                "/Users/n/Projects/ax/%",
            ],
        });
    });

    test("prefixes columns for record-deref queries", () => {
        const clause = sessionProjectClause("/repo", "session.");
        expect(clause.sql).toContain("session.project = ?");
        expect(clause.sql).toContain("coalesce(session.cwd, '') LIKE ?");
        expect(clause.params).toEqual(["/repo", "-repo", "/repo", "/repo/%"]);
    });
});
