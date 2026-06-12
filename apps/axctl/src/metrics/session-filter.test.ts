import { describe, expect, test } from "bun:test";
import { sessionProjectClause } from "./session-filter.ts";

describe("sessionProjectClause", () => {
    test("matches root path, claude slug, exact cwd, and subdirectory cwd", () => {
        const clause = sessionProjectClause("/Users/n/Projects/ax");
        expect(clause).toBe(
            '(project = "/Users/n/Projects/ax" OR project = "-Users-n-Projects-ax"'
            + ' OR cwd = "/Users/n/Projects/ax" OR string::starts_with(cwd ?? "", "/Users/n/Projects/ax/"))',
        );
    });

    test("prefixes columns for record-deref queries", () => {
        const clause = sessionProjectClause("/repo", "session.");
        expect(clause).toContain('session.project = "/repo"');
        expect(clause).toContain('session.project = "-repo"');
        expect(clause).toContain('string::starts_with(session.cwd ?? "", "/repo/")');
    });
});
