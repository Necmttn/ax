import { describe, expect, test } from "bun:test";
import { renderWrappedGenerateBrief } from "./wrapped-generate-brief.ts";

describe("renderWrappedGenerateBrief", () => {
    const brief = renderWrappedGenerateBrief({ date: "2026-06-12" });

    test("teaches the publish command and JSON shape", () => {
        expect(brief).toContain("ax wrapped publish");
        expect(brief).toContain('"cards"');
        expect(brief).toContain('"question"');
        expect(brief).toContain('"headline"');
        expect(brief).toContain('"sensitivity"');
    });

    test("names the mining sources", () => {
        expect(brief).toContain("/api/wrapped");
        expect(brief).toContain("ax cost models");
        expect(brief).toContain("ax sessions churn");
        expect(brief).toContain("ax recall");
    });

    test("encodes the card rules", () => {
        expect(brief).toContain("<= 6 words");
        expect(brief).toContain("REPLACES the whole set");
        expect(brief).toContain("sensitive");
    });

    test("stamps the date", () => {
        expect(brief).toContain("2026-06-12");
    });
});
