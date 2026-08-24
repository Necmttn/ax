# Simplify the default CLI and Studio surfaces

**Priority:** P2  
**Effort:** M  
**Risk:** MED  
**Type:** UX  
**Baseline:** `5f06ce46`  
**Dependencies:** Plans 002 and 003

## Executor instruction

Reduce default navigation only. Keep advanced commands and routes callable.

## Drift check

Inspect `visible-commands.ts`, CLI help tests, `apps/studio/src/nav/manifest.ts`, router definitions, route capability gates, and site reference generation. Stop if usage data now defines a different core set.

## Status

Ready after Plans 002 and 003.

## Why

The default CLI shows 33 commands. The Studio rail shows 13 entries although its own guidance says more than eight entries is poor.

## Target surfaces

Show these 12 commands in default CLI help:

`install`, `setup`, `doctor`, `ingest`, `studio`, `sessions`, `recall`, `skills`, `improve`, `cost`, `profile`, and `share`.

Show these seven Studio rail entries:

Mission Control, Sessions, Cost, Workflow, Skills, Tool Failures, and Improve.

Keep these access paths:

- Open Skill Graph from Skills.
- Open Usage and Team Metrics from Mission Control.
- Open Canvas, Graph, and Lab through contextual links or deep links.
- Keep Graph Explorer behind the Lab capability gate.

## Scope

- Add command visibility categories such as `core`, `advanced`, `service`, and `compatibility` if this reduces hard-coded lists.
- Update default CLI help and its tests.
- Update Studio navigation and its tests.
- Add contextual links for removed rail entries.
- Keep the full site CLI reference complete.
- Record hidden surface reasons in code or data.

## Out of scope

- Do not delete commands or routes.
- Do not change command arguments or API contracts.
- Do not redesign route content.
- Do not remove compatibility stubs.

## Git workflow

Obtain an issue. Run `bun run wip claim <issue#> feat`. Work in its worktree. Use a Conventional Commit. Do not push without approval.

## Steps

1. Capture current output with `bun apps/axctl/src/cli/index.ts --help`.
2. Add explicit visibility data to command metadata.
3. Render only the 12 core commands in default help.
4. Test direct invocation of representative advanced, service, and compatibility commands.
5. Reduce the Studio rail to seven entries.
6. Add contextual links for useful removed entries.
7. Keep Graph Explorer out of normal navigation and behind its current capability gate.
8. Test exact CLI and Studio lists.
9. Run focused CLI and Studio tests.
10. Run `bun run check:cli-reference`, `bun run check:site-cli-reference`, `bun run typecheck`, and `bun test`.

## Test plan

Assert exactly 12 default commands and seven rail entries. Test direct calls to hidden commands. Test route access and Graph Explorer gating.

## Done criteria

- Default CLI help shows the exact 12-command set.
- The Studio rail shows the exact seven-entry set.
- Advanced commands and routes remain callable.
- Full reference documentation remains complete.
- Focused and full tests pass.

## STOP conditions

- Stop if telemetry shows that a removed default item is a primary entry point.
- Stop if hiding a command removes it from shell completion or the full reference.
- Stop if a route has no safe contextual access path.

## Maintenance notes

Set a hard review for each new default command or rail entry. Require a clear user task and usage evidence.
