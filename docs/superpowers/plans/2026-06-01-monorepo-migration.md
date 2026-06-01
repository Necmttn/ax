# Monorepo Migration - apps/ + packages/ Layout

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Land everything in a single PR.** Do not open partial PRs - the user wants one reviewable refactor.

**Goal:** Restructure ax from a flat-ish layout (`src/`, `bin/`, `schema/`, `site/`, `packages/` mostly empty) into a proper monorepo modelled on `pingdotgg/t3code`: `apps/` for deployable products (`apps/axctl`, `apps/site`), `packages/` for shared internal libraries (`@ax/schema`, `@ax/lib`), root tooling for orchestration (`turbo.json`, `tsconfig.base.json`, Bun workspace catalog). Every existing feature must keep working after the refactor: `axctl ingest`, `axctl improve`, `axctl serve`, `axctl tui`, the LaunchAgent watcher, the install script, Cloudflare Pages site deploy, all tests.

**Architecture:** Bun workspaces with a centralized catalog for version pinning. Internal packages ship raw `.ts` source through per-file `"exports"` maps (no build step for internal packages - TypeScript resolves directly). Turbo orchestrates `build`/`dev`/`typecheck`/`test` task graphs across packages with dependency-aware execution. Each app keeps its own bundler choice (axctl: bun build, site: vite). A single `tsconfig.base.json` enforces strict Effect-friendly settings that every package extends.

**Reference repo:** `pingdotgg/t3code` (cloned at `.references/t3code/`). Read its `package.json`, `turbo.json`, `tsconfig.base.json`, `apps/server/package.json`, `packages/shared/package.json`, `scripts/dev-runner.ts` for canonical shape. Do NOT copy directly - adapt to ax's stack (Effect v4 beta, SurrealDB, single CLI binary).

**Tech Stack:** Bun ≥ 1.3, TypeScript 5.x, Effect 4.0.0-beta.x, SurrealDB 3.x, Vite 8.x (site), Turbo (added in this plan).

**Critical constraints:**
1. The CLI binary path users invoke (`axctl`) must keep working through every step. The LaunchAgent plist references this. So does `install.sh`. So does `flake.nix`. Treat the binary entry point as a stable interface.
2. The Cloudflare Pages `ax` project currently has `Root directory = site/`. After this PR merges, the dashboard setting needs to change to `Root directory = apps/site/` - but the PR itself must not require that change to land. The build commands run by Turbo handle the path internally.
3. All existing tests pass. Where vitest config or bun test paths need adjustment, do that in this PR.
4. The user merges this PR as a single shot - every commit on the branch must leave the tree in a buildable state so reviewers can checkout any commit and `bun install && bun run typecheck` passes.

---

## File Structure (After)

```
ax/
├── apps/
│   ├── axctl/                                # CLI + ingest + dashboard server
│   │   ├── bin/
│   │   │   └── axctl                         # shell shim → dist/main.js or src/cli/index.ts
│   │   ├── src/
│   │   │   ├── cli/                          # ← from /src/cli
│   │   │   ├── ingest/                       # ← from /src/ingest
│   │   │   ├── dashboard/                    # ← from /src/dashboard
│   │   │   ├── hooks/                        # ← from /src/hooks
│   │   │   ├── improve/                      # ← from /src/improve
│   │   │   ├── classifiers/                  # ← from /src/classifiers
│   │   │   ├── queries/                      # ← from /src/queries
│   │   │   └── tui/                          # ← from /src/tui (planned)
│   │   ├── scripts/                          # axctl-specific helper scripts
│   │   ├── package.json                      # name: "axctl", bin: { axctl: "./bin/axctl" }
│   │   └── tsconfig.json                     # extends ../../tsconfig.base.json
│   └── site/                                 # ← from /site
│       ├── app/
│       ├── public/
│       ├── package.json                      # name: "@ax/site"
│       ├── tsconfig.json                     # extends ../../tsconfig.base.json
│       └── vite.config.ts
├── packages/
│   ├── schema/                               # ← from /schema
│   │   ├── src/
│   │   │   ├── schema.surql                  # the actual DDL
│   │   │   └── types.ts                      # shared TS types derived from schema
│   │   ├── package.json                      # name: "@ax/schema"
│   │   └── tsconfig.json
│   └── lib/                                  # ← from /src/lib
│       ├── src/
│       │   ├── db.ts                         # SurrealClient
│       │   ├── paths.ts                      # XDG paths
│       │   ├── skill-id.ts                   # ID utilities
│       │   ├── errors.ts                     # tagged errors
│       │   ├── layers.ts                     # Effect Layer compositions
│       │   ├── live-traces/                  # the vendored live-traces package
│       │   └── shared/                       # generic helpers (json, surql, derive-keys, etc.)
│       ├── package.json                      # name: "@ax/lib", per-file exports
│       └── tsconfig.json
├── docs/                                     # unchanged
├── scripts/                                  # repo-wide orchestration scripts
│   ├── extract-stage-rationale.ts            # (refactored to read apps/axctl/src/ingest/stage)
│   └── ... (existing scripts that orchestrate across apps)
├── .references/                              # gitignored, holds t3code clone
├── package.json                              # workspaces + catalog
├── turbo.json
├── tsconfig.base.json
├── bun.lock                                  # single lockfile for the monorepo
├── flake.nix                                 # updated build derivation paths
├── install.sh                                # updated binary install path
└── ... (CONTRIBUTING.md, README.md, etc.)
```

