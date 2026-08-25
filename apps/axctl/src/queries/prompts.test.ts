import { describe, expect, test } from "bun:test";
import {
    escapeLike,
    legacyInjectionClause,
    promptsWhere,
    queryClause,
    scopeClause,
    PROMPTS_DEFAULT_LIMIT,
    PROMPTS_DEFAULT_WINDOW_DAYS,
    type PromptsInput,
} from "./prompts.ts";
import {
    FULL_CONTEXT_RULES,
    IMAGE_ATTACHMENT_MARKERS,
    PI_CONTEXT_RULES,
    type UserTextRules,
} from "../ingest/normalized/message-kind.ts";

const base: PromptsInput = {
    sinceDays: PROMPTS_DEFAULT_WINDOW_DAYS,
    limit: PROMPTS_DEFAULT_LIMIT,
};

/** Count the positional placeholders a fragment binds. */
const placeholders = (sql: string): number => (sql.match(/\?/g) ?? []).length;

describe("scopeClause", () => {
    test("matches the directory AND its subtree, not one exact path", () => {
        // Agents work in worktrees UNDER the repo root, so an equality test on
        // `cwd` would hide most of a project's own history.
        const c = scopeClause("/Users/x/Projects/ax");
        expect(c.sql).toBe("AND (s.cwd = ? OR s.cwd LIKE ?)");
        expect(c.params).toEqual(["/Users/x/Projects/ax", "/Users/x/Projects/ax/%"]);
    });

    test("a trailing slash does not produce a double slash in the pattern", () => {
        expect(scopeClause("/Users/x/ax/").params).toEqual(["/Users/x/ax", "/Users/x/ax/%"]);
    });

    test("absent, empty and whitespace-only scopes contribute nothing", () => {
        for (const v of [undefined, "", "   "]) {
            const c = scopeClause(v);
            expect(c.sql).toBe("");
            expect(c.params).toEqual([]);
        }
    });
});

describe("queryClause", () => {
    test("case-insensitive substring, bound not spliced", () => {
        const c = queryClause("DuckDB");
        expect(c.sql).toBe("AND lower(t.text) LIKE lower(?) ESCAPE '\\'");
        expect(c.params).toEqual(["%DuckDB%"]);
    });

    test("a LIKE metacharacter in the query is escaped, not treated as a wildcard", () => {
        // Unescaped, `%` and `_` are LIKE metacharacters: `-q '100%'` would
        // over-match everything, and `-q '_'` would match almost every row.
        // Only the metachar INSIDE the term is escaped - the two `%` wildcards
        // wrapped around it stay literal wildcards.
        const c = queryClause("100%");
        expect(c.params).toEqual(["%100\\%%"]);
    });

    test("an absent query browses instead of matching everything", () => {
        for (const v of [undefined, "", "  "]) {
            expect(queryClause(v).sql).toBe("");
        }
    });
});

describe("escapeLike", () => {
    test("escapes the LIKE metacharacters", () => {
        // `<recommended_plugins>` is a REAL rule containing `_`. Unescaped, LIKE
        // reads it as "any single character" and the prefix would also exclude a
        // human prompt differing in that position - a silent over-filter.
        expect(escapeLike("<recommended_plugins>")).toBe("<recommended\\_plugins>");
        expect(escapeLike("100%")).toBe("100\\%");
        expect(escapeLike("a\\b")).toBe("a\\\\b");
    });

    test("leaves ordinary text alone", () => {
        expect(escapeLike("<task-notification>")).toBe("<task-notification>");
    });
});

