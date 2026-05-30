import { describe, expect, test } from "bun:test";
import { evaluateSmokeReport, parseArgs } from "./classifier-smoke.ts";

describe("classifier smoke script", () => {
    test("parses smoke args", () => {
        expect(parseArgs(["--days=3", "--limit=5", "--skip-ingest", "--json"])).toEqual({
            days: 3,
            limit: 5,
            skipIngest: true,
            json: true,
        });
    });

    test("fails when source data exists but core classifier report rows are empty", () => {
        const report = evaluateSmokeReport({
            days: 7,
            sourceTurns: 12,
            classifierFacts: 0,
            evidenceEdges: 0,
            evidenceByTarget: [],
            themeRows: 0,
            candidateRows: 0,
            topCandidates: [],
        });

        expect(report.failures).toContain("source turns exist but classifier_result rows are empty");
    });

    test("passes when facts have evidence, themes, and candidates", () => {
        const report = evaluateSmokeReport({
            days: 7,
            sourceTurns: 12,
            classifierFacts: 8,
            evidenceEdges: 20,
            evidenceByTarget: [{ target_table: "turn", kind: "classified_turn", count: 8 }],
            themeRows: 3,
            candidateRows: 2,
            topCandidates: [],
        });

        expect(report.failures).toEqual([]);
    });
});
