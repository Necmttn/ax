# CLAUDE.md

Guidance for Claude Code and other AI assistants working in this repo.

## What this is

`ax` - local taste & telemetry graph for AI coding agents. Ingests transcripts from 5 harnesses - Claude Code (`~/.claude/projects/`), Codex (`~/.codex/sessions/`), Pi (`~/.pi/agent/sessions/`), OpenCode + Cursor (SQLite stores) - plus installed skills (`~/.claude/skills/`, `~/.agents/skills/`, plugin caches) into a dedicated SurrealDB instance. Each harness has a full parser dual-writing provider events (`agent_*` tables) + normalized records (`session`/`turn`/`tool_call`); `AgentProviderName` enumerates them (`apps/axctl/src/ingest/provider-events.ts`). CLI surfaces "what skills/tools you actually use" on demand.

## Stack

- **Runtime**: bun ≥ 1.3
- **Language**: TypeScript (strict, `module: preserve`, `moduleResolution: bundler`)
- **DB**: SurrealDB 3.0+ on `127.0.0.1:8521`, ns=`ax`, db=`main`
- **Effect**: `effect@beta` (4.0.0-beta.x) for ingest pipelines + service layer (v0.1)
- **TUI**: `@opentui/react` + react@19.2 - skills browser (`apps/axctl/src/tui/`) + ingest progress (`apps/axctl/src/cli/progress-tui.tsx`)

## Layout

Bun-workspace monorepo. `apps/*` are deployable products, `packages/*` are
shared internal libraries (raw `.ts` via per-file `exports`, no build step).
Turbo (`turbo.json`) orchestrates build/typecheck/test; every package extends
`tsconfig.base.json`; versions are pinned in the root `workspaces.catalog`.

```
apps/
├── axctl/                 # the CLI (npm package "axctl")
│   ├── bin/axctl          # shell shim → src/cli/index.ts
│   └── src/
│       ├── lib/  (NOTE: moved to @ax/lib) cli/ ingest/ dashboard/ hooks/
│       ├── improve/ classifiers/ queries/ context/ project/ tui/ ...
│       └── ...            # the whole former /src tree
└── site/                  # landing site (@ax/site, TanStack Start SPA → CF Pages)
packages/
├── lib/                   # @ax/lib - db client, paths, errors, layers, shared/, live-traces/
├── schema/                # @ax/schema - schema.surql (DDL) + derived types
└── ax-classifier-*/       # @ax-classifier/* + python classifier experiments
scripts/                   # repo-wide orchestration (db lifecycle, checks, prototypes)
skill/                     # SKILL.md for the installable Claude Code skill
.references/               # gitignored - clone of Effect source for AI lookup
turbo.json  tsconfig.base.json  package.json (root = workspace orchestrator)
```

Internal imports resolve by package name: `@ax/lib/db`, `@ax/lib/shared/surql`,
`@ax/schema/schema.surql` (with `{ type: "text" }`), `@ax-classifier/...`.

**Build/test:** `bun run build` → `dist/axctl`; `bunx turbo run build` does CLI
+ site. CI gates: `bun test` (repo-wide) + `bun run typecheck`. Site's own
`bun run typecheck` is strict-null and needs a prior build (route/content codegen).

<!-- effect-solutions:start -->
## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

1. Run `effect-solutions list` to see available guides
2. Run `effect-solutions show <topic>...` for relevant patterns (supports multiple topics)
3. Search `.references/effect-smol/packages/effect/src` for real implementations

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

Never guess at Effect patterns - check the guide first.
<!-- effect-solutions:end -->

Effect v4 source (`effect-smol`) is shallow-cloned to `.references/effect-smol`
for API/usage/type lookup on beta APIs. `bun refs:setup` populates it after a
fresh clone.

## Schema rules of thumb

