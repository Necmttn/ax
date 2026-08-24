# Remove retired commands from active interfaces

**Priority:** P1  
**Effort:** S  
**Risk:** LOW  
**Type:** bug  
**Baseline:** `5f06ce46`  
**Dependencies:** Plan 001

## Executor instruction

Repair active command names. Preserve compatibility code that does not appear in user guidance.

## Drift check

Inspect root `package.json`, `apps/axctl/package.json`, CLI command registration, Studio copy, and site CLI data. Stop if `search` or `serve` became supported commands after the baseline.

## Status

Ready after Plan 001.

## Why

Active scripts and user text call commands that return `Unknown subcommand`. These entries create false product surfaces.

## Current state

- Root `search` calls a missing top-level command.
- Root and package `serve` aliases call a retired command.
- Dashboard scripts refer to a missing Vite configuration file.
- Studio tells users to run `axctl serve`.
- The site shows `ax daemon start` and `ax dashboard`.
- The supported command is `ax studio`.

## Scope

- Repair or remove invalid aliases in both package files.
- Remove the ambiguous root `search` alias.
- Rename active `serve` aliases to `studio`.
- Route dashboard development through `@ax/studio`.
- Correct `README.md`, current docs, Studio copy, site examples, and site CLI reference data.
- Add `scripts/check-active-command-copy.ts` and its test.

## Out of scope

- Do not remove the hidden daemon retirement stub.
- Do not change command behavior or arguments.
- Do not change historical documents.

## Git workflow

Obtain an issue. Run `bun run wip claim <issue#> fix`. Work in its worktree. Use a Conventional Commit. Do not push without approval.

## Steps

1. Confirm failures.
   - Run `bun apps/axctl/src/cli/index.ts search` and `bun apps/axctl/src/cli/index.ts serve`.
   - Expect `Unknown subcommand` and exit code 1.
2. List package aliases.
   - Run `bun -e 'for (const p of ["package.json","apps/axctl/package.json"]) { const x=await Bun.file(p).json(); console.log(p,x.scripts) }'`.
3. Remove or repair the invalid aliases.
4. Replace active command text with `ax studio` or the correct current command.
5. Add a focused check for `axctl serve`, `ax daemon start`, and invalid package targets.
6. Run its focused tests.
7. Run `bun run check:active-command-copy`, `bun run check:cli-reference`, and `bun run check:site-cli-reference`.
8. Run `bun run typecheck` and `bun test`.

## Test plan

Test invalid active text, valid `ax studio` text, package aliases, and excluded historical files.

## Done criteria

- No active script calls `search`, `serve`, or a missing dashboard file.
- No active user text recommends retired commands.
- The check blocks future command drift.
- All checks pass.

## STOP conditions

- Stop if a retired command has a supported compatibility contract.
- Stop if a script is used by an external release process and has no replacement.

## Maintenance notes

Use CLI command metadata as the source for command names where possible.
