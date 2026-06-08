#!/usr/bin/env bun
/**
 * stage-ax-source.ts - populate `apps/studio-desktop/resources/` with everything
 * the packaged Electron app needs to run `<bunBinary> <axSourceEntry> serve`
 * (see `DesktopEnvironment`):
 *
 *   1. `resources/ax-src/`  - the minimal runnable ax source tree (workspace
 *      packages that `apps/axctl/src/cli/index.ts serve` actually imports) plus
 *      a self-contained host-arch `node_modules`, so the staged `ax serve`
 *      resolves `surrealdb`, `@durable-streams/*`, `lmdb` (pulled by
 *      durable-streams), `node-pty`, effect, etc.
 *   2. `resources/studio/`  - the built studio SPA (`apps/studio/dist-desktop`),
 *      served over the custom protocol from `<resourcesPath>/studio`.
 *
 * Why from-source (not the `--compile` binary): the compiled binary can't host
 * the Durable Streams sidecar (native lmdb) -> live ingest 503s. Live ingest is
 * required, so we ship bun (vendored by fetch-binaries.ts) + this source tree.
 *
 * Native-dep strategy (a): we copy a tailored root `package.json` + the real
 * `bun.lock` + the needed workspace packages into `resources/ax-src/`, then run
 * `bun install` *inside* that tree to materialise a self-contained, correctly
 * linked `node_modules` for the HOST arch. Native modules (lmdb, node-pty) are
 * per-arch: the staged `node_modules` is host-arch-only. Release builds for the
 * other arch must run this script on that arch.
 *
 * Usage:
 *   bun run scripts/stage-ax-source.ts            # stage for host arch
 *   bun run scripts/stage-ax-source.ts --skip-install   # copy source only
 *   bun run scripts/stage-ax-source.ts --skip-studio    # don't (re)build studio
 *
 * Idempotent: re-running refreshes the staged copies. `bun install` is itself
 * idempotent given the same lockfile.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = dirname(HERE); // apps/studio-desktop
const REPO_ROOT = dirname(dirname(APP_ROOT)); // <repo>
const RESOURCES = join(APP_ROOT, "resources");
const AX_SRC = join(RESOURCES, "ax-src");
const STUDIO_OUT = join(RESOURCES, "studio");

const log = (msg: string) => process.stdout.write(`[stage-ax-source] ${msg}\n`);
const die = (msg: string): never => {
    process.stderr.write(`[stage-ax-source] ERROR: ${msg}\n`);
    process.exit(1);
};

/**
 * Workspace packages copied into `resources/ax-src/`. This is the minimal set
 * `apps/axctl/src/cli/index.ts serve` resolves at runtime:
 *   - apps/axctl                         the CLI / serve entrypoint
 *   - packages/lib (@ax/lib)             db client, paths, layers, live-traces
 *   - packages/schema (@ax/schema)       schema.surql (imported as text) + types
 *   - packages/ax-classifier-direction-event     imported by classifiers/registry.ts
 *   - packages/ax-classifier-verification-event   imported by classifiers/registry.ts
 *
 * `packages/ax-classifier-session-sections` is python-only (referenced solely by
 * string manifest paths, never imported as a module) and is intentionally
 * skipped - it is not needed for `serve`.
 */
const WORKSPACE_PACKAGES = [
    "apps/axctl",
    "packages/lib",
    "packages/schema",
    "packages/ax-classifier-direction-event",
    "packages/ax-classifier-verification-event",
] as const;

/** Per-package dir names excluded from the copied source (regenerated/irrelevant). */
const EXCLUDE_DIR_NAMES = new Set([
    "node_modules",
    ".turbo",
    ".tsbuildinfo",
]);

/** Returns true if a path segment should be excluded from the source copy. */
function isExcludedSegment(name: string): boolean {
    if (EXCLUDE_DIR_NAMES.has(name)) return true;
    // dist, dist-*, dist-electron etc.
    if (name === "dist" || name.startsWith("dist-")) return true;
    // test fixtures
    if (name === "fixtures" || name === "__fixtures__" || name === "eval-fixtures")
        return true;
    return false;
}

/** Returns true if a file should be excluded from the source copy. */
function isExcludedFile(name: string): boolean {
    if (name.endsWith(".tsbuildinfo")) return true;
    if (name === ".DS_Store") return true;
    return false;
}

/** Recursively copy `src` -> `dest`, honouring the exclude rules. */
function copyTree(src: string, dest: string): void {
    cpSync(src, dest, {
        recursive: true,
        dereference: false,
        filter: (from) => {
            const rel = relative(src, from);
            if (rel === "") return true;
            const segs = rel.split("/");
            for (const seg of segs) {
                if (isExcludedSegment(seg)) return false;
            }
            const base = segs[segs.length - 1]!;
            // Only treat as file-exclusion if it's actually a file.
            try {
                if (statSync(from).isFile() && isExcludedFile(base)) return false;
            } catch {
                // ignore
            }
            return true;
        },
    });
}

/** Human-readable directory size via `du -sh` (best-effort). */
function dirSize(path: string): string {
    if (!existsSync(path)) return "(missing)";
    const r = spawnSync("du", ["-sh", path], { encoding: "utf8" });
    if (r.status !== 0) return "(unknown)";
    return (r.stdout || "").split("\t")[0]?.trim() ?? "(unknown)";
}

