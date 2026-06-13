#!/usr/bin/env bun
/**
 * Freshness lint for the site CLI reference (/docs/cli-reference).
 *
 * Diffs the documented command set in
 * apps/site/app/routes/docs/-cli-reference.data.ts (COMMAND_NAMES) against the
 * REAL visible top-level subcommands the CLI advertises in `ax help`. A new
 * visible subcommand can't ship without a card on the reference page.
 *
 * The page deliberately documents a few hidden-but-useful lifecycle verbs
 * (version/update/daemon/doctor/uninstall/star) too; extra documented commands
 * are allowed - only UNDOCUMENTED visible commands fail the check.
 *
 * Runnable directly (`bun scripts/check-site-cli-reference.ts`) and exercised
 * by scripts/check-site-cli-reference.test.ts so the drift surfaces in CI.
 */
import { spawnSync } from "node:child_process";
import { COMMAND_NAMES } from "../apps/site/app/routes/docs/-cli-reference.data.ts";

/** Visible top-level subcommands, parsed from `ax help` SUBCOMMANDS block. */
export function visibleSubcommands(): string[] {
    const help = spawnSync("bun", ["apps/axctl/src/cli/index.ts", "help"], {
        encoding: "utf8",
    });
    if (help.status !== 0) {
        process.stderr.write(help.stderr ?? "");
        throw new Error(`\`ax help\` exited ${help.status ?? "?"}`);
    }
    const lines = help.stdout.split("\n");
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

/** Visible subcommands missing a card on the reference page. */
export function missingCommands(documented: readonly string[], visible: readonly string[]): string[] {
    const docSet = new Set(documented);
    return visible.filter((name) => !docSet.has(name));
}

if (import.meta.main) {
    const visible = visibleSubcommands();
    const missing = missingCommands(COMMAND_NAMES, visible);
    if (missing.length > 0) {
        console.error(
            "apps/site/app/routes/docs/-cli-reference.data.ts is missing CLI subcommands:",
        );
        for (const name of missing) console.error(`  ax ${name}`);
        console.error(
            "\nAdd a CliCommand entry for each in the appropriate CLI_GROUPS section.",
        );
        process.exit(1);
    }
    console.log(
        `cli-reference.data.ts documents all ${visible.length} visible CLI subcommands.`,
    );
}