- SurrealDB v3 SCHEMAFULL - top-level fields explicit
- Nested objects → JSON-encoded as `string` (no `flexible<object>` in v3)
- Datetime fields require JS `Date` objects via the SDK (not ISO strings)
- Skill names with `:` (plugin-namespaced) → encoded as `__` in record IDs (see `packages/lib/src/skill-id.ts`)

## Reactivity

- LaunchAgent watcher (`com.necmttn.ax-watch`, installed by `axctl install`) tails `~/.claude/projects/` + `~/.codex/sessions/` and runs `axctl ingest --since=1` in the background on new transcripts. Do NOT add a Stop hook - Stop fires per turn and blocks Claude until ingest returns.
- Weekly self-improve cron (`~/.claude/self-improve/run.sh`) does deep-scan backfill (planned wire-up)
- `ax-extract-workflow` skill (installable via `npx skills add Necmttn/ax`) frames "what made X work" investigations - triggers retro + session queries to surface the actual sequence of events behind a result.

### Live ingest in the dashboard

- `ax serve` → `POST /api/ingest` (or the **Live** tab) forks `runIngest` (same pipeline as CLI) onto the server runtime. Progress flows as `IngestStreamEvent`s through the `IngestStreamBus` seam (`apps/axctl/src/dashboard/ingest-stream.ts`) to a per-run Durable Stream `ingest:<runId>`; the browser subscribes from offset `-1`, so refresh/reconnect mid-run rehydrates. Exactly one terminal `run_finished` event guaranteed. The bus seam lets the Bun backing swap for a hosted backend later untouched.
- CLI `ax ingest` is unchanged (never passes a `runId`). Progress animates on a TTY by default; non-TTY is silent unless forced with `AX_PROGRESS=on` (or `--progress=plain|pipeline`). `AX_PROGRESS=off` silences. Gated in `withIngest` (`apps/axctl/src/cli/index.ts`).
- **Live ingest needs ax from source** (the `bin/axctl` shim does this). The compiled `--compile` binary serves the dashboard but returns 503 on `POST /api/ingest` - native lmdb can't bundle, so no sidecar. `/api/version` advertises this as `live_ingest: false`; the studio Live tab then falls back to polling the count tiles every 5s (`apps/studio/src/poll-fallback.ts`) instead of a dead stream.
- **Daemon self-awareness**: `ax serve` writes a pidfile (`~/.local/share/ax/serve.json`, `AX_DATA_DIR` override) and pre-flight-probes its port - re-running it against a live daemon prints the dashboard URLs (exit 0), a foreign listener gets a clean lsof/`--port` hint (no stack trace). `ax serve status` / `ax serve stop` resolve the instance via pidfile → `/api/version` probe → lsof, so they also find pre-pidfile daemons; `stop` only ever kills the pid actually LISTENing on the port. Logic: `apps/axctl/src/dashboard/serve-instance.ts` + `serve-control.ts`.

## Workflow extraction commands

### Scoped ingest

`ax ingest here [--since=Nd] [--stages=<list>]` - scope ingest to the git repo at `$PWD`. Claude transcripts filtered to the matching `~/.claude/projects/<slug>/` dir; git history restricted to this repo; Codex/Pi/OpenCode/Cursor skipped (no cwd filter yet). `--stages=` overrides the default stage set (uses StageRegistry).

### Session queries

`ax sessions here [--days=N]` - pwd-scoped sessions, default 14d.
`ax sessions around <date> [--days=N] [--project=PATH]` - date window, default ±3d.
`ax sessions near <sha>` - predecessor→commit window (adaptive); falls back to ±3d for orphan commits.
`ax sessions show <id> [--expand=<uuid>|--all] [--by-role] [--json]` - drill into one session.
`ax sessions churn [--here|--project=PATH] [--source=S] [--since=N]` - verification churn by session/source: landed vs edit vs repair LOC, failed checks, episodes (failure opens, same-family pass closes, 30min expiry). Default 30d window.

