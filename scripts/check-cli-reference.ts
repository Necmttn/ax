import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const help = spawnSync("bun", ["src/cli/index.ts", "help"], {
    encoding: "utf8",
});

if (help.status !== 0) {
    process.stderr.write(help.stderr);
    process.exit(help.status ?? 1);
}

const readme = readFileSync("README.md", "utf8");
const commands = help.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("agentctl ") && !line.startsWith("agentctl -"))
    .map((line) => line.replace(/\s+#.*$/, ""));

const missing = commands.filter((command) => !readme.includes(command));

if (missing.length > 0) {
    console.error("README.md is missing CLI help entries:");
    for (const command of missing) console.error(`  ${command}`);
    process.exit(1);
}

console.log(`README.md covers ${commands.length} CLI help entries.`);
