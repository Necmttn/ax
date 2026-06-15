import { describe, expect, it } from "bun:test";
import { VISIBLE_COMMANDS } from "./visible-commands.ts";

/**
 * Visible top-level subcommands parsed from `ax help` SUBCOMMANDS block - the
 * same source `scripts/check-site-cli-reference.ts#visibleSubcommands` uses.
 * Replicated inline rather than imported across the scripts boundary (the
 * relative path would be ../../../../../scripts/... and would drag the site
 * data module in via its COMMAND_NAMES import).
 */
function visibleSubcommands(): string[] {
    const help = Bun.spawnSync(["bun", "apps/axctl/src/cli/index.ts", "help"], {
        stdout: "pipe",
        stderr: "pipe",
    });
    if (help.exitCode !== 0) {
        throw new Error(
            `\`ax help\` exited ${help.exitCode}: ${help.stderr.toString()}`,
        );
    }
    const lines = help.stdout.toString().split("\n");
    const start = lines.findIndex((line) => line.trim() === "SUBCOMMANDS");
    if (start === -1) throw new Error("could not find SUBCOMMANDS block in `ax help`");
    return lines
        .slice(start + 1)
        // SUBCOMMANDS entries are indented "  name  description"; an
        // unindented line ends the block.
        .filter((line) => /^\s{2,}[a-z]/.test(line))
        .map((line) => line.trim().split(/\s+/)[0]!)
        .filter((name) => name.length > 0);
}

describe("VISIBLE_COMMANDS stays in sync with the real CLI", () => {
    it("matches the visible `ax help` subcommands (no drift, no stale entries)", () => {
        const real = new Set(visibleSubcommands());
        const declared = new Set(VISIBLE_COMMANDS);
        const missing = [...real].filter((c) => !declared.has(c)); // real but not declared
        const stale = [...declared].filter((c) => !real.has(c)); // declared but not real
        expect({ missing, stale }).toEqual({ missing: [], stale: [] });
    });
});