describe("legacyInjectionClause", () => {
    // The clause exists because `message_kind` is stamped at INGEST: rows written
    // before the classifier learned a shape keep the old kind, and a read command
    // may not assume a full re-parse has happened.
    test("is DERIVED from the rule tables, so one edit hardens both paths", () => {
        const c = legacyInjectionClause(FULL_CONTEXT_RULES);
        const expected =
            FULL_CONTEXT_RULES.control.length +
            FULL_CONTEXT_RULES.contextStartsWith.length +
            FULL_CONTEXT_RULES.contextIncludes.length +
            FULL_CONTEXT_RULES.attachmentMarkers.length;
        expect(placeholders(c.sql)).toBe(expected);
        expect(c.params).toHaveLength(expected);
        // A rule added to the classifier must show up here with NO edit to this
        // file. Pin one real prefix to prove the wiring, not the whole list.
        expect(c.params).toContain("<task-notification>%");
        expect(c.params).toContain("<command-message>%");
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

describe("promptsWhere", () => {
    // DuckDB parameters are POSITIONAL, so a fragment and its values are one
    // indivisible thing: one clause omitted from the SQL while its value stays in
    // the array shifts every later parameter by one AND THE QUERY STILL RUNS.
    // This is the invariant that failure would break.
    test("placeholder count equals parameter count, in every flag combination", () => {
        const inputs: ReadonlyArray<PromptsInput> = [
            base,
            { ...base, query: "duckdb" },
            { ...base, scope: "/Users/x/ax" },
            { ...base, query: "duckdb", scope: "/Users/x/ax" },
            { ...base, query: "", scope: "" },
            { ...base, sinceDays: 1, limit: 1, query: "a", scope: "/" },
        ];
        for (const input of inputs) {
            const c = promptsWhere(input);
            expect(placeholders(c.sql)).toBe(c.params.length);
        }
    });

    test("always constrains role, kind and authorship", () => {
        const sql = promptsWhere(base).sql;
        expect(sql).toContain("t.role = 'user'");
        expect(sql).toContain("t.message_kind = 'task'");
        // A subagent's opening turn IS a task - an agent wrote it. The kind is
        // right; the author is not who this command is about.
        expect(sql).toContain("s.source NOT LIKE '%-subagent'");
    });

    test("applies each legacy rule table only to its parser sources", () => {
        const c = promptsWhere(base);
        expect(c.sql).toContain("s.source IN ('claude', 'codex')");
        expect(c.sql).toContain("s.source IN ('pi', 'omp')");
        // Other and future sources take the no-op branch.
        expect(c.sql).toContain("s.source NOT IN ('claude', 'codex', 'pi', 'omp')");

        // The full-only prefix is bound once for FULL_CONTEXT_RULES. It is not
        // present in the PI table, so a future edit cannot silently duplicate it.
        expect(c.params.filter((p) => p === "Base directory for this skill:%")).toHaveLength(1);
        expect(c.params.length).toBe(
            1 + // the `sinceDays` placeholder from withinDaysClause
            FULL_CONTEXT_RULES.control.length +
                FULL_CONTEXT_RULES.contextStartsWith.length +
                FULL_CONTEXT_RULES.contextIncludes.length +
                FULL_CONTEXT_RULES.attachmentMarkers.length +
                PI_CONTEXT_RULES.control.length +
                PI_CONTEXT_RULES.contextStartsWith.length +
                PI_CONTEXT_RULES.contextIncludes.length +
                PI_CONTEXT_RULES.attachmentMarkers.length,
        );
    });

    test("the window is cast, or it does not bind at all", () => {
        // The DuckDB build ax ships carries no ICU, so `CURRENT_TIMESTAMP` (a
        // TIMESTAMPTZ) must be cast before any interval arithmetic. Uncast, the
        // statement fails to bind - guarded repo-wide by check:timestamp-cast,
        // and pinned here because this query builds its own window.
        expect(promptsWhere(base).sql).toContain("CAST(CURRENT_TIMESTAMP AS TIMESTAMP)");
    });

    test("no builder splices a quote into the statement", () => {
        // Every caller-supplied value is a bound parameter, so a path or query
        // containing a quote cannot alter the SQL. The only quotes present are
        // the ones this module writes itself.
        const c = promptsWhere({
            ...base,
            query: `'; DROP TABLE turn; --`,
            scope: `/Users/o'brien/ax`,
        });
        for (const p of c.params) {
            expect(typeof p === "string" || typeof p === "number").toBe(true);
        }
        // the injected quotes live in params, never in the fragment
        expect(c.sql).not.toContain("DROP TABLE");
        expect(c.sql).not.toContain("o'brien");
    });
});
