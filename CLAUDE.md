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

```
src/
├── lib/         # db client, paths, helpers
├── ingest/      # skills.ts, transcripts.ts (Claude), codex.ts
├── cli/         # CLI entrypoint
└── tui/         # OpenTUI dashboard (v0.1)
schema/          # SurrealQL schema
scripts/         # db lifecycle + reference cloning
skill/           # SKILL.md for Claude Code installable skill
.references/     # gitignored - clone of Effect source for AI lookup
```

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
- Skill names with `:` (plugin-namespaced) → encoded as `__` in record IDs (see `src/lib/skill-id.ts`)

## Reactivity

- LaunchAgent watcher (`com.necmttn.ax-watch`, installed by `axctl install`) tails `~/.claude/projects/` + `~/.codex/sessions/` and runs `axctl ingest --since=1` in the background on new transcripts. Do NOT add a Stop hook - Stop fires per turn and blocks Claude until ingest returns.
- Weekly self-improve cron (`~/.claude/self-improve/run.sh`) does deep-scan backfill (planned wire-up)

## Recommend + apply guidance to your own agent files

`axctl improve recommend / accept / lint / show` ship the v0 grounded-files
loop. `accept` emits a `.ax/tasks/<id>.md` brief; act on it like any other
task file, then run `axctl improve lint` to reconcile.

## Open issues

See https://github.com/Necmttn/ax/issues - v0.1 roadmap is 7 issues covering Effect refactor, schema/storage extensions, OpenTUI dashboard, signal derivation, reactivity, and self-improve integration.
