// packages/lib/src/sqlite/statement.test.ts
//
// The scanner behind the seam's multi-statement refusal. Pure string walking, so
// these run without a database - the round trip through a real sidecar (does the
// refusal actually fire, and does the DDL path stay exempt) is in sidecar.test.ts.
import { describe, expect, test } from "bun:test";
import { findExtraStatement, isSingleStatement } from "./statement.ts";

describe("findExtraStatement", () => {
    test("accepts one statement, with or without a trailing semicolon", () => {
        expect(isSingleStatement("SELECT 1")).toBe(true);
        expect(isSingleStatement("SELECT 1;")).toBe(true);
        expect(isSingleStatement("SELECT 1;   ")).toBe(true);
        expect(isSingleStatement("SELECT 1;\n\n")).toBe(true);
    });

    test("accepts an empty or whitespace-only string", () => {
        // Not this function's job to reject: SQLite reports an empty statement
        // itself, and inventing a second error here would only confuse it.
        expect(isSingleStatement("")).toBe(true);
        expect(isSingleStatement("   \n ")).toBe(true);
    });

    test("finds the second statement, and points at where it starts", () => {
        const sql = "DELETE FROM plays_role WHERE id = ?; INSERT INTO plays_role (id) VALUES (?)";
        const extra = findExtraStatement(sql);
        expect(extra).not.toBeNull();
        expect(extra?.separatorIndex).toBe(sql.indexOf(";"));
        expect(sql.slice(extra!.startIndex)).toStartWith("INSERT INTO plays_role");
        expect(extra?.excerpt).toStartWith("INSERT INTO plays_role");
    });

    test("treats a bare `;;` as a second statement rather than a tidy no-op", () => {
        // Nothing is lost by executing it, but it is a writer that lost track of
        // its own string, and the seam should say so while it is cheap.
        expect(isSingleStatement("SELECT 1;;")).toBe(false);
    });

    test("truncates a long excerpt so one enormous statement cannot bloat the error", () => {
        const extra = findExtraStatement(`SELECT 1; SELECT '${"x".repeat(400)}'`);
        expect(extra?.excerpt.length).toBeLessThanOrEqual(81);
        expect(extra?.excerpt.endsWith("…")).toBe(true);
    });

    describe("a semicolon that is text, not a separator", () => {
        test("inside a single-quoted string literal", () => {
            expect(isSingleStatement("UPDATE role SET name = 'a; b' WHERE id = ?")).toBe(true);
        });

        test("inside a doubled-quote escape within a literal", () => {
            // `'it''s; fine'` is ONE literal. A scanner that ended the run at the
            // second quote would read `; fine'` as a separator plus a statement.
            expect(isSingleStatement("UPDATE role SET name = 'it''s; fine' WHERE id = ?")).toBe(true);
        });

        test("inside a double-quoted identifier", () => {
            expect(isSingleStatement('SELECT "weird;column" FROM role')).toBe(true);
        });

        test("inside a backtick identifier", () => {
            expect(isSingleStatement("SELECT `weird;column` FROM role")).toBe(true);
        });

        test("inside a bracket identifier", () => {
            expect(isSingleStatement("SELECT [weird;column] FROM role")).toBe(true);
        });

        test("inside a line comment", () => {
            expect(isSingleStatement("SELECT 1 -- and; then\n")).toBe(true);
        });

        test("inside a block comment", () => {
            expect(isSingleStatement("SELECT /* and; then */ 1")).toBe(true);
        });
    });

    describe("comments after a separator", () => {
        test("a trailing line comment is not a second statement", () => {
            expect(isSingleStatement("SELECT 1; -- done\n")).toBe(true);
        });

        test("a trailing block comment is not a second statement", () => {
            expect(isSingleStatement("SELECT 1; /* done */")).toBe(true);
        });

        test("a statement AFTER a comment still is one", () => {
            expect(isSingleStatement("SELECT 1; -- note\nSELECT 2")).toBe(false);
            expect(isSingleStatement("SELECT 1; /* note */ SELECT 2")).toBe(false);
        });

        test("an unterminated comment hides nothing executable", () => {
            expect(isSingleStatement("SELECT 1; /* never closed")).toBe(true);
        });
    });

    test("an unterminated literal swallows the rest instead of inventing a separator", () => {
        // Invalid SQL either way; SQLite reports it. The scanner must not add a
        // second, wrong diagnosis on top.
        expect(isSingleStatement("SELECT 'open; still open")).toBe(true);
    });

    test("finds a third statement when the first separator was inside a literal", () => {
        const sql = "UPDATE role SET name = 'a; b'; DROP TABLE role";
        const extra = findExtraStatement(sql);
        expect(sql.slice(extra!.startIndex)).toBe("DROP TABLE role");
    });

    test("the committed sidecar DDL is many statements", async () => {
        // The DDL is exactly what the guard must NOT be applied to. It goes
        // through `database.exec`, which runs every statement, and this pins the
        // reason that exemption exists.
        const { SIDECAR_SCHEMA_SQL } = await import("@ax/schema/sidecar-ddl");
        expect(isSingleStatement(SIDECAR_SCHEMA_SQL)).toBe(false);
    });
});
