#!/usr/bin/env bun
/**
 * Build the studio SPA (web target, base `/studio/`) and stage it into the
 * site's public/ dir so the Cloudflare Pages deploy serves it at
 * `https://ax.necmttn.com/studio/`.
 *
 * The studio source lives in its own workspace (`apps/studio`); the `web`
 * STUDIO_TARGET emits the hosted/mock variant (base `/studio/`, mock fixtures)
 * into `apps/studio/dist-studio`. We copy the built assets but NOT the
 * sourcemaps - they're multi-MB and have no place in the committed/deployed
 * bundle.
 *
 * Wired into the site's `prebuild`/`build` (see apps/site/package.json) so a
 * normal `bun run build` regenerates it; also run standalone with
 * `bun scripts/stage-studio.ts`.
 */
import { $ } from "bun";
import { cp, rm, access, readdir } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const builtDir = path.join(repoRoot, "apps/studio/dist-studio");
const target = path.join(repoRoot, "apps/site/public/studio");

await $`bun --filter @ax/studio build:web`.cwd(repoRoot);
await access(path.join(builtDir, "index.html"));
await rm(target, { recursive: true, force: true });
await cp(builtDir, target, { recursive: true, filter: (s) => !s.endsWith(".map") });
const assets = await readdir(path.join(target, "assets"));
console.log(`[stage-studio] staged ${assets.length} assets -> apps/site/public/studio`);
