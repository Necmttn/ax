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
 * Dangling-symlink-free node_modules (electron-builder packaging requirement):
 * bun's default "isolated" linker builds `node_modules/.bun/` (a content store)
 * and fills every package dir with symlinks into it. electron-builder filters
 * the top-level `.bun` dot-dir out of `extraResources`, so the store never lands
 * in the `.app` and the ~482 per-package symlinks dangle - its signing walk then
 * does a symlink-following `stat` and dies with ENOENT. To avoid this we install
 * with bun's "hoisted" linker (npm-style flat node_modules of REAL directories,
 * no `.bun` symlink farm) via a `bunfig.toml` written into the staged tree.
 *
 * Hoisted still emits a handful of SELF-CONTAINED relative links (workspace
 * links like node_modules/@ax/lib -> ../../packages/lib, and `.bin/*` shims)
 * that resolve INSIDE the staged tree. Those are load-bearing - the classifier
 * sources import `../../../apps/axctl/...` through the workspace link - and they
 * pack fine because their targets ship in the same tree. We KEEP those and only
 * dereference any symlink that escapes the staged tree (would dangle in the
 * .app); a truly dangling link aborts the stage. See `ensureSymlinkFree`.
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
import {
    cpSync,
    existsSync,
    mkdirSync,
    readdirSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
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
 *   - packages/hooks-sdk (@ax/hooks-sdk) declared `workspace:*` dep of apps/axctl;
 *                                        `bun install` fails to resolve without it
 *   - packages/onboarding-prompt (@ax/onboarding-prompt) transitive `workspace:*`
 *                                        dep of @ax/lib; same resolve failure
 *   - packages/ax-classifier-direction-event     imported by classifiers/registry.ts
 *   - packages/ax-classifier-verification-event   imported by classifiers/registry.ts
 *
 * `packages/ax-classifier-session-sections` is python-only (referenced solely by
 * string manifest paths, never imported as a module) and is intentionally
 * skipped - it is not needed for `serve`.
 *
 * NOTE: this list is hand-maintained - any NEW `@ax/*` workspace dep of axctl OR
 * of a staged package must be added here or `bun install` in resources/ax-src
 * fails the release build. TODO: auto-derive from the dependency graph.
 */
const WORKSPACE_PACKAGES = [
    "apps/axctl",
    "packages/lib",
    "packages/schema",
    "packages/hooks-sdk",
    "packages/onboarding-prompt",
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
 * Recursively collect every symlink under `root`. Returns absolute paths.
 * We never descend INTO a symlinked dir (its real target lives elsewhere);
 * we record the link itself and move on.
 */
function findSymlinks(root: string, acc: string[] = []): string[] {
    let entries: ReturnType<typeof readdirSync>;
    try {
        entries = readdirSync(root, { withFileTypes: true });
    } catch {
        return acc;
    }
    for (const ent of entries) {
        const full = join(root, ent.name);
        if (ent.isSymbolicLink()) {
            acc.push(full);
            continue;
        }
        if (ent.isDirectory()) findSymlinks(full, acc);
    }
    return acc;
}

/**
 * Replace a symlink with a real copy of its (resolved) target. Used as the
 * dereference fallback for symlinks that escape the staged tree.
 * Throws if the target can't be resolved (a dangling link in the staged tree
 * is exactly the packaging defect we must surface, not silently swallow).
 */
function dereferenceSymlink(link: string): void {
    const target = realpathSync(link); // throws on dangling
    rmSync(link, { force: true });
    cpSync(target, link, { recursive: true, dereference: true });
}

/**
 * Validate the staged tree's symlinks. The defect we guard against is the
 * `.bun` isolated-store farm whose top-level dot-dir electron-builder filters
 * out, leaving ~482 per-package symlinks DANGLING in the .app -> its signing
 * walk stats them and dies with ENOENT.
 *
 * The hoisted linker eliminates the `.bun` farm. What remains is a small set of
 * SELF-CONTAINED relative links that resolve INSIDE the staged tree:
 *   - workspace links: node_modules/@ax/lib -> ../../packages/lib, axctl ->
 *     ../apps/axctl, etc. These are load-bearing: the classifier sources use
 *     relative imports (`../../../apps/axctl/...`) that only resolve when the
 *     node_modules entry points at the real staged `packages/`/`apps/` dir.
 *     Dereferencing them (copying the package contents) BREAKS those relative
 *     imports, so we keep them as internal links.
 *   - `.bin/*` shims that point within node_modules.
 * These pack fine (they're not under a filtered dot-dir) and resolve in the
 * .app because their real targets ship inside the same tree.
 *
 * Policy: keep symlinks whose resolved real target stays inside `root`;
 * dereference any symlink that escapes `root` (would dangle in the .app);
 * abort on a dangling symlink (the original ENOENT defect).
 */
function ensureSymlinkFree(root: string): void {
    const rootReal = realpathSync(root);
    const links = findSymlinks(root);
    if (links.length === 0) {
        log("  node_modules has no symlinks (hoisted linker)");
        return;
    }
    let internal = 0;
    let escaped = 0;
    for (const link of links) {
        let target: string;
        try {
            target = realpathSync(link); // throws on dangling
        } catch (err) {
            die(
                `dangling symlink in staged tree: ${link} ` +
                    `(${err instanceof Error ? err.message : String(err)}). ` +
                    "This would dangle in the .app and break electron-builder's signing walk.",
            );
        }
        if (target === rootReal || target.startsWith(`${rootReal}/`)) {
            internal++; // self-contained; resolves inside the staged tree -> keep
            continue;
        }
        // Escapes the staged tree -> would dangle once packed. Dereference it.
        dereferenceSymlink(link);
        escaped++;
    }
    log(
        `  symlinks: ${internal} internal (kept, resolve in-tree)` +
            (escaped > 0 ? `, ${escaped} external (dereferenced)` : ""),
    );
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
        // Force bun's HOISTED linker for the staged tree. The default "isolated"
        // linker builds `node_modules/.bun/` + ~482 per-package symlinks; that
        // dot-dir is filtered out of electron-builder's extraResources so the
        // symlinks dangle in the .app and crash the signing walk with ENOENT.
        // Hoisted gives an npm-style flat tree of REAL directories (no .bun farm).
        writeFileSync(
            join(AX_SRC, "bunfig.toml"),
            '# Generated by stage-ax-source.ts. Hoisted linker => symlink-free\n' +
                '# node_modules so electron-builder packs the tree cleanly.\n' +
                "[install]\nlinker = \"hoisted\"\n",
        );
        log("  wrote bunfig.toml (linker = hoisted)");
        log("installing host-arch deps: `bun install --linker hoisted` in resources/ax-src/ ...");
        const r = spawnSync("bun", ["install", "--linker", "hoisted"], {
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
        // Backstop: keep self-contained internal links, dereference/abort any
        // symlink that escapes the staged tree (the original ENOENT defect).
        ensureSymlinkFree(AX_SRC);
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
