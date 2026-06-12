import { describe, expect, test } from "bun:test";
import { renderAnalyzeBrief } from "./analyze-brief.ts";

describe("renderAnalyzeBrief", () => {
    const brief = renderAnalyzeBrief({ date: "2026-06-12" });

    test("teaches the write-back command", () => {
        expect(brief).toContain("ax improve propose");
        expect(brief).toContain("echo '<json>'");
    });

    test("documents all five forms and their payloads", () => {
        for (const form of ["guidance", "skill", "hook", "subagent", "automation"]) {
            expect(brief).toContain(`**${form}**`);
        }
        expect(brief).toContain("trigger_pattern");
        expect(brief).toContain("file_target");
        expect(brief).toContain("bounded_role");
        expect(brief).toContain("event_name");
        expect(brief).toContain("trigger_signal");
    });

    test("requires evidence and names the mining commands", () => {
        expect(brief).toContain("MUST carry evidence");
        expect(brief).toContain("ax sessions churn");
        expect(brief).toContain("ax dispatches --candidates");
        expect(brief).toContain("ax recall");
        expect(brief).toContain("ax improve list");
    });

    test("stamps the date", () => {
        expect(brief).toContain("2026-06-12");
    });
});
