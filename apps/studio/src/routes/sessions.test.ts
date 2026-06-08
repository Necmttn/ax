import { describe, expect, test } from "bun:test";
import { SOURCE_BADGE_COLORS, SOURCE_FILTERS } from "./sessions.tsx";

describe("session route source filters", () => {
    test("includes local provider transcript sources", () => {
        expect(SOURCE_FILTERS).toEqual(["all", "claude", "codex", "pi", "opencode", "cursor"]);
        expect(SOURCE_BADGE_COLORS.pi).toBeDefined();
        expect(SOURCE_BADGE_COLORS.opencode).toBeDefined();
        expect(SOURCE_BADGE_COLORS.cursor).toBeDefined();
    });
});
