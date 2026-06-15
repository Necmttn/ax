import { describe, expect, test } from "bun:test";
import { SOURCE_FILTERS, SOURCE_HUES } from "./sessions.tsx";

describe("session route source filters", () => {
    test("includes local provider transcript sources", () => {
        expect(SOURCE_FILTERS).toEqual(["all", "claude", "codex", "pi", "opencode", "cursor"]);
        expect(SOURCE_HUES.pi).toBeDefined();
        expect(SOURCE_HUES.opencode).toBeDefined();
        expect(SOURCE_HUES.cursor).toBeDefined();
    });
});
