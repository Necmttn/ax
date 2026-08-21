import { describe, expect, test } from "bun:test";
import { DUCKDB_TABLE_LAYERS, ENRICHMENT_COLUMNS } from "@ax/schema/duckdb-tables";
import { parseDuckdbColumns } from "@ax/schema/duckdb-ddl";
import {
    SEGMENT_TABLES,
    ddlHash,
    quoteScopeId,
    segmentExportColumns,
    withScope,
} from "./contract.ts";
import { rederiveStageKeys } from "./import.ts";

describe("segment contract (#902)", () => {
    test("every segment table is an EVENT table", () => {
        for (const spec of SEGMENT_TABLES) {
            expect(DUCKDB_TABLE_LAYERS.get(spec.table)).toBe("event");
        }
    });

    test("no catalog/dimension table rides", () => {
        const carried = new Set(SEGMENT_TABLES.map((spec) => spec.table));
        for (const catalog of [
            "skill", "tool", "file", "commit", "repository", "checkout",
            "agent_model", "agent_provider", "agent_def", "skill_revision",
        ]) {
            expect(carried.has(catalog)).toBe(false);
        }
    });

    test("exported columns = DDL columns minus the enrichment set, and always include id", () => {
        for (const spec of SEGMENT_TABLES) {
            const columns = segmentExportColumns(spec.table);
            expect(columns).toContain("id");
            const strip = ENRICHMENT_COLUMNS[spec.table] ?? [];
            for (const stripped of strip) expect(columns).not.toContain(stripped);
            expect(columns.length).toBe(parseDuckdbColumns(spec.table).length - strip.length);
        }
        // The load-bearing strips, by name - a rename in ENRICHMENT_COLUMNS
        // must show up here as a conscious change.
        expect(segmentExportColumns("session")).not.toContain("project");
        expect(segmentExportColumns("turn")).not.toContain("intent_kind");
        expect(segmentExportColumns("invoked")).not.toContain("was_corrected");
        expect(segmentExportColumns("session_token_usage")).not.toContain("estimated_cost_usd");
        // RETRACTED (#937/#966): turn costs used to RIDE as parse-priced event
        // data. The cost backfill now heals turn_token_usage locally, so its
        // cost columns are ENRICHMENT_COLUMNS and are stripped like the rest -
        // the importer's re-derive prices them against the LOCAL catalog.
        expect(segmentExportColumns("turn_token_usage")).not.toContain("estimated_cost_usd");
    });

    test("every predicate scopes on __SCOPE__ and substitutes quoted ids", () => {
        for (const spec of SEGMENT_TABLES) {
            expect(spec.predicate).toContain("__SCOPE__");
            const sql = withScope(spec.predicate, ["a", "o'brien"]);
            expect(sql).not.toContain("__SCOPE__");
            expect(sql).toContain("'a', 'o''brien'");
        }
        expect(quoteScopeId("x'y")).toBe("'x''y'");
    });

    test("ddlHash is a stable sha256 hex of the local DDL", () => {
        expect(ddlHash()).toMatch(/^[0-9a-f]{64}$/);
        expect(ddlHash()).toBe(ddlHash());
    });

    test("the re-derive set is contract-driven: no parser/loader rides, derives do", () => {
        const keys = rederiveStageKeys();
        // Parsers and external-ledger loaders (any `parse` write) are out.
        for (const parser of ["claude", "codex", "pi", "omp", "opencode", "cursor", "git", "skills", "usage", "advice"]) {
            expect(keys).not.toContain(parser);
        }
        // The derive core is in.
        for (const derive of ["signals", "outcomes", "session-health", "run-evidence"]) {
            expect(keys).toContain(derive);
        }
        expect(keys.length).toBeGreaterThan(5);
    });
});