/**
 * Build a tailored root package.json for the staged tree:
 *   - workspaces.packages narrowed to the staged members (so `bun install`
 *     doesn't fail on the absent apps/site, apps/studio, etc.)
 *   - lifecycle scripts (`prepare`, `postinstall`) dropped - they run
 *     effect-language-service / bun2nix which are dev-only and would fail or
 *     mutate files in the staged tree.
 *   - root `dependencies`/`devDependencies` dropped - the staged tree only needs
 *     each workspace package's own deps; keeping root web/build deps (vite,
 *     turbo, tanstack, ...) would bloat node_modules for no runtime benefit.
 *   - `catalog` + `overrides` preserved - workspace packages reference
 *     `catalog:` versions and the overrides pin transitive resolutions.
 */
function tailoredRootPackageJson(): string {
    const root = JSON.parse(
        spawnSync("cat", [join(REPO_ROOT, "package.json")], {
            encoding: "utf8",
        }).stdout,
    ) as Record<string, unknown>;

    const staged = {
        name: root.name,
        version: root.version,
        private: true,
        license: root.license,
        type: root.type,
        packageManager: root.packageManager,
        workspaces: {
            packages: WORKSPACE_PACKAGES.map((p) => p),
            catalog: (root.workspaces as { catalog?: unknown }).catalog ?? {},
        },
        overrides: root.overrides ?? {},
    };
    return `${JSON.stringify(staged, null, 2)}\n`;
}

async function main() {
    const argv = process.argv.slice(2);
    const skipInstall = argv.includes("--skip-install");
    const skipStudio = argv.includes("--skip-studio");

    log(`repo root:   ${REPO_ROOT}`);
    log(`resources:   ${RESOURCES}`);
    log(`host arch:   ${process.arch}`);

    mkdirSync(RESOURCES, { recursive: true });

    // ---- 1. ax source -----------------------------------------------------
    log("staging ax source -> resources/ax-src/ ...");
    rmSync(AX_SRC, { recursive: true, force: true });
    mkdirSync(AX_SRC, { recursive: true });

    for (const pkg of WORKSPACE_PACKAGES) {
        const from = join(REPO_ROOT, pkg);
        if (!existsSync(from)) die(`workspace package not found: ${from}`);
        const to = join(AX_SRC, pkg);
        mkdirSync(dirname(to), { recursive: true });
        copyTree(from, to);
        log(`  copied ${pkg}  (${dirSize(to)})`);
    }

    // Root files bun needs to resolve the workspace in the staged tree.
    writeFileSync(join(AX_SRC, "package.json"), tailoredRootPackageJson());
    for (const f of ["tsconfig.base.json", "bun.lock"]) {
        const from = join(REPO_ROOT, f);
        if (!existsSync(from)) die(`expected root file missing: ${from}`);
        cpSync(from, join(AX_SRC, f));
        log(`  copied ${f}`);
    }

    // ---- 2. native deps (bun install inside the staged tree) --------------
    if (skipInstall) {
        log("skipping `bun install` (--skip-install)");
    } else {
        log("installing host-arch deps: `bun install` in resources/ax-src/ ...");
        const r = spawnSync("bun", ["install"], {
            cwd: AX_SRC,
            stdio: "inherit",
            // Don't let a stale root catalog/lock abort the install; allow
            // bun to re-resolve against the narrowed workspace.
            env: { ...process.env },
        });
        if (r.status !== 0) {
            die(
                `bun install failed (exit ${r.status}) in ${AX_SRC}. ` +
                    "Native deps were not staged - investigate before relying on this bundle.",
            );
        }
        log(`  node_modules staged  (${dirSize(join(AX_SRC, "node_modules"))})`);
    }

    // ---- 3. studio bundle -------------------------------------------------
    const studioDist = join(REPO_ROOT, "apps/studio/dist-desktop");
    if (!skipStudio && !existsSync(studioDist)) {
        log("apps/studio/dist-desktop missing - building studio (desktop target)...");
        const r = spawnSync("bun", ["--filter", "@ax/studio", "build:desktop"], {
            cwd: REPO_ROOT,
            stdio: "inherit",
        });
        if (r.status !== 0) die(`studio build:desktop failed (exit ${r.status})`);
    } else if (!skipStudio) {
        log("apps/studio/dist-desktop present - rebuilding (desktop target)...");
        const r = spawnSync("bun", ["--filter", "@ax/studio", "build:desktop"], {
            cwd: REPO_ROOT,
            stdio: "inherit",
        });
        if (r.status !== 0) die(`studio build:desktop failed (exit ${r.status})`);
    }
    if (!existsSync(studioDist)) {
        die(`studio dist not found after build: ${studioDist}`);
    }
    log("staging studio bundle -> resources/studio/ ...");
    rmSync(STUDIO_OUT, { recursive: true, force: true });
    mkdirSync(STUDIO_OUT, { recursive: true });
    cpSync(studioDist, STUDIO_OUT, { recursive: true });
    log(`  copied dist-desktop  (${dirSize(STUDIO_OUT)})`);

    // ---- summary ----------------------------------------------------------
    log("staged:");
    log(`  ax-src        ${dirSize(AX_SRC)}`);
    log(`    node_modules ${dirSize(join(AX_SRC, "node_modules"))}`);
    log(`  studio        ${dirSize(STUDIO_OUT)}`);
    log(`  resources     ${dirSize(RESOURCES)}`);
    log("done.");
}
main().catch((err) => die(err instanceof Error ? err.message : String(err)));