## File Structure (Before - for reference)

```
ax/
├── src/                                      # CLI lives at root
│   ├── cli/, ingest/, dashboard/, hooks/, improve/, classifiers/, queries/, lib/
├── bin/axctl                                 # binary at root
├── schema/                                   # SurrealQL at root
├── site/                                     # site at root
├── packages/                                 # exists but mostly empty
├── scripts/
├── docs/
├── package.json                              # workspaces: ["packages/*"] (only)
└── ...
```

---

## Task 1 - Tooling Skeleton (no file moves)

**Goal:** Establish the monorepo orchestration layer (turbo, base tsconfig, root workspaces with catalog) without moving any files. After this task, `bun install` from the root still works; `src/` and `site/` are unchanged.

**Files:**
- Create: `tsconfig.base.json`
- Create: `turbo.json`
- Modify: `package.json` (root)
- Modify: `.gitignore` (add `.turbo/`)

### Steps

- [ ] **Step 1.1: Create `tsconfig.base.json`**

Use this content (lifted from t3code, with ax-specific adjustments to keep Effect v4 + SurrealDB paths working):

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "preserve",
    "moduleResolution": "bundler",
    "lib": ["ESNext"],
    "types": ["@types/bun"],
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "useDefineForClassFields": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "allowSyntheticDefaultImports": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "plugins": [
      { "name": "@effect/language-service" }
    ]
  }
}
```

Use `module: preserve` + `moduleResolution: bundler` (matches our current CLAUDE.md project rules), NOT t3code's `NodeNext` - Bun resolves natively.

- [ ] **Step 1.2: Create `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", "dist-electron/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true,
      "dependsOn": ["^build"]
    },
    "typecheck": {
      "dependsOn": ["^build"],
      "outputs": [],
      "cache": false
    },
    "test": {
      "dependsOn": ["^build"],
      "cache": false,
      "outputs": []
    }
  }
}
```

- [ ] **Step 1.3: Modify root `package.json`**

Change `workspaces` from `["packages/*"]` to:

```json
"workspaces": {
  "packages": ["apps/*", "packages/*", "scripts"],
  "catalog": {
    "effect": "4.0.0-beta.x",
    "@effect/platform-bun": "4.0.0-beta.x",
    "@effect/platform-node": "4.0.0-beta.x",
    "@effect/vitest": "4.0.0-beta.x",
    "@types/bun": "latest",
    "@types/node": "^25.0.0",
    "typescript": "^5.6.0",
    "vite": "^8.0.3",
    "vitest": "^4.0.0"
  }
}
```

(Pin to actual versions from current `bun.lock` - read `bun pm view` or current lockfile entries to fill these in.)

Add scripts:

```json
"scripts": {
  "...": "...existing scripts...",
  "build": "turbo run build",
  "dev": "turbo run dev",
  "typecheck": "turbo run typecheck",
  "test": "turbo run test"
}
```

- [ ] **Step 1.4: Add `turbo` as a root devDependency**

```bash
bun add -d -D turbo
```

- [ ] **Step 1.5: Add `.turbo` to `.gitignore`**

- [ ] **Step 1.6: Verify nothing broke**

```bash
bun install
bunx tsc --noEmit                            # should still pass at current level
bun test src/ingest/derive-checkpoints.test.ts  # canary test
```

The turbo commands don't fire (no apps yet under apps/) - that's fine. `bun run --filter` should also still work for legacy.

---

## Task 2 - Move `site/` → `apps/site/`

**Goal:** Site lives in `apps/site/`. CF Pages keeps building. Local dev `bun run dev` from `apps/site/` still hot-reloads.

**Files:**
- Move: `site/` → `apps/site/` (the entire dir, including `app/`, `public/`, `package.json`, `vite.config.ts`, `tsconfig.json`, `bun.lock` if separate)
- Modify: `apps/site/package.json` (rename to `@ax/site`)
- Modify: `apps/site/tsconfig.json` (extend `../../tsconfig.base.json`)
- Modify: any root scripts that reference `site/` path

### Steps

- [ ] **Step 2.1: Move the directory**

```bash
mkdir -p apps
git mv site apps/site
```

- [ ] **Step 2.2: Rename the workspace name**

Edit `apps/site/package.json`:

```json
{
  "name": "@ax/site",
  "...": "..."
}
```

(Keep all other scripts as-is - they still work from the new location.)

- [ ] **Step 2.3: Extend the base tsconfig**

Edit `apps/site/tsconfig.json` to extend `../../tsconfig.base.json` instead of duplicating compiler options. Keep `paths` overrides if any.

- [ ] **Step 2.4: Update root scripts that reference `site/`**

```bash
rg -l "\\bsite/" --type=json --type=ts --type=md
```

Update each (CONTRIBUTING.md, CLAUDE.md, scripts/, README.md, etc.) to reference `apps/site/`.

Specifically:
- `scripts/extract-stage-rationale.ts` is referenced by `apps/site/package.json` build script - keep its location at `/scripts/` for now (it reads from `src/ingest/stage/` which doesn't move until Task 4).
- Update CF Pages dashboard mentally - note in PR description that the Root Directory dashboard setting will need to change from `site` → `apps/site` after merge.

- [ ] **Step 2.5: Verify**

```bash
cd apps/site
bun install
bun run dev
# In another shell:
curl -o /dev/null -w "/  %{http_code}\n" http://localhost:5173/
curl -o /dev/null -w "/features  %{http_code}\n" http://localhost:5173/features
curl -o /dev/null -w "/install  %{http_code}\n" http://localhost:5173/install
# All 200.
```

Then `bun run build` from `apps/site/` produces `dist/client/`.

---

## Task 3 - Extract `packages/schema/`

**Goal:** SurrealDB schema lives in its own internal package, consumed by `apps/axctl` and any future consumer (dashboard, tests).

**Files:**
- Create: `packages/schema/package.json` (name `@ax/schema`)
- Create: `packages/schema/tsconfig.json` (extends base)
- Move: `schema/*.surql` → `packages/schema/src/`
- Move: any TS types defined in schema/ → `packages/schema/src/types.ts`
- Create: `packages/schema/src/index.ts` re-exporting types only

### Steps

- [ ] **Step 3.1: Create the package directory**

```bash
mkdir -p packages/schema/src
git mv schema/*.surql packages/schema/src/
```

- [ ] **Step 3.2: Create `packages/schema/package.json`**

```json
{
  "name": "@ax/schema",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/types.ts",
      "import": "./src/types.ts"
    },
    "./schema.surql": "./src/schema.surql"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "effect": "catalog:"
  },
  "devDependencies": {
    "@types/bun": "catalog:",
    "typescript": "catalog:"
  }
}
```

- [ ] **Step 3.3: Create `packages/schema/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3.4: Move TS types from schema → packages/schema/src/types.ts**

Check `schema.test.ts` and other tests for derived types. Lift them into `packages/schema/src/types.ts`. Remove duplicate definitions from `src/`.

- [ ] **Step 3.5: Update imports in `src/`**

```bash
rg -l "from .*['\"][\"./]+schema[\"/]" src/
```

For each match, rewrite to `from "@ax/schema"` for types or `import schemaSurqlUrl from "@ax/schema/schema.surql"` for the DDL file.

For SurrealQL loading (places like `scripts/apply-schema.sh` and `apps/axctl/src/lib/db.ts` if applicable), update paths to read from `node_modules/@ax/schema/src/schema.surql` resolved via `import.meta.resolve` or relative.

- [ ] **Step 3.6: Update `scripts/apply-schema.sh`**

Path changes: `schema/schema.surql` → `packages/schema/src/schema.surql`.

- [ ] **Step 3.7: Verify**

```bash
bun install                                  # picks up new workspace
bunx tsc --noEmit
bun test                                     # canary
axctl ingest --since=1                       # smoke test schema loads
```

---

## Task 4 - Extract `packages/lib/`

**Goal:** Reusable lib code (db client, paths, ID utilities, errors, layers, live-traces, shared helpers) lives in `packages/lib/`. Importable as `@ax/lib/db`, `@ax/lib/paths`, etc. - per-file exports, no barrel.

**Files:**
- Create: `packages/lib/package.json` (name `@ax/lib`, per-file exports)
- Create: `packages/lib/tsconfig.json`
- Move: `src/lib/` → `packages/lib/src/`
- Modify: every import in `src/` that points to `./lib/...`

### Steps

- [ ] **Step 4.1: Move the directory**

```bash
mkdir -p packages/lib
git mv src/lib packages/lib/src
```

- [ ] **Step 4.2: Create `packages/lib/package.json`**

Per-file exports for every TS file directly under `src/`:

```json
{
  "name": "@ax/lib",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "exports": {
    "./db": { "types": "./src/db.ts", "import": "./src/db.ts" },
    "./paths": { "types": "./src/paths.ts", "import": "./src/paths.ts" },
    "./skill-id": { "types": "./src/skill-id.ts", "import": "./src/skill-id.ts" },
    "./errors": { "types": "./src/errors.ts", "import": "./src/errors.ts" },
    "./layers": { "types": "./src/layers.ts", "import": "./src/layers.ts" },
    "./live-traces/*": { "types": "./src/live-traces/*.ts", "import": "./src/live-traces/*.ts" },
    "./shared/*": { "types": "./src/shared/*.ts", "import": "./src/shared/*.ts" }
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "effect": "catalog:",
    "@ax/schema": "workspace:*"
  },
  "devDependencies": {
    "@types/bun": "catalog:",
    "typescript": "catalog:"
  }
}
```

- [ ] **Step 4.3: Create `packages/lib/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 4.4: Rewrite imports in `src/`**

For every TS file in `src/` (excluding `src/lib` which moved):

```bash
# Find all relative imports to ./lib
rg -l '"\./lib/' src/

# For each file, rewrite imports. Use a script if many matches.
# Example transformation:
#   import { SurrealClient } from "../lib/db.ts"  →  import { SurrealClient } from "@ax/lib/db"
#   import { surrealLiteral } from "./lib/shared/surql.ts"  →  import { surrealLiteral } from "@ax/lib/shared/surql"
```

Use a script. Suggested approach:

```bash
# Save this in scripts/rewrite-lib-imports.ts and run via bun.
# Handles all permutations of relative paths to ./lib.
```

Be careful with:
- `../lib/db.ts` → `@ax/lib/db`
- `./lib/db.ts` → `@ax/lib/db`
- `../lib/shared/surql.ts` → `@ax/lib/shared/surql`
- `../lib/live-traces/index.ts` → `@ax/lib/live-traces/index`

Drop the `.ts` extension in the new import path (the package exports define the resolution).

- [ ] **Step 4.5: Update test files too**

```bash
rg -l '"\./lib/' tests/  # if any tests live under tests/
rg -l '"\.\./lib/' src/**/*.test.ts
```

- [ ] **Step 4.6: Verify**

```bash
bun install
bunx tsc --noEmit                            # no new errors
bun test src/ingest/derive-checkpoints.test.ts
# Run multiple core tests:
bun test src/improve src/ingest src/dashboard
```

The big risk in this step: missed import rewrites. Plan for a follow-up if typecheck surfaces remaining `./lib/` paths.

---

## Task 5 - Move `src/` → `apps/axctl/src/`

**Goal:** The CLI lives in `apps/axctl/`. Binary `axctl` still resolves to a working entry point. LaunchAgent + install.sh + Nix flake updated.

**Files:**
- Move: `src/` → `apps/axctl/src/`
- Move: `bin/axctl` → `apps/axctl/bin/axctl`
- Create: `apps/axctl/package.json` (with `bin` field)
- Create: `apps/axctl/tsconfig.json` (extends base)
- Modify: root `package.json` (remove CLI-specific scripts from root, lives in `apps/axctl/package.json` now)
- Modify: `install.sh` (binary location path)
- Modify: `flake.nix` (build derivation paths)
- Modify: any code in `axctl install` that generates a LaunchAgent plist (the plist references `~/.local/bin/axctl` which symlinks to repo paths)

### Steps

- [ ] **Step 5.1: Move directories**

```bash
mkdir -p apps/axctl
git mv src apps/axctl/src
git mv bin apps/axctl/bin
```

- [ ] **Step 5.2: Create `apps/axctl/package.json`**

Lift CLI-specific deps + scripts from root `package.json`:

```json
{
  "name": "axctl",
  "version": "0.5.0",
  "private": false,
  "license": "AGPL-3.0-only",
  "description": "ax CLI - local memory and telemetry for coding agents",
  "type": "module",
  "bin": {
    "axctl": "./bin/axctl"
  },
  "files": [
    "bin",
    "dist"
  ],
  "scripts": {
    "build": "bun build src/cli/index.ts --outdir dist --target bun --minify",
    "dev": "bun run src/cli/index.ts",
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  },
  "dependencies": {
    "effect": "catalog:",
    "@effect/platform-bun": "catalog:",
    "@ax/lib": "workspace:*",
    "@ax/schema": "workspace:*",
    "...": "...lift CLI-specific deps from root package.json..."
  },
  "devDependencies": {
    "@effect/vitest": "catalog:",
    "@types/bun": "catalog:",
    "typescript": "catalog:"
  }
}
```

(Inspect current root `package.json` for the exact dep list. Move CLI deps to apps/axctl, keep infra deps like turbo at root.)

- [ ] **Step 5.3: Create `apps/axctl/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 5.4: Update `apps/axctl/bin/axctl` shim**

