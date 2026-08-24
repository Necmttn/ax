import { describe, expect, test } from "bun:test";

import { ACTIVE_PRODUCT_DOCS, checkCurrentProductDocs } from "./check-current-product-docs.ts";

const validReadme = [
    "Six harnesses",
    "DuckDB",
    "SQLite",
    "3, 10, and 30 sessions",
].join("\n");

describe("checkCurrentProductDocs", () => {
    test.each([
        ["SurrealDB stores the graph", "retired SurrealDB store"],
        ["Connect to 127.0.0.1:8521", "retired database port"],
        ["Check at t+7 / t+30 / t+90", "retired calendar checkpoint"],
        ["Ax supports five harnesses", "retired five-harness count"],
        ["The Stop hook fires after the session", "retired Stop-hook workflow"],
    ])("rejects %s", (claim, expected) => {
        const violations = checkCurrentProductDocs({ "notes.md": claim });
        expect(violations).toContainEqual({ path: "notes.md", message: expected });
    });

    test("accepts the current README contract", () => {
        expect(checkCurrentProductDocs({ "README.md": validReadme })).toEqual([]);
    });

    test("requires approved claims in anchor documents", () => {
        expect(checkCurrentProductDocs({ "README.md": "DuckDB and SQLite" })).toEqual([
            { path: "README.md", message: "missing current claim: Six harnesses" },
            { path: "README.md", message: "missing current claim: 3, 10, and 30 sessions" },
        ]);
    });

    test("does not inspect historical documents outside the supplied allowlist", () => {
        expect(ACTIVE_PRODUCT_DOCS.some((path) => path.startsWith("docs/superpowers/"))).toBe(false);
    });
});
