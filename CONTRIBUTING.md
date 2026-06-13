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

## Brand & naming for contributors

The brand is the product - every contributor surface should feel like the same
hand drew it. The public, visitor-facing brand (wordmark, palette, typography,
voice, motifs) is documented and demonstrated live at
[`/brand`](https://ax.computer/brand). This section covers the contributor-side
mechanics that don't belong on the public page.

### Naming in code vs. copy

- Visitor-facing copy is always **`ax`** (`ax doctor`, `ax serve`, `ax retro`),
  never `axctl`.
- `axctl` is the npm package / binary name - use it only when the technical
  layer genuinely matters (`axctl install`, the `bin/axctl` shim). User stories
  say "run `ax doctor`", not "run `axctl doctor`".
- New user-facing commands follow `ax <verb>`. Check
  [`CONTEXT.md`](CONTEXT.md) for the domain vocabulary before naming a new
  command, table, or field.

### Receipts and scrubbing

- Docs, the README, and showcases use **real CLI output** - real timestamps,
  real token counts, real session ids. Don't fake data to make a point land.
- **Scrub project names** in any committed receipt or screenshot. Use the
  `acme-app` / `acme-api` placeholder for repo names so no contributor's
  private project names leak into the repo.

### Commit messages

- **No emoji** in commit messages, code, or docs unless a maintainer explicitly
  asks. Conventional-commit prefixes only (see Ground rules above).
- **No ALL-CAPS headings** except `AGENT EXPERIENCE` (the brand tag) and
  uppercase column headers in dashboard tables.
- **No marketing taglines on commands.** "`ax doctor` - checks your system"
  beats "`ax doctor` - your trusted AI health companion".

## License

By contributing, you agree your contribution will be licensed under the
project license (see [LICENSE](LICENSE)).
