import { describe, expect, test } from "bun:test";
import {
    buildOpportunityStatements,
    opportunityKey,
    overlapFilesMatch,
    parseOverlapFiles,
    triggerTokensFromCandidate,
} from "./derive-opportunities.ts";

describe("opportunityKey", () => {
    test("deterministic for the same (experiment, evidence) pair", () => {
        const a = opportunityKey("exp_a", "fix_b");
        const b = opportunityKey("exp_a", "fix_b");
        expect(a).toBe(b);
        expect(a).not.toBe(opportunityKey("exp_a", "fix_c"));
    });
});

describe("parseOverlapFiles", () => {
    test("handles JSON array", () => {
        expect(parseOverlapFiles('["schema/schema.surql","src/x.ts"]')).toEqual([
            "schema/schema.surql",
            "src/x.ts",
        ]);
    });

    test("handles null + invalid + non-array", () => {
        expect(parseOverlapFiles(null)).toEqual([]);
        expect(parseOverlapFiles("not-json")).toEqual([]);
        expect(parseOverlapFiles('{"a":1}')).toEqual([]);
    });
});

describe("triggerTokensFromCandidate", () => {
    test("drops short + boilerplate tokens", () => {
        expect(triggerTokensFromCandidate("SurrealDB_schema_change_guardrail")).toEqual([
            "surrealdb",
            "schema",
            "change",
        ]);
        expect(triggerTokensFromCandidate("graph_query_dogfood_checklist")).toEqual([
            "graph",
            "query",
            "dogfood",
        ]);
    });
});

describe("overlapFilesMatch", () => {
    test("matches when any token is a substring of any file path", () => {
        expect(
            overlapFilesMatch(["schema/schema.surql"], ["schema", "change"]),
        ).toBe(true);
        expect(
            overlapFilesMatch(["src/dashboard/web/styles.css"], ["schema"]),
        ).toBe(false);
        expect(overlapFilesMatch([], ["anything"])).toBe(false);
        expect(overlapFilesMatch(["a.ts"], [])).toBe(false);
    });
});

describe("buildOpportunityStatements", () => {
    test("emits DELETE + RELATE per match with stable edge id", () => {
        const stmts = buildOpportunityStatements("exp_1", [
            { evidenceTable: "later_fixed_by", evidenceKey: "edge_a", ts: "2026-05-25T00:00:00.000Z" },
            { evidenceTable: "later_fixed_by", evidenceKey: "edge_b", ts: "2026-05-25T01:00:00.000Z" },
        ]);
        const sql = stmts.join("\n");
        expect(sql.match(/DELETE opportunity:/g)?.length).toBe(2);
        expect(sql.match(/RELATE experiment:/g)?.length).toBe(2);
        expect(sql).toContain("was_addressed = false");
        expect(sql).toContain("->opportunity:");
        expect(sql).toContain("->later_fixed_by:");
    });

    test("no matches -> no statements", () => {
        expect(buildOpportunityStatements("exp_1", [])).toEqual([]);
    });
});
