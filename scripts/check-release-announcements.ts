#!/usr/bin/env bun
/**
 * Lint: every released version in CHANGELOG.md should have a curated
 * announcement page at docs/releases/vX.Y.Z.md (the layer the website
 * renders at /changelog/<version>).
 *
 * Default mode warns and exits 0 (wired into lefthook pre-push so it nags
 * without blocking). Pass --strict to exit 1, e.g. for CI or a release
 * checklist.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const strict = process.argv.includes("--strict");
const repoRoot = join(import.meta.dir, "..");

const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
const versions = [...changelog.matchAll(/^## \[?(\d+\.\d+\.\d+)\]?/gm)].map((m) => m[1] as string);

const missing = versions.filter(
    (version) => !existsSync(join(repoRoot, "docs", "releases", `v${version}.md`)),
);

if (missing.length === 0) {
    console.log(`release announcements: all ${versions.length} versions covered`);
    process.exit(0);
}

console.error(`
⚠ ${missing.length} released version${missing.length === 1 ? "" : "s"} ha${missing.length === 1 ? "s" : "ve"} no announcement page under docs/releases/:

${missing.map((v) => `  - v${v}`).join("\n")}

The website changelog (/changelog/<version>) renders these pages. To write one properly:

  1. Scaffold the evidence draft:
       bun run release:announcement -- ${missing[0]}
  2. Have an agent rewrite it with the ax:release-announcement skill
     (e.g. \`claude "/release-announcement ${missing[0]}"\`), or follow
     docs/releases/README.md by hand.
  3. Commit docs/releases/v${missing[0]}.md - the site deploys it on merge.
`);

process.exit(strict ? 1 : 0);
