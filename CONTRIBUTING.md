# Contributing to ax

Thanks for opening this - `ax` is a young project and feedback shapes it
fast.

## Ground rules

- **Open an issue before a PR** for anything bigger than a one-line fix or
  doc tweak. Saves both of us a wasted afternoon.
- **One concern per PR.** A drive-by refactor inside a feature PR makes
  review hard. Split it.
- **Tests for ingest / signal logic.** UI and dashboard changes can usually
  skip tests; pipeline changes cannot.
- **Conventional commits.** `feat:`, `fix:`, `chore:`, `refactor:`,
  `docs:`, `test:` - scope optional. Release-please reads these.

## Local setup

```bash
bun install
bun scripts/db-start.sh
bun scripts/apply-schema.sh
bun apps/axctl/src/cli/index.ts ingest --since=7   # or: bun run ingest --since=7
```

Requirements: Bun ≥ 1.3, SurrealDB ≥ 3.0.

## Repo layout

Bun-workspace monorepo: `apps/axctl` (the CLI), `apps/site` (landing site),
`packages/lib` (`@ax/lib`), `packages/schema` (`@ax/schema`), plus the
`@ax-classifier/*` packages. Turbo orchestrates tasks; see [`CLAUDE.md`](CLAUDE.md)
for the full tree. Internal code imports by package name (`@ax/lib/db`), not
relative paths across packages.

## Verify before pushing

```bash
bun test
bun run typecheck
```

CI runs both - failing either blocks merge.

## Code style

- TypeScript strict, `module: preserve`, `moduleResolution: bundler`.
- `Effect` v4-beta for pipelines and the service layer. See
  [`CLAUDE.md`](CLAUDE.md) for Effect best practices and where to look up
  patterns.
- SurrealDB v3 SCHEMAFULL - top-level fields explicit, nested objects
  JSON-encoded as strings (no `flexible<object>` in v3).

## Reporting issues

Use the templates in `.github/ISSUE_TEMPLATE/`. For bugs, include:

- `axctl version --json`
- `axctl doctor --json`
- Steps to reproduce
- Relevant lines from `~/.local/share/ax/logs/`

## Domain language

`ax` is opinionated about vocabulary - Repository vs. Checkout vs.
Worktree vs. Workspace are not interchangeable. See
[`CONTEXT.md`](CONTEXT.md) before naming new tables, fields, or commands.

## License

By contributing, you agree your contribution will be licensed under the
[MIT License](LICENSE).
