import { describe, expect, it } from "bun:test";
import schemaSurql from "@ax/schema/schema.surql" with { type: "text" };
import { asIfNotExists, schemaAdditiveHealStatements } from "./schema-drift.ts";

describe("asIfNotExists", () => {
    it("guards DEFINE TABLE", () => {
        expect(asIfNotExists("DEFINE TABLE ingest_run SCHEMAFULL;")).toBe(
            "DEFINE TABLE IF NOT EXISTS ingest_run SCHEMAFULL;",
        );
    });

    it("guards DEFINE FIELD", () => {
        expect(asIfNotExists("DEFINE FIELD last_progress_at ON ingest_run TYPE option<datetime>;")).toBe(
            "DEFINE FIELD IF NOT EXISTS last_progress_at ON ingest_run TYPE option<datetime>;",
        );
    });

    it("is idempotent - already-guarded statements pass through", () => {
        const guarded = "DEFINE FIELD IF NOT EXISTS x ON t TYPE string;";
        expect(asIfNotExists(guarded)).toBe(guarded);
        expect(asIfNotExists("DEFINE TABLE IF NOT EXISTS t SCHEMAFULL;")).toBe(
            "DEFINE TABLE IF NOT EXISTS t SCHEMAFULL;",
        );
    });

    it("preserves a VALUE clause and a trailing comment", () => {
        expect(asIfNotExists("DEFINE FIELD ingested_at ON skill TYPE datetime VALUE time::now(); -- note")).toBe(
            "DEFINE FIELD IF NOT EXISTS ingested_at ON skill TYPE datetime VALUE time::now(); -- note",
        );
    });
});

describe("schemaAdditiveHealStatements", () => {
    const sample = [
        "DEFINE TABLE foo SCHEMAFULL;",
        "DEFINE FIELD a ON foo TYPE string;",
        "DEFINE INDEX foo_a ON foo FIELDS a UNIQUE;", // index: excluded
        "DEFINE ANALYZER ascii TOKENIZERS class;", // analyzer: excluded
        "DEFINE FUNCTION fn::x() { RETURN 1; };", // function: excluded
        "DEFINE BUCKET media BACKEND 'file:/tmp';", // bucket: excluded
        "-- a comment line",
        "",
        "DEFINE FIELD b ON foo TYPE option<int>;",
    ].join("\n");

    it("keeps only DEFINE TABLE / DEFINE FIELD, all IF NOT EXISTS guarded", () => {
        expect(schemaAdditiveHealStatements(sample)).toEqual([
            "DEFINE TABLE IF NOT EXISTS foo SCHEMAFULL;",
            "DEFINE FIELD IF NOT EXISTS a ON foo TYPE string;",
            "DEFINE FIELD IF NOT EXISTS b ON foo TYPE option<int>;",
        ]);
    });

    it("excludes indexes, analyzers, functions, and buckets", () => {
        const out = schemaAdditiveHealStatements(sample).join("\n");
        expect(out).not.toContain("DEFINE INDEX");
        expect(out).not.toContain("DEFINE ANALYZER");
        expect(out).not.toContain("DEFINE FUNCTION");
        expect(out).not.toContain("DEFINE BUCKET");
    });

    it("preserves source order (table before its fields)", () => {
        const stmts = schemaAdditiveHealStatements(sample);
        expect(stmts.indexOf("DEFINE TABLE IF NOT EXISTS foo SCHEMAFULL;")).toBeLessThan(
            stmts.indexOf("DEFINE FIELD IF NOT EXISTS a ON foo TYPE string;"),
        );
    });
});

describe("against the bundled schema", () => {
    const stmts = schemaAdditiveHealStatements(schemaSurql);

    it("covers the #283 regression field (ingest_run.last_progress_at)", () => {
        expect(stmts).toContain("DEFINE FIELD IF NOT EXISTS last_progress_at ON ingest_run TYPE option<datetime>;");
        expect(stmts).toContain("DEFINE TABLE IF NOT EXISTS ingest_run SCHEMAFULL;");
    });

    it("every statement is an additive-safe DEFINE TABLE/FIELD IF NOT EXISTS", () => {
        expect(stmts.length).toBeGreaterThan(100);
        for (const s of stmts) {
            expect(s.startsWith("DEFINE TABLE IF NOT EXISTS ") || s.startsWith("DEFINE FIELD IF NOT EXISTS ")).toBe(true);
        }
    });
});
