# CLAUDE.md

Guidance for Claude Code and other AI assistants working in this repo.

## What this is

`ax` - local taste & telemetry graph for AI coding agents. Ingests Claude Code transcripts (`~/.claude/projects/`) + Codex transcripts (`~/.codex/sessions/`) + installed skills (`~/.claude/skills/`, `~/.agents/skills/`, plugin caches) into a dedicated SurrealDB instance. CLI surfaces "what skills/tools you actually use" on demand.

## Stack

- **Runtime**: bun ≥ 1.3
- **Language**: TypeScript (strict, `module: preserve`, `moduleResolution: bundler`)
- **DB**: SurrealDB 3.0+ on `127.0.0.1:8521`, ns=`ax`, db=`main`
- **Effect**: `effect@beta` (4.0.0-beta.x) for ingest pipelines + service layer (v0.1)
- **TUI** (planned): `@opentui/react` + react@19.2

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

**Build/test:** `bun run build` compiles the CLI to `dist/axctl`;
`cd apps/site && bun run build` builds the site; `bunx turbo run build`
orchestrates both. `bun test` (repo-wide) and `bun run typecheck` (axctl +
packages) are the CI gates. Site has its own `bun run typecheck` (strict
null-checks; needs a prior build for route/content codegen).

<!-- effect-solutions:start -->
## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

1. Run `effect-solutions list` to see available guides
2. Run `effect-solutions show <topic>...` for relevant patterns (supports multiple topics)
3. Search `.references/effect-smol/packages/effect/src` for real implementations

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

Never guess at Effect patterns - check the guide first.
<!-- effect-solutions:end -->

## Local Effect Source

The Effect v4 source (`effect-smol`) is shallow-cloned to `.references/effect-smol`. Use this to:
- Explore APIs and find real usage examples
- Read implementation details when documentation isn't enough
- Verify type signatures of beta APIs

Run `bun refs:setup` after fresh clone to populate `.references/`.

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

- Trigger an in-process ingest run from `ax serve` via `POST /api/ingest` (or the **Live** tab in the dashboard). The run is forked onto the server's long-lived runtime and reuses the same `runIngest` pipeline as the CLI.
- Progress is published to a **per-run Durable Stream** named `ingest:<runId>` (`ingestStreamName`). `runIngest` live-trace spans become `IngestStreamEvent`s, flow through the `IngestStreamBus`, and land on a Durable Streams sidecar that the browser subscribes to directly. The backend guarantees exactly one terminal `run_finished` event (synthetic `failed` on cause).
- The dashboard live view subscribes from offset `-1` (replay history from start, then continue live), so a **page refresh / reconnect mid-run rehydrates** already-done stages and resumes the live tail - the Durable Streams offset-resume payoff vs raw SSE. (See `docs/superpowers/research/durable-streams-api.md` for the embed-vs-sidecar decision.)
- The `IngestStreamBus` seam (`apps/axctl/src/dashboard/ingest-stream.ts`) means the local Durable-Streams-in-Bun backing can later be swapped for a hosted backend without touching the producers or the UI.
- The CLI `ax ingest` and its terminal step animation (`apps/axctl/src/cli/ingest-trace-progress.ts`) are **unchanged** - the server path reuses `runIngest`, the CLI never passes a `runId`, and `AX_PROGRESS=off` still silences the CLI animation.
- Live ingest in the dashboard requires running ax **from source** (the `bin/axctl` shim already does this). The compiled standalone binary serves the dashboard but disables live ingest - native lmdb can't bundle into the `--compile` binary, so the sidecar is skipped and `POST /api/ingest` returns 503.

## Workflow extraction commands

### Scoped ingest

`ax ingest here [--since=Nd] [--stages=<list>]` - scope ingest to the git repo at `$PWD`. Claude transcripts filtered to the matching `~/.claude/projects/<slug>/` dir; git history restricted to this repo; Codex skipped. `--stages=` overrides the default stage set (uses StageRegistry).

### Session queries

`ax sessions here [--days=N]` - pwd-scoped sessions, default 14d.
`ax sessions around <date> [--days=N] [--project=PATH]` - date window, default ±3d.
`ax sessions near <sha>` - predecessor→commit window (adaptive); falls back to ±3d for orphan commits.
`ax sessions show <id> [--expand=<uuid>|--all] [--by-role] [--json]` - drill into one session.

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

## Recommend + apply guidance to your own agent files

`axctl improve recommend / accept / lint / show` ship the v0 grounded-files
loop. `accept` emits a `.ax/tasks/<id>.md` brief; act on it like any other
task file, then run `axctl improve lint` to reconcile.

## Workflow Candidate Guardrails

<!--ax:guidance__workflow_candidate__b7717e979a1fb149-->
When a user correction matches `reaction-event:correction:prototype_completeness + correction-event:correction:wrong_artifact`, do not stop at a surface artifact or plan. Use the preceding agent action and the user correction as context, then produce the concrete result the user asked for. For the scoped topic `surrealml`, set up and run the relevant classifier or explain the blocking reason, then show the applied result evidence. Preserve the classifier candidate ids and evidence refs when turning this into a durable guidance or harness change.
<!--/ax:guidance__workflow_candidate__b7717e979a1fb149-->

## Open issues

See https://github.com/Necmttn/ax/issues - v0.1 roadmap is 7 issues covering Effect refactor, schema/storage extensions, OpenTUI dashboard, signal derivation, reactivity, and self-improve integration.
