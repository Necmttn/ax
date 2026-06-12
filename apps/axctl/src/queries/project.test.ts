import { describe, expect, test } from "bun:test";
import { PROJECT_TOP_SKILLS_SQL } from "./project.ts";

describe("PROJECT_TOP_SKILLS_SQL", () => {
    test("excludes synthetic provider-tool skills", () => {
        expect(PROJECT_TOP_SKILLS_SQL).toContain('AND out NOT IN (SELECT VALUE id FROM skill WHERE dir_path = "(synthetic)")');
    });
});
