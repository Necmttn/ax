import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const help = spawnSync("bun", ["apps/axctl/src/cli/index.ts", "help"], {
    encoding: "utf8",
});

if (help.status !== 0) {
    process.stderr.write(help.stderr);
    process.exit(help.status ?? 1);
}

const readme = readFileSync("README.md", "utf8");
const lines = help.stdout.split("\n").map((line) => line.trim());
const subcommandsStart = lines.findIndex((line) => line === "SUBCOMMANDS");
const subcommands = lines
    .slice(subcommandsStart + 1)
    .map((line) => line.trim())
    .filter((line) => /^[a-z][a-z-]+(\s|$)/.test(line))
    .map((line) => line.split(/\s+/)[0])
    .filter((name) => !["DESCRIPTION", "USAGE", "GLOBAL", "SUBCOMMANDS"].includes(name));

const missing = subcommands.filter((command) => !readme.includes(`axctl ${command}`));

if (missing.length > 0) {
    console.error("README.md is missing CLI subcommands:");
    for (const command of missing) console.error(`  ${command}`);
    process.exit(1);
}

console.log(`README.md covers ${subcommands.length} CLI subcommands.`);
