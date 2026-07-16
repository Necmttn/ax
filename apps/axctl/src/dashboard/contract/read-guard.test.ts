import { describe, expect, test } from "bun:test";
import { isSingleReadStatement } from "./read-guard.ts";

describe("isSingleReadStatement", () => {
    test("accepts a single read statement, optional trailing semicolon", () => {
        expect(isSingleReadStatement("SELECT * FROM session")).toBe(true);
        expect(isSingleReadStatement("SELECT * FROM session;")).toBe(true);
        expect(isSingleReadStatement("  select 1  ")).toBe(true);
        expect(isSingleReadStatement("RETURN 1;")).toBe(true);
        expect(isSingleReadStatement("INFO FOR DB")).toBe(true);
    });

    test("rejects a stacked write after a read", () => {
        expect(isSingleReadStatement("SELECT 1; DELETE FROM session")).toBe(false);
        expect(isSingleReadStatement("SELECT 1; DELETE FROM session;")).toBe(false);
        expect(isSingleReadStatement("SELECT 1;\nUPDATE session SET x = 1")).toBe(false);
    });

    test("rejects a non-read prefix", () => {
        expect(isSingleReadStatement("DELETE FROM session")).toBe(false);
        expect(isSingleReadStatement("CREATE session SET x = 1")).toBe(false);
    });

    test("a semicolon inside a string literal is not a separator", () => {
        expect(isSingleReadStatement("SELECT * FROM t WHERE name = 'a; b'")).toBe(true);
        expect(isSingleReadStatement('SELECT * FROM t WHERE name = "a; b";')).toBe(true);
    });

    test("a semicolon inside a line/block comment is not a separator", () => {
        expect(isSingleReadStatement("SELECT 1 -- a; b")).toBe(true);
        expect(isSingleReadStatement("SELECT 1 /* a; b */")).toBe(true);
        // but a real statement hidden after a comment is still caught
        expect(isSingleReadStatement("SELECT 1; /* c */ DELETE FROM t")).toBe(false);
    });

    test("empty / whitespace is not a read statement", () => {
        expect(isSingleReadStatement("")).toBe(false);
        expect(isSingleReadStatement("   ")).toBe(false);
    });
});
