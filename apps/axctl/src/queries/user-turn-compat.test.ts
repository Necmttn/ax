import { describe, expect, test } from "bun:test";
import {
    escapeLike,
    legacyInjectionClause,
    userTurnCompatClause,
    userTurnCompatPredicate,
} from "./user-turn-compat.ts";
import {
    FULL_CONTEXT_RULES,
    IMAGE_ATTACHMENT_MARKERS,
    PI_CONTEXT_RULES,
    type UserTextRules,
} from "../ingest/normalized/message-kind.ts";

/** Count the positional placeholders a fragment binds. */
const placeholders = (sql: string): number => (sql.match(/\?/g) ?? []).length;

const TOTAL_RULE_PARAMS =
    FULL_CONTEXT_RULES.control.length +
    FULL_CONTEXT_RULES.contextStartsWith.length +
    FULL_CONTEXT_RULES.contextIncludes.length +
    FULL_CONTEXT_RULES.attachmentMarkers.length +
    PI_CONTEXT_RULES.control.length +
    PI_CONTEXT_RULES.contextStartsWith.length +
    PI_CONTEXT_RULES.contextIncludes.length +
    PI_CONTEXT_RULES.attachmentMarkers.length;

describe("legacyInjectionClause", () => {
    test("is DERIVED from the rule tables, so one edit hardens every caller", () => {
        const c = legacyInjectionClause(FULL_CONTEXT_RULES);
        const expected =
            FULL_CONTEXT_RULES.control.length +
            FULL_CONTEXT_RULES.contextStartsWith.length +
            FULL_CONTEXT_RULES.contextIncludes.length +
            FULL_CONTEXT_RULES.attachmentMarkers.length;
        expect(placeholders(c.sql)).toBe(expected);
        expect(c.params).toHaveLength(expected);
        expect(c.params).toContain("<task-notification>%");
        expect(c.params).toContain("<command-message>%");
        // Default text expression, unless the caller overrides it.
        expect(c.sql).toContain("t.text NOT LIKE");
    });

    test("accepts a caller-supplied text expression, for aliases other than `t`", () => {
        const c = legacyInjectionClause(FULL_CONTEXT_RULES, "t2.text");
        expect(c.sql).toContain("t2.text NOT LIKE");
        expect(c.sql).not.toContain(" t.text ");
    });

    test("prefixes anchor, includes float, markers use the regex form", () => {
        const rules: UserTextRules = {
            control: ["<ctl>"],
            contextStartsWith: ["<ctx>"],
            contextIncludes: ["<mid>"],
            attachmentMarkers: IMAGE_ATTACHMENT_MARKERS,
        };
        const c = legacyInjectionClause(rules);
        expect(c.params[0]).toBe("<ctl>%");
        expect(c.params[1]).toBe("<ctx>%");
        expect(c.params[2]).toBe("%<mid>%");
        expect(c.params[3]).toBe(IMAGE_ATTACHMENT_MARKERS[0]!.source);
        expect(c.sql).toContain("regexp_replace");
    });

    test("empty rules contribute nothing rather than a dangling AND", () => {
        const c = legacyInjectionClause({
            control: [],
            contextStartsWith: [],
            contextIncludes: [],
            attachmentMarkers: [],
        });
        expect(c.sql).toBe("");
        expect(c.params).toEqual([]);
    });
});

describe("escapeLike", () => {
    test("escapes the LIKE metacharacters", () => {
        expect(escapeLike("<recommended_plugins>")).toBe("<recommended\\_plugins>");
        expect(escapeLike("100%")).toBe("100\\%");
    });
});

describe("userTurnCompatPredicate", () => {
    test("defaults to t.text / s.source and covers both rule tables", () => {
        const p = userTurnCompatPredicate();
        expect(placeholders(p.sql)).toBe(TOTAL_RULE_PARAMS);
        expect(p.params).toHaveLength(TOTAL_RULE_PARAMS);
        expect(p.sql).toContain("s.source NOT IN ('claude', 'codex', 'pi', 'omp')");
        expect(p.sql).toContain("s.source IN ('claude', 'codex')");
        expect(p.sql).toContain("s.source IN ('pi', 'omp')");
        // The full-only prefix is bound once for FULL_CONTEXT_RULES, never for pi.
        expect(p.params.filter((v) => v === "Base directory for this skill:%")).toHaveLength(1);
        // No leading AND - this is a raw boolean expression, embeddable in a
        // CASE/ORDER BY, not just a WHERE-clause fragment.
        expect(p.sql.startsWith("AND")).toBe(false);
    });

    test("honors caller-supplied source/text expressions", () => {
        const p = userTurnCompatPredicate({ sourceExpr: "s2.source", textExpr: "t2.text" });
        expect(p.sql).toContain("s2.source NOT IN");
        expect(p.sql).toContain("t2.text NOT LIKE");
        expect(p.sql).not.toContain("s.source");
    });

    test("unknown sources take the unconditional true branch", () => {
        // `NOT IN (...)` is the FIRST disjunct - an unrecognized source can
        // never be excluded by either rule table.
        const p = userTurnCompatPredicate();
        expect(p.sql.startsWith("(")).toBe(true);
        expect(p.sql).toMatch(/^\(\S+ NOT IN/);
    });
});

describe("userTurnCompatClause", () => {
    test("prepends AND with no role guard by default", () => {
        const c = userTurnCompatClause();
        expect(c.sql.startsWith("AND (")).toBe(true);
        expect(c.sql).not.toContain("<> 'user'");
        expect(c.params).toHaveLength(TOTAL_RULE_PARAMS);
    });

    test("wraps with a role guard so non-user rows are always kept", () => {
        const c = userTurnCompatClause({ roleExpr: "t.role" });
        expect(c.sql).toBe(`AND (t.role <> 'user' OR ${userTurnCompatPredicate().sql})`);
        // The guard itself binds no parameter - only the predicate's rule params.
        expect(c.params).toEqual(userTurnCompatPredicate().params);
    });

    test("placeholder count always equals parameter count", () => {
        for (const c of [
            userTurnCompatClause(),
            userTurnCompatClause({ roleExpr: "t.role" }),
            userTurnCompatClause({ sourceExpr: "s2.source", textExpr: "t2.text", roleExpr: "t2.role" }),
        ]) {
            expect(placeholders(c.sql)).toBe(c.params.length);
        }
    });
});
