import { describe, expect, test } from "bun:test";
import { SKILL_DETAIL_SQL } from "./skill-detail.ts";
import { SKILL_DETAIL_SQL as TUI_SKILL_DETAIL_SQL } from "../tui/queries.ts";

describe("SKILL_DETAIL_SQL", () => {
    test("binds the skill by $name", () => {
        expect(SKILL_DETAIL_SQL).toContain("WHERE name = $name");
    });

    test("includes the TUI daily buckets (last 30 days, ascending)", () => {
        expect(SKILL_DETAIL_SQL).toContain("daily:");
        expect(SKILL_DETAIL_SQL).toMatch(
            /daily:\s*\(\s*SELECT ts FROM invoked\s*WHERE out = \$s\.id AND ts > time::now\(\) - 30d\s*ORDER BY ts ASC\s*\)/,
        );
    });

    test("includes the dashboard evidence blocks", () => {
        expect(SKILL_DETAIL_SQL).toContain("corrections:");
        expect(SKILL_DETAIL_SQL).toContain("proposals:");
        expect(SKILL_DETAIL_SQL).toContain("paired:");
        expect(SKILL_DETAIL_SQL).toContain("turn_has_error");
    });

    test("TUI re-exports the canonical SQL (no fork)", () => {
        expect(TUI_SKILL_DETAIL_SQL).toBe(SKILL_DETAIL_SQL);
    });
});