Verify the shim resolves the new src path correctly. It was likely something like `#!/usr/bin/env bun\nexec bun "$(dirname "$0")/../dist/main.js" "$@"`. If it's pointing to `../dist`, the new dist will be at `apps/axctl/dist/` (relative to `apps/axctl/bin/`), so the shim path stays correct.

If the shim hardcodes any absolute path, fix it.

- [ ] **Step 5.5: Update `install.sh`**

```bash
grep -n "src/\|bin/\|dist/" install.sh
```

For each match, update to `apps/axctl/...`. The install symlink target stays `~/.local/bin/axctl` but points to a path inside `apps/axctl/`.

- [ ] **Step 5.6: Update `flake.nix`**

```bash
grep -n "src\b\|bin\b" flake.nix
```

Update build derivation paths to point at `apps/axctl/`.

- [ ] **Step 5.7: Update LaunchAgent plist generation**

In `apps/axctl/src/cli/install.ts` (or wherever `axctl install` lives - was at `src/cli/install.ts`), find the plist generation. The `ProgramArguments` array references the axctl binary. Make sure it resolves to the new symlink path (which should be unchanged: `~/.local/bin/axctl`).

- [ ] **Step 5.8: Update `scripts/extract-stage-rationale.ts`**

This script reads from `src/ingest/stage/`. Update to `apps/axctl/src/ingest/stage/`.

