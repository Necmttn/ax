# Reference Repos

These repos are used as product and implementation references. Keep clones under
`.references/` so they do not affect the working tree.

## Executor

- Repo: `https://github.com/RhysSullivan/executor`
- Local clone: `.references/executor`
- Useful patterns:
  - installer flags for version pinning, local binaries, and no-PATH mutation
  - release runbook and compiled-binary smoke checks
  - daemon status/start/stop/restart commands
  - concise README with quickstart plus complete CLI reference
  - PR CI that runs tests, typecheck, build, and CLI smoke checks

## Effect

- Repo: `https://github.com/Effect-TS/effect-smol`
- Local clone: `.references/effect-smol`
- Used for Effect v4 API lookup and service/layer examples.
