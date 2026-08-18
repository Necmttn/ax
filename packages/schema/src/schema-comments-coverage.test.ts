/**
 * Coverage gate for the self-documenting catalog (#869): every table in
 * schema.duckdb.sql MUST carry a `--` comment block directly above its
 * CREATE TABLE. The block becomes a catalog COMMENT at schema-apply time
 * (packages/lib/src/duckdb/schema-comments.ts), which is what lets an agent
 * introspect meaning via duckdb_tables()/duckdb_columns() instead of trusting
 * a prose doc that drifts.
 *
 * Same spirit as the parity suite's V2_ONLY_COLUMNS: no silent exemptions. A
 * new table lands WITH its comment - say what the table is, one or two lines,
 * traps included (see ingest_stage's for the shape).
 */
import { describe, expect, test } from "bun:test";
import ddl from "./schema.duckdb.sql" with { type: "text" };
import { parseSchemaComments, schemaCommentStatements } from "@ax/lib/duckdb/schema-comments";

describe("schema comment coverage (#869)", () => {
    const tables = parseSchemaComments(ddl);

    test("the parser sees the whole schema", () => {
        // Guards the gate itself: if the CREATE TABLE regex drifted from the
        // DDL style, coverage would pass vacuously on an empty parse.
        expect(tables.length).toBeGreaterThanOrEqual(120);
    });

    test("every table has a comment", () => {
        const missing = tables.filter((t) => t.comment === null).map((t) => t.table);
        expect(
            missing,
            `tables without a -- comment block above CREATE TABLE: ${missing.join(", ")}. ` +
                "Write one or two lines saying what the table is (traps included) - " +
                "it becomes the live catalog comment agents introspect.",
        ).toEqual([]);
    });

    test("the emitted script stays well-formed", () => {
        const script = schemaCommentStatements(ddl);
        const statements = script.split("\n");
        // One per table plus the column comments - a floor, not an exact pin.
        expect(statements.length).toBeGreaterThanOrEqual(tables.length);
        for (const statement of statements) {
            expect(statement).toMatch(/^COMMENT ON (TABLE "\w+"|COLUMN "\w+"\."\w+") IS '.*';$/);
        }
    });
});
