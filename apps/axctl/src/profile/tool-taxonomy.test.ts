import { describe, expect, test } from "bun:test";
import { isContextTool, isVerificationTool } from "./tool-taxonomy.ts";

describe("isVerificationTool", () => {
    test("credits ecosystem test runners with no English keyword in name", () => {
        // The bug (#471): rspec has no "test", rubocop has no "lint".
        for (const label of ["rspec", "bin/rspec", "rubocop", "bin/rubocop", "pytest", "phpunit"]) {
            expect(isVerificationTool(label)).toBe(true);
        }
    });

    test("credits e2e/browser drivers including Playwright + MCP suite", () => {
        for (
            const label of [
                "playwright",
                "bin/pw",
                "pw",
                "cypress",
                "mcp__playwright__browser_navigate",
                "mcp__playwright__browser_screenshot",
            ]
        ) {
            expect(isVerificationTool(label)).toBe(true);
        }
    });

    test("credits multi-token subcommand forms but not other subcommands", () => {
        expect(isVerificationTool("go test ./...")).toBe(true);
        expect(isVerificationTool("cargo test")).toBe(true);
        expect(isVerificationTool("cargo clippy")).toBe(true);
        expect(isVerificationTool("dotnet test")).toBe(true);
        expect(isVerificationTool("bun test")).toBe(true);
        // non-verifying subcommands of the same program must NOT match
        expect(isVerificationTool("go build")).toBe(false);
        expect(isVerificationTool("cargo build")).toBe(false);
    });

    test("credits JS/TS runners and generic keyword programs", () => {
        for (const label of ["vitest", "tsc --noEmit", "eslint .", "typecheck", "lint", "verify", "bin/check-types"]) {
            expect(isVerificationTool(label)).toBe(true);
        }
    });

    test("excludes git subcommands (no more `git checkout` false positive)", () => {
        // The single largest false positive in the issue evidence.
        expect(isVerificationTool("git checkout")).toBe(false);
        expect(isVerificationTool("git checkout -b feat/x")).toBe(false);
        expect(isVerificationTool("git check-ignore")).toBe(false);
    });

    test("does not match keywords as substrings of unrelated programs", () => {
        // "fastest" / "latest" contain "test"; old ungrouped regex matched them.
        expect(isVerificationTool("fastest-cli")).toBe(false);
        expect(isVerificationTool("contest")).toBe(false);
        expect(isVerificationTool("Bash")).toBe(false);
        expect(isVerificationTool("Read")).toBe(false);
        expect(isVerificationTool("Agent")).toBe(false);
    });

    test("null/empty safe", () => {
        expect(isVerificationTool(null)).toBe(false);
        expect(isVerificationTool(undefined)).toBe(false);
        expect(isVerificationTool("")).toBe(false);
        expect(isVerificationTool("   ")).toBe(false);
    });
});

describe("isContextTool", () => {
    test("credits search/read programs and native tools", () => {
        for (const label of ["rg", "grep", "fd", "find", "cat", "bat", "Read", "recall"]) {
            expect(isContextTool(label)).toBe(true);
        }
    });

    test("does not credit verification or unrelated tools", () => {
        expect(isContextTool("rspec")).toBe(false);
        expect(isContextTool("Agent")).toBe(false);
        expect(isContextTool("")).toBe(false);
    });
});