### Cross-source recall

`ax recall <q> [--sources=turn,commit,skill] [--scope=here|all]` - full-text search across turns, commits, and skills. `--scope` auto-detects to current repo when run inside a git tree.

### Skills classification

`ax skills classify [<skill>...]` - bulk-emit `.ax/tasks/classify-*.md` briefs for unclassified skills with ≥3 invocations.
`ax skills tag <skill> <role> [--confidence=N] [--rationale="..."] [--remove]` - one-shot role override.
`ax skills lint [--task-dir=<path>] [--dry-run]` - apply filled classify briefs to `plays_role` edges.
`ax skills weighted [--window=Nd] [--limit=N]` - usage × role-weight ranking; enters doctor mode when many skills are unclassified.
`ax skills by-role <role>` - list skills tagged with a given role.
`ax skills roles <skill>` - list roles for a skill.

### Role registry

`ax roles` - list known role labels.

### Cost analytics

`ax cost models [--days=N]` - per-model rollup: sessions, prompt/completion/cache tokens, estimated cost USD (default 14d).
`ax cost sessions [--days=N] [--model=<name>] [--limit=N]` - top sessions by cost with id, project, model, started_at (default 14d/20 rows).
`ax cost split [--days=N]` - origin (main vs subagent) × model matrix with cost and share-of-total; totals row. MCP: `cost_models`, `cost_split`.

### Profile

`ax profile show [--window=N] [--no-cost] [--json]` - render your local ax
profile (ProfileV1: stats + rig + taste patterns) from the graph.
`ax profile publish [--window=N] [--no-cost] [--if-stale=H] [--yes] [--skip-registration]` -
publish to a public gist (create once, PATCH in place). First run: consent
prompt showing the exact JSON, then fork + community/users/<login>.json
registration PR into Necmttn/ax (git-data API, no local clone). The watcher
runs `--if-stale=6` after ingest - silent no-op until first consent.
`--no-cost` is sticky across republishes; `ax profile unpublish` (delete
gist + local state) resets it. State: `~/.ax/profile-publish.json`. Spec:
docs/superpowers/specs/2026-06-12-ax-profiles-design.md; site routes land
in plan 4.

Community rails: `community/users/<login>.json` registrations are validated
(schema + author==filename, `scripts/validate-community-users.ts`) and
auto-merged by `community-users.yml` (pull_request_target; PR head is data
only, never executed); `community-nightly.yml` compiles registered gists
into `community/{leaderboard,skill-stats,hook-stats,state/<year>}.json`
(`scripts/compile-community.ts`, ETag-cached, absurd rows dropped). Compiled
files are generated - never hand-edit.

Site: `/u/<login>` renders a registered user's gist profile live;
`/leaders` renders compiled boards + trending skills (empty-state until the
first nightly compile). Both client-fetch from raw.githubusercontent / gist
raw; validation in `apps/site/app/lib/community.ts` (manual - the site does
not depend on effect).

### Dispatch routing

