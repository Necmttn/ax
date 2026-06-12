# Hooks ownership split: hooks-sdk owns definition + fire path, axctl owns config + analysis

Status: Accepted (2026-06-13)

Hook functionality had grown in two places at once - `packages/hooks-sdk` (the
fire-path runtime consumed from `~/.ax/hooks` via a `file:` dep) and
`apps/axctl/src/hooks` (the CLI surface) - with no stated boundary. The locked
split:

- **`@ax/hooks-sdk`** owns the typed hook definition (`defineHook`,
  `HookDefinition`, `runHook`/`runMain`), verdicts (allow / block / warn /
  inject, defects fail OPEN), the fire path (`bun <file>.ts`, ~70ms budget, no
  axctl in the hot path), the prebuilt hooks (`enforce-worktree`,
  `enforce-worktree-write`, `route-dispatch`), the `GitEnv` service, AND the
  routing-table schema + loader (`src/routing-table.ts`: Schema validation,
  `~/.ax/hooks/routing-table.json` path, sync fail-open read for the fire
  path, normalized Effect read for the compile side).
- **`axctl`** owns provider config CRUD via `HookProviderRegistry`
  (claude/codex codecs, ax ownership markers, park sidecars), install fan-out
  (`ax hooks init|install`), telemetry (`hook_command_invocation` evidence
  joins), backtest/cases (`ax hooks backtest|cases`), and routing ANALYSIS +
  WRITES (`ax dispatches`, `ax routing compile|tune|show`:
  merge/append/save in `queries/routing-table-io.ts`).

The dependency arrow only ever points axctl → hooks-sdk. The sdk stays
dependency-light (`effect` only, pinned not catalog:) because `~/.ax/hooks`
workspaces resolve it outside the monorepo.

## Consequence: routing-table dedup

`route-dispatch.ts` and `queries/routing-table-io.ts` each carried their own
schema + parse of routing-table.json, and the default class seed was duplicated
verbatim (`DEFAULT_TABLE` in the hook, `ROUTING_CLASSES` in
`dispatch-analytics.ts`) with mirror-me comments. Both now import one module,
`@ax/hooks-sdk/routing-table`; `ROUTING_CLASSES` is an alias of the sdk's
`DEFAULT_ROUTING_TABLE`, so the hook's fallback and the compile seed cannot
drift. The defaults live in the sdk rather than axctl because the fire path
must work before any `ax routing compile` step exists; axctl re-exports them,
so no import cycle (this also broke the prior routing-table-io ↔
dispatch-analytics cycle).

The two read semantics are deliberately both kept, side by side in the one
module: the fire path does a whole-table fail-open decode (any problem →
built-in defaults; a corrupt table must never wedge the agent), while the
compile side normalizes row-by-row and returns null on a structurally bad file
(so `ax routing compile` can refuse to overwrite it).

Also folded in: `route-dispatch` no longer requires `GitEnv` - routing is pure
table matching on tool input. `HookDefinition.run`'s R-channel stays typed as
`GitEnv` (covariant, `never` is assignable), so hooks that need git state keep
it and pure hooks just don't yield it.

## Trade-offs

- The sdk imports `node:fs` in `routing-table.ts` (sync read keeps the hook's
  error channel `never` under plain bun); the `check:no-node-fs` allowlist
  entry moved from `hooks/route-dispatch.ts` to `routing-table.ts`.
- Match logic is still implemented twice (`matchTable` in the hook,
  `matchRoutingWith` in `dispatch-analytics.ts`) - same table, near-identical
  semantics. Left as-is for now: the candidates path matches with
  required-flags rows while the hook must tolerate hand-edited optional flags;
  unifying it is a candidate follow-up, not part of this split.
