#!/usr/bin/env bun
/**
 * Build the studio SPA (mock build, base `/studio/`) and stage it into the
 * site's public/ dir so the Cloudflare Pages deploy serves it at
 * `https://ax.necmttn.com/studio/`.
 *
 * The studio source lives inside the axctl package
 * (`apps/axctl/src/dashboard/web`) and shares the same Vite config the daemon
 * uses; `VITE_STUDIO_MOCK=true` flips it to the hosted/mock variant (base
 * `/studio/`, mock fixtures, `?endpoint=` live-connect to a local `ax serve`).
 *
 * We copy the built assets but NOT the sourcemaps - they're multi-MB and have
 * no place in the committed/deployed bundle.
 *
 * Wired into the site's `prebuild` (see apps/site/package.json) so a normal
 * `bun run build` regenerates it; also run standalone with `bun scripts/build-studio.ts`.
 */
import { $ } from "bun";
import { cp, rm, readdir } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const webDir = path.join(repoRoot, "apps/axctl/src/dashboard/web");
const builtDir = path.join(webDir, "dist-studio");
const targetDir = path.join(repoRoot, "apps/site/public/studio");

console.log("[build-studio] building studio (VITE_STUDIO_MOCK=true)...");
await $`bunx vite build`.cwd(webDir).env({ ...process.env, VITE_STUDIO_MOCK: "true" });

console.log(`[build-studio] staging -> ${path.relative(repoRoot, targetDir)}`);
await rm(targetDir, { recursive: true, force: true });
await cp(builtDir, targetDir, {
    recursive: true,
    filter: (src) => !src.endsWith(".map"),
});

const staged = await readdir(path.join(targetDir, "assets"));
console.log(`[build-studio] done: ${staged.length} assets staged (sourcemaps excluded)`);
