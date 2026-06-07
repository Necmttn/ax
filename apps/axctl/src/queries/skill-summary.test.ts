import { describe, expect, test } from "bun:test";
import {
    SKILL_SUMMARY_PROPOSED_ONLY_SQL,
    SKILL_SUMMARY_SQL,
} from "./skill-summary.ts";

describe("skill summary SQL", () => {
    test("excludes synthetic provider tools from invoked skills", () => {
        expect(SKILL_SUMMARY_SQL).toContain("skill_id.dir_path IS NONE");
        expect(SKILL_SUMMARY_SQL).toContain('skill_id.dir_path != "(synthetic)"');
    });

    test("excludes synthetic provider tools from proposed-only skills", () => {
        expect(SKILL_SUMMARY_PROPOSED_ONLY_SQL).toContain("dir_path IS NONE");
        expect(SKILL_SUMMARY_PROPOSED_ONLY_SQL).toContain('dir_path != "(synthetic)"');
    });
});
