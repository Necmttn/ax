import { describe, expect, test } from "bun:test";
import { PROJECT_TOP_SKILLS_SQL } from "./project.ts";

describe("PROJECT_TOP_SKILLS_SQL", () => {
    test("excludes synthetic provider-tool skills", () => {
        expect(PROJECT_TOP_SKILLS_SQL).toContain('dir_path = "(synthetic)"');
        expect(PROJECT_TOP_SKILLS_SQL).toContain("out NOT IN");
    });
});