`ax dispatches [--days=N] [--limit=N]` - subagent dispatch table sorted by child cost (default 14d/30 rows). Shows ts, agent_type, description, dispatch_model ("inherit" when no explicit model), child_model, child_cost_usd. Summary: count, % inherit, total subagent cost. MCP: `dispatches`.
`ax dispatches --candidates [--days=N]` - inherit + expensive (fable/opus) + routing-class match filter. Shows suggested model + est savings per dispatch. Footer: total est savings, top 3 classes by savings.
`ax routing compile [--out=PATH]` - merge-preserving regenerate of `~/.ax/hooks/routing-table.json` (defaults refresh, `origin: user` classes survive; refuses to overwrite a corrupt file). `ax dispatches compile-routing` is an alias.
`ax routing tune [--days=N] [--dry-run] [--emit-brief] [--apply=id,...] [--out=PATH]` - mine unmatched expensive inherit dispatches for new routing classes (two-token prefix clustering, ≥3 members, suggests sonnet). Auto-applies non-judgment proposals to `~/.ax/hooks/routing-table.json` as `origin: user`; judgment-flagged ones (review/design/plan/audit/...) only ship via `--emit-brief` → `.ax/tasks/routing-tune-<date>.md` → agent backtest → `--apply=ids` (carry the brief's `--days` window).
`ax routing show` - effective table with class origins.
The routing-table file is now the source of truth for BOTH the route-dispatch hook and `ax dispatches --candidates` (unify done); `ROUTING_CLASSES` remains the shipped default seed. The committed `/routing-tune` workflow stays the dev-side tool for tuning the defaults themselves.

## Recommend + apply guidance to your own agent files

`axctl improve recommend / accept / lint / show` ship the v0 grounded-files
loop. `accept` emits a `.ax/tasks/<id>.md` brief; act on it like any other
task file, then run `axctl improve lint` to reconcile.

## MCP server

`ax mcp` runs a stdio MCP server exposing ax's **read-only** queries as 10 tools
(`recall`, `sessions_around`, `session_show`, `skills_weighted`, `skills_by_role`,
`skills_roles`, `roles`, `improve_recommend`, `improve_show`, `improve_list`) so an
agent can query the graph in-context. Run from source (no native deps, so the
compiled binary should work too - untested in v0). Mutating
ops + `sessions_here`/`near` (need a git-resolved repo key) are intentionally not
exposed. Server: `apps/axctl/src/mcp/server.ts`; registry: `apps/axctl/src/mcp/tools.ts`.

## Hooks SDK

`@ax/hooks-sdk` (packages/hooks-sdk) - author agent hooks once in typed Effect
TS, run them on Claude Code + Codex. Hook = one file in `~/.ax/hooks/`
default-exporting `defineHook({ name, events, matcher, run })`; fire path is
`bun <file>.ts` (no axctl in the hot path; ~70ms). Verdicts: allow / block /
warn / inject; defects fail OPEN. `GitEnv` service makes guards layer-testable.

- `ax hooks init` - scaffold `~/.ax/hooks` (file: dep on packages/hooks-sdk;
  re-run after the SDK moves - the dep is an absolute path)
- `ax hooks install <abs-file> --providers=claude,codex` - idempotent fan-out
  into provider configs via the existing codecs (ax ownership markers)
- `ax hooks backtest <file> [--days]` - replay tool_call history through the
  hook in-process; state-dependent checks use CURRENT repo state (caveat printed)
- `ax hooks cases` - deterministic feedback-case backtests (enforce-worktree
  candidate query + structured pass/fail verdict; separate from backtest)
- Codex: new hook entries written to `~/.codex/hooks.json` when that file
  exists; falls back to `~/.codex/config.toml` otherwise. New/changed entries
  require interactive trust approval in the codex TUI before they fire.
- The worktree guards (enforce-worktree, enforce-worktree-write) run via the
  SDK in both harnesses; bash originals retired (kept on disk as fallback)

## Workflow Candidate Guardrails

<!--ax:guidance__workflow_candidate__b7717e979a1fb149-->
When a user correction matches `reaction-event:correction:prototype_completeness + correction-event:correction:wrong_artifact`, do not stop at a surface artifact or plan. Use the preceding agent action and the user correction as context, then produce the concrete result the user asked for. For the scoped topic `surrealml`, set up and run the relevant classifier or explain the blocking reason, then show the applied result evidence. Preserve the classifier candidate ids and evidence refs when turning this into a durable guidance or harness change.
<!--/ax:guidance__workflow_candidate__b7717e979a1fb149-->

## Open issues

See https://github.com/Necmttn/ax/issues - v0.1 roadmap is 7 issues covering Effect refactor, schema/storage extensions, OpenTUI dashboard, signal derivation, reactivity, and self-improve integration.
