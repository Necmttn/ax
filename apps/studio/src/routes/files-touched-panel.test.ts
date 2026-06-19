import { describe, expect, test } from "bun:test";
import { filesTouchedStartsOpen, hasFileDirectoryCollision } from "./files-touched-panel.tsx";

describe("filesTouchedStartsOpen", () => {
    test("opens small trees and keeps large transcript trees collapsed", () => {
        expect(filesTouchedStartsOpen(1)).toBe(true);
        expect(filesTouchedStartsOpen(40)).toBe(true);
        expect(filesTouchedStartsOpen(41)).toBe(false);
    });
});

describe("hasFileDirectoryCollision", () => {
    test("detects when one touched file is also another file's directory", () => {
        expect(hasFileDirectoryCollision([
            "docs/superpowers/specs",
            "docs/superpowers/specs/2026-06-17-profile-interview-design.md",
        ])).toBe(true);
    });

    test("allows ordinary siblings and nested files", () => {
        expect(hasFileDirectoryCollision([
            "docs/superpowers/specs/a.md",
            "docs/superpowers/plans/b.md",
            "apps/axctl/src/profile/schema.ts",
        ])).toBe(false);
    });
});
