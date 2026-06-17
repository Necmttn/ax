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

## Claiming work (multi-agent)

Several agents (often all pushing as the **same** GitHub user) work this repo in
parallel, so the issue *assignee* can't tell you who owns what. The **branch
name is the claim**. Before starting an issue:

```bash
bun run wip list          # see open issues + which branch (if any) claimed each
bun run wip claim 481 fix # worktree + branch fix/481-<slug>, label, claim comment
cd .claude/worktrees/481-fix   # the path claim prints - do the work here, open a PR
bun run wip release 481   # only if you ABANDON it; merging the PR auto-clears the label
```

`claim` creates an **isolated worktree** at `.claude/worktrees/<issue#>-<type>` on
branch `<type>/<issue#>-<slug>` (this repo's enforce-worktree guard blocks edits on
the primary tree, so a claim never switches your current tree's branch), **pushes
the branch to origin**, adds the `status:in-progress` label, and posts a claim
comment carrying the branch + host so every other agent (and machine) sees the
claim - not just your local worktree. `wip list` reads those comments back:
🟢 = claimed (shows `branch [host, age]`), ⚪ = free to grab.

**Multiple devices (same user, many laptops):** claims live on GitHub, so `wip
list` shows the same truth everywhere - no local sync. Because `claim` pushes the
branch, you can continue or take over work started on another machine - re-running
`claim` for the same issue on a second device checks the existing remote branch out
into a fresh local worktree instead of forking a new branch:

```bash
bun run wip claim 481 fix   # on device B: "continuing existing branch fix/481-..."
```

The 🟢 line's `host` tells you which device owns it; the `age` flags a stale claim
(dead laptop) - clear it from any device with `bun run wip release <N>`.

**Conventions this relies on:**
- Branch = `<type>/<issue#>-<slug>` (e.g. `fix/481-classify-unclassified`). The
  leading `<issue#>` is what links work ↔ issue everywhere.
- One branch per issue; one agent per branch.
- Always work in a git worktree off that branch (the worktree guard blocks edits
  on `main`).

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

## Shipping a new signal

When you add a new write to the ax graph (table, edge, field, ingest stage) or a
new analytic query, run the **`ship-checklist`** skill before opening the PR. It
is the definition-of-done: every write needs an on-demand read AND a proactive
(agent-facing) read AND docs/distribution - not just the write. The recurring
miss is shipping the write + a manual CLI read while skipping the MCP tool,
`improve recommend` generator, and skill pattern that make the signal
discoverable by an agent. See `skills/ship-checklist/SKILL.md`.

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
