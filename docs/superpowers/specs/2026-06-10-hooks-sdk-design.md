# @ax/hooks-sdk - typed agent hooks: write once, run + backtest everywhere

**Date:** 2026-06-10
**Status:** approved (brainstorm w/ Neco)
**Origin:** hook-parity gap - Claude worktree guards (`enforce-worktree.sh`, `enforce-worktree-write.sh`) never ported to Codex. Bash + per-harness config doesn't scale; ax already owns the cross-harness hook config layer and the historical tool-call graph, so it should own hook authoring and backtesting too.

## Problem

- Hooks are bash scripts with divergent input contracts (env vars vs stdin JSON), duplicated per harness, untestable, and installed by hand into N config files.
- No way to answer "would this hook have fired?" before deploying it. ax's graph has the data (`tool_call` rows with `input_json` across 5 harnesses) - nothing replays it.

## Decisions (locked)

| Decision | Choice | Why |
|---|---|---|
| v0 scope | SDK + install + backtest | backtest is the differentiator |
| Fire-time invocation | `bun <hook>.ts` direct | no axctl in hot path; backtest imports same module in-process |
| Runtime posture | Effect-native throughout | testability wins; measured 70–100ms effect import vs 10ms plain - acceptable; compile/bundle later if it hurts |
| Decision surface | `Verdict` union: allow / block(reason) / warn(msg) / inject(context) | maps to exit-2+stderr (both harnesses) + JSON decisions where supported |
| First hooks (dogfood) | port both worktree guards | real guards, real probe, acceptance gate |

## Architecture

```
packages/hooks-sdk/          @ax/hooks-sdk - Effect-native, importable by hook authors
├── event.ts                 HookEvent schema (normalized union across harnesses)
├── adapters/claude.ts       raw stdin/env → HookEvent; Verdict → harness reply
├── adapters/codex.ts        (Codex hooks contract: PreToolUse fires for Bash,
│                             apply_patch, MCP only; block = exit 2 + stderr)
├── define.ts                defineHook() + runMain()
└── verdict.ts               Verdict union

~/.ax/hooks/                 hook workspace, scaffolded by `ax hooks init`
├── package.json             deps: @ax/hooks-sdk
├── enforce-worktree.ts
└── enforce-worktree-write.ts

apps/axctl/src/hooks/        existing seam, extended
├── sdk-install.ts           `ax hooks install <file> --providers=…` → existing addHook + codecs
└── backtest.ts              `ax hooks backtest <file> [--days] [--provider]`
```

## Authoring API

```ts
import { defineHook, runMain, Verdict } from "@ax/hooks-sdk";

export default defineHook({
  name: "enforce-worktree",
  events: ["PreToolUse"],
  matcher: { tools: ["Bash"] },
  run: (event) => Effect.gen(function* () {
    // event.tool.name / event.tool.input.command - typed
    // yield* Git.isPrimaryTree(event.cwd) - HookEnv service, layer-mockable
    return Verdict.block("BLOCKED: …");
  }),
});
if (import.meta.main) runMain();
```

- `run: (event: HookEvent) => Effect<Verdict, never, HookEnv>`; `HookEnv` = Git/Fs services
- Adapter auto-detects harness from input shape; encodes Verdict per harness
- Bypass env flags (`ALLOW_BRANCH_CHECKOUT` etc.) preserved as SDK helper

## Install

`ax hooks install <file> --providers=claude,codex`
- imports module, reads `events`/`matcher` metadata
- writes `bun <abs path>` entries via existing provider codecs + ownership markers
- `ax hooks config` lists it; fired-evidence join works day one
- Codex trust approval stays manual (hash review in Codex)

## Backtest

`ax hooks backtest <file> [--days=30] [--provider=…]`
- replays `tool_call` rows (name + `input_json` → synthetic HookEvent), calls `run()` in-process
- report: would-fire count/rate, per-repo breakdown, sample fired commands, overlap vs actual `hook_command_invocation` fires
- **caveat (documented):** state-dependent checks (dirty tree, branch) evaluate against *current* state; pattern guards backtest cleanly, stateful ones approximate

## Dogfood = acceptance

1. Port both worktree guards to SDK hooks in `~/.ax/hooks/`
2. Install into Claude + Codex
3. Probe: scratch repo on main → `codex exec "git checkout b1"` blocked; Claude regression blocked
4. Backtest 30d → fire-rate sanity vs known blocks
5. Bash scripts retired only after probe passes

Known upstream gap: Codex PreToolUse doesn't fire for native Edit/Write file ops (Bash/apply_patch/MCP only) - write-guard parity on Codex limited to apply_patch + Bash-mediated writes until Codex extends coverage.

## Testing

- Adapters: unit tests against captured real payloads (Claude + Codex stdin fixtures)
- Hook logic: `bun:test` + HookEnv layer mocks
- Backtest: golden test over fixture `tool_call` rows
