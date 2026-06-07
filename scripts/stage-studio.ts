#!/usr/bin/env bun
/**
 * Build the studio `web` target and stage it into apps/site/public/studio so
 * Cloudflare Pages serves it at /studio/. Supersedes the old build-studio.ts
 * copy hack (PR #138): the studio is now a first-class @ax/studio package and
 * this script just builds + copies its dist-studio output (sans sourcemaps).
 *
 * Wired into the site's prebuild/build (apps/site/package.json); run standalone
 * with `bun scripts/stage-studio.ts`.
 */
import { $ } from "bun";
import { cp, rm, access, readdir } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const builtDir = path.join(repoRoot, "apps/studio/dist-studio");
const target = path.join(repoRoot, "apps/site/public/studio");

console.log("[stage-studio] building @ax/studio web target...");
await $`bun --filter @ax/studio build:web`.cwd(repoRoot);
await access(path.join(builtDir, "index.html")); // throws if the build is missing

await rm(target, { recursive: true, force: true });
await cp(builtDir, target, {
    recursive: true,
    filter: (src) => !src.endsWith(".map"),
});
const assets = await readdir(path.join(target, "assets"));
console.log(`[stage-studio] staged ${assets.length} assets -> apps/site/public/studio (sourcemaps excluded)`);