- [ ] **Step 5.9: Update `apps/site/package.json` `predev`/`prebuild`/`build` scripts**

They reference `../scripts/extract-stage-rationale.ts` and `../install.sh`. After site moves to `apps/site/`, those references become `../../scripts/extract-stage-rationale.ts` and `../../install.sh`. Verify.

- [ ] **Step 5.10: Verify**

```bash
bun install
cd apps/axctl
bun run build                                # produces apps/axctl/dist/main.js
bun run typecheck
bun test src/ingest/derive-checkpoints.test.ts

# Simulate install
./bin/axctl --version
./bin/axctl doctor
./bin/axctl insights schema --limit=5

# Site still builds
cd ../site
bun run build
```

---

## Task 6 - Wire Turbo + per-package tsconfig + lint

**Goal:** Single command from root orchestrates all packages.

**Files:**
- Modify: `turbo.json` (already created in Task 1 - verify it covers all apps + packages)
- Modify: every package `tsconfig.json` to extend `../../tsconfig.base.json`
- Modify: root `package.json` scripts

### Steps

- [ ] **Step 6.1: Verify `turbo run build` walks the graph correctly**

```bash
bun run build                                # turbo run build
```

Should build `@ax/schema` first (no deps), then `@ax/lib` (depends on schema), then `axctl` (depends on lib + schema), then `@ax/site` (independent). Inspect the turbo log to confirm ordering.

