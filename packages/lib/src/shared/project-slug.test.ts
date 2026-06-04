import { describe, expect, test } from "bun:test";
import { pathToProjectSlug, prettifyProjectSlug, sessionProjectLabel } from "./project-slug.ts";

describe("pathToProjectSlug", () => {
    test("encodes an absolute repo path the same way Claude names its projects dir", () => {
        // Claude stores ~/.claude/projects/<slug> by replacing '/' and '.' with '-'.
        // The canonical session.project key must match that encoding so Claude
        // main-checkout sessions are already canonical (no churn) and codex /
        // pi / opencode sessions converge onto the identical key.
        expect(pathToProjectSlug("/Users/necmttn/Projects/ax")).toBe(
            "-Users-necmttn-Projects-ax",
        );
    });

    test("encodes dotted path segments like Claude does", () => {
        expect(pathToProjectSlug("/Users/necmttn/.dotfiles/claude/.claude-self-improve")).toBe(
            "-Users-necmttn--dotfiles-claude--claude-self-improve",
        );
    });

    test("round-trips through prettifyProjectSlug to the repo's basename", () => {
        expect(prettifyProjectSlug(pathToProjectSlug("/Users/necmttn/Projects/ax"))).toBe("ax");
    });

    test("returns empty string for empty input", () => {
        expect(pathToProjectSlug("")).toBe("");
    });
});

describe("sessionProjectLabel", () => {
    test("uses the prettified project slug when it names a repo", () => {
        expect(sessionProjectLabel("-Users-necmttn-Projects-ax", "/Users/necmttn/Projects/ax")).toBe("ax");
    });

    test("uses the prettified raw-cwd project (codex-style) when it names a repo", () => {
        expect(sessionProjectLabel("/Users/necmttn/Projects/ax", "/Users/necmttn/Projects/ax")).toBe("ax");
    });

    test("falls back to the cwd basename when the project prettifies to (no repo)", () => {
        // project points at a container dir, but cwd is more specific.
        expect(sessionProjectLabel("-Users-necmttn-Projects", "/Users/necmttn/Projects/ax")).toBe("ax");
    });

    test("falls back to cwd basename when project is missing", () => {
        expect(sessionProjectLabel(null, "/Users/necmttn/Projects/ax")).toBe("ax");
    });

    test("returns '-' when neither project nor cwd is usable", () => {
        expect(sessionProjectLabel(null, null)).toBe("-");
    });
});
