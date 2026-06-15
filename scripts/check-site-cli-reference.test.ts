import { describe, expect, it } from "bun:test";
import { missingCommands, visibleSubcommands } from "./check-site-cli-reference.ts";
import { CLI_GROUPS, COMMAND_NAMES } from "../apps/site/app/routes/docs/-cli-reference.data.ts";

describe("missingCommands", () => {
    it("reports visible commands absent from the documented set", () => {
        expect(missingCommands(["a", "b"], ["a", "b", "c"])).toEqual(["c"]);
    });
    it("is clean when every visible command is documented", () => {
        expect(missingCommands(["a", "b", "c"], ["a", "b"])).toEqual([]);
    });
});

describe("cli-reference data integrity", () => {
    it("has no duplicate command names", () => {
        const seen = new Set<string>();
        for (const name of COMMAND_NAMES) {
            expect(seen.has(name)).toBe(false);
            seen.add(name);
        }
    });

    it("every command carries a job, signature, and receipt", () => {
        for (const group of CLI_GROUPS) {
            for (const cmd of group.commands) {
                expect(cmd.job.length).toBeGreaterThan(0);
                expect(cmd.signature.startsWith("ax ")).toBe(true);
                expect(cmd.receipt.length).toBeGreaterThan(0);
            }
        }
    });

    it("never uses axctl in visitor-facing copy", () => {
        for (const group of CLI_GROUPS) {
            expect(group.blurb).not.toContain("axctl");
            for (const cmd of group.commands) {
                expect(cmd.job).not.toContain("axctl");
                expect(cmd.signature).not.toContain("axctl");
                expect(cmd.receipt).not.toContain("axctl");
                for (const d of cmd.detail ?? []) expect(d).not.toContain("axctl");
            }
        }
    });

    it("leaks no personal machine paths", () => {
        const all = JSON.stringify(CLI_GROUPS);
        expect(all).not.toContain("/Users/necmttn");
        expect(all).not.toContain("necmttn.com");
    });
});

// Live drift guard: the real `ax help` visible subcommands must all have a
// card on the reference page. This shells out to the CLI (help only, no DB).
describe("cli-reference freshness", () => {
    it("documents every visible CLI subcommand", () => {
        const visible = visibleSubcommands();
        // Sanity: the help parse actually found commands.
        expect(visible.length).toBeGreaterThan(5);
        expect(missingCommands(COMMAND_NAMES, visible)).toEqual([]);
    });
});
