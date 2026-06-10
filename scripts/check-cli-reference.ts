import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const help = spawnSync("bun", ["apps/axctl/src/cli/index.ts", "help"], {
    encoding: "utf8",
});

if (help.status !== 0) {
    process.stderr.write(help.stderr);
    process.exit(help.status ?? 1);
}

// The README is the acquisition page; the full CLI reference lives in
// docs/cli.md. A visible subcommand must be mentioned (as `axctl <cmd>`
// or `ax <cmd>`) in at least one of them.
const sources = ["README.md", "docs/cli.md"].map((path) => readFileSync(path, "utf8"));
const lines = help.stdout.split("\n").map((line) => line.trim());
const subcommandsStart = lines.findIndex((line) => line === "SUBCOMMANDS");
const subcommands = lines
    .slice(subcommandsStart + 1)
    .map((line) => line.trim())
    .filter((line) => /^[a-z][a-z-]+(\s|$)/.test(line))
    .map((line) => line.split(/\s+/)[0])
    .filter((name) => !["DESCRIPTION", "USAGE", "GLOBAL", "SUBCOMMANDS"].includes(name));

const missing = subcommands.filter(
    (command) => !sources.some((text) => text.includes(`axctl ${command}`) || text.includes(`ax ${command}`)),
);

if (missing.length > 0) {
    console.error("README.md / docs/cli.md are missing CLI subcommands:");
    for (const command of missing) console.error(`  ${command}`);
    process.exit(1);
}

console.log(`README.md + docs/cli.md cover ${subcommands.length} CLI subcommands.`);