- [ ] **Step 6.2: Verify `turbo run typecheck`**

```bash
bun run typecheck
```

Should typecheck every package. No new errors.

- [ ] **Step 6.3: Verify `turbo run test`**

```bash
bun run test
```

Should run all test files across all packages.

- [ ] **Step 6.4: Update `CONTRIBUTING.md` + `CLAUDE.md`**

Document the new structure. The current CLAUDE.md `## Layout` section needs to reflect the apps/packages split.

---

## Task 7 - Smoke test full feature set

**Goal:** Every feature ax claims to support keeps working. Manual checklist.

- [ ] CLI installs cleanly: `curl -fsSL ax.necmttn.com/install | sh`
- [ ] `axctl doctor` reports green
- [ ] `axctl ingest --since=1` ingests without error
- [ ] `axctl insights schema` queries SurrealDB
- [ ] `axctl improve list` shows current intervention queue
- [ ] `axctl serve` opens the dashboard at 127.0.0.1:8520
- [ ] `axctl tui` opens the interactive dashboard (if TUI is wired in this branch)
- [ ] LaunchAgent watcher (`com.necmttn.ax-watch`) starts and tails transcripts after `axctl install`
- [ ] Site loads at localhost:5173 via `cd apps/site && bun run dev`
- [ ] Site builds: `cd apps/site && bun run build`
- [ ] Site `/install` returns install script content
- [ ] All tests pass: `bun run test`

