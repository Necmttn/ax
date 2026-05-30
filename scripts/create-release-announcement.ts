#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const versionArg = process.argv[2]?.replace(/^v/, "");

if (!versionArg || !/^\d+\.\d+\.\d+$/.test(versionArg)) {
    console.error("usage: bun scripts/create-release-announcement.ts <X.Y.Z> [--force]");
    process.exit(2);
}

const force = process.argv.includes("--force");
const changelog = readFileSync("CHANGELOG.md", "utf8");
const heading = new RegExp(`^## \\[?${versionArg.replace(/\./g, "\\.")}\\]?.*$`, "m");
const match = changelog.match(heading);

if (!match || match.index === undefined) {
    console.error(`release ${versionArg} was not found in CHANGELOG.md`);
    process.exit(1);
}

const rest = changelog.slice(match.index + match[0].length);
const next = rest.search(/^## /m);
const body = (next >= 0 ? rest.slice(0, next) : rest).trim();
const bullets = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("* "))
    .map((line) => line.slice(2).trim());

const today = new Date().toISOString().slice(0, 10);
const outDir = join("docs", "releases");
const outPath = join(outDir, `v${versionArg}.md`);

if (existsSync(outPath) && !force) {
    console.error(`${outPath} already exists; pass --force to overwrite`);
    process.exit(1);
}

mkdirSync(outDir, { recursive: true });

const highlightLines = bullets.length > 0
    ? bullets.map((line) => `* ${line}`).join("\n")
    : "* Replace this with the main user-visible changes.";

const draft = `---
version: "${versionArg}"
date: "${today}"
title: "Release ${versionArg}"
summary: "Replace this with a one-sentence user-facing summary."
---

Release ${versionArg} is ready to announce.

Rewrite this draft into a concise release announcement. Keep the generated
changelog factual, but explain the user-visible change in product language.

### Highlights

${highlightLines}

### Why it matters

Explain the practical impact for someone using ax day to day.
`;

writeFileSync(outPath, draft);
console.log(`wrote ${outPath}`);