---

## Risk register

1. **Missed import rewrite** (Task 4). Some `./lib/` import survives the find/replace. Mitigation: post-task `bunx tsc --noEmit` MUST be clean. CI guard.
2. **LaunchAgent plist breaks** (Task 5). Plist references binary path; if path changes silently, watcher dies on next reboot. Mitigation: re-run `axctl install` after merge, verify plist with `launchctl list | grep ax-watch`.
3. **install.sh stale** (Task 5). The hosted install.sh is the one users curl. If it references old paths it breaks new installs. Mitigation: install.sh updates land in this PR, AND the static copy at `site/public/install` (mirrored from repo root) gets refreshed on next site build.
4. **Cloudflare Pages root directory setting** (Task 2). Dashboard requires manual update from `site` → `apps/site` AFTER merge. PR description must include this step. Suggestion: pin a follow-up issue.
5. **Effect Language Service plugin** (Task 1). The plugin config in `tsconfig.base.json` may conflict with the existing site `tsconfig.json` plugin config. Mitigation: merge configs carefully, verify both site dev and CLI dev still produce expected LS diagnostics.
6. **Test discovery paths** (Tasks 4, 5). `bun test` globs files relative to where it's invoked. Verify per-app `bun test` from `apps/axctl/` finds all CLI tests, from `apps/site/` finds site tests.
7. **Symlink resolution in `node_modules`**. Workspace symlinks may break some path resolution code that uses `__dirname` heuristics. Smoke test thoroughly.

---

## Rollback

If the PR introduces a regression that's not caught before merge, revert is straightforward:

```bash
git revert <merge-commit-sha>
```

But before merging, check:
- Does the test suite still pass?
- Does `axctl --version` work from a fresh install of the PR branch?
- Does the local site build + serve?

If any answer is no, fix before merging.

---

## Done When

- All Task 1-7 checkboxes ticked
- `bun run typecheck` clean across all packages
- `bun run test` green
- `bun run build` produces `apps/axctl/dist/main.js` and `apps/site/dist/client/_shell.html`
- Manual smoke test (Task 7) all green
- CLAUDE.md + CONTRIBUTING.md updated to reflect new structure
- PR description includes the Cloudflare Pages dashboard update note ("After merge: change Root directory from `site` to `apps/site`")

---

## Reference

- Cloned t3code: `.references/t3code/` (gitignored). Read its conventions but don't copy verbatim.
- t3code uses pnpm; we use Bun workspaces. Adapt all package manager commands.
- t3code uses Turbo + tsgo. We use Turbo + tsc + bun test. Adapt build commands.
- t3code apps build with tsdown. Our axctl builds with `bun build`, site builds with Vite. Keep per-app bundler.
