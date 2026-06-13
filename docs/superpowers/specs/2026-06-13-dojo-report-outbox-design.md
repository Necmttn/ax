# ax dojo report + outbox writers

Date: 2026-06-13
Status: approved design, pre-implementation
Follows: docs/superpowers/specs/2026-06-13-ax-dojo-design.md (core loop, shipped PR #390)

## Problem

The dojo core loop emits an agenda and tells the skill agent to hand-write the
morning report and upstream issue drafts as markdown. Hand-authored artifacts
drift in shape and aren't machine-checkable. ax's identity is receipts -- the
dojo's nightly output should be evidence-derived and reproducible, not prose.

This piece hardens the loop's output end into CLI writers:
- `ax dojo report` -- evidence-derived morning report (idempotent)
- `ax dojo draft` -- write a staged upstream issue draft to the outbox
- `ax dojo outbox` -- list pending drafts (for review + the skill)

## Decision: restructure `ax dojo` into a command family

Effect's `effect/unstable/cli` does NOT support a parent run-handler alongside
subcommands (verified: every `withSubcommands` parent in this repo is
handler-less). To add `report`/`draft`/`outbox` as `ax dojo <sub>`, the
existing bare-leaf `ax dojo` (the agenda) must become an explicit subcommand:

- `ax dojo agenda [flags]` -- the current agenda command, verbatim behavior
- `ax dojo report [...]`, `ax dojo draft [...]`, `ax dojo outbox [...]` -- new

`ax dojo` itself becomes a handler-less parent (prints subcommand help).
dojo shipped in PR #390 minutes ago with zero users, so this rename is free now
and never again. SKILL.md + docs/cli.md + llms.txt + CLAUDE.md update to
`ax dojo agenda`. This is the only user-facing break; called out in the PR.

Runtime manifest becomes db-conditional:

```ts
dojo: {
  runtime: {
    kind: "db-conditional",
    fallback: "none",
    subcommands: { agenda: "db", report: "db", draft: "none", outbox: "none" },
  },
  hidden: false,
}
```

## `ax dojo report [--since=<iso>] [--json] [--notes-file=<path>]`

Derives the night's receipt from graph + filesystem, writes
`~/.ax/dojo/reports/<YYYY-MM-DD>.md` (local date), idempotent overwrite, and
echoes the same as JSON under `--json`.

Evidence gathered (all best-effort; a failed source contributes an empty
section, never aborts the report -- same `soft` discipline as the agenda):

| Section | Source | Query / read |
|---|---|---|
| Verdicts locked | graph `checkpoint` | `user_verdict != NONE AND observed_at >= since` (joined to experiment/proposal title) |
| Proposals created | graph `proposal` | `created_at >= since ORDER BY created_at` |
| Outbox drafts pending | filesystem | parse frontmatter of every `~/.ax/dojo/outbox/*.md` |
| Ending budget | quota module | `getQuota` snapshot -> binding window remaining (degrades to "unavailable") |
| Notes | `--notes-file` | optional agent narrative, appended under `## Notes` verbatim |

`--since` default: start of the current local day (a reasonable "this session"
proxy). The skill passes the real loop-start ISO. No `dojo_run` table (deferred
in the core spec) -- the report is a file, derived fresh each run.

Schema note: `experiment` has no `locked_at`; verdict-lock time is proxied by
the `checkpoint.observed_at` of the checkpoint carrying `user_verdict`.

Markdown shape (stable, receipt-style):

```
# Dojo report - 2026-06-13

window: <since> -> <generated_at>
ending budget: 12% spendable (7d window, 27% left) [quota]

## Verdicts locked (2)
- <verdict> · <proposal title> · experiment:<sig>

## Proposals created (1)
- [<form>] <title> (<dedupe_sig>)

## Outbox drafts pending review (1)
- <title> [<kind>] -> ~/.ax/dojo/outbox/<file>

## Notes
<verbatim --notes-file contents, if given>
```

Empty sections render `- (none)` so the report is always complete.

## `ax dojo draft --title=<s> --kind=bug|improvement [--body-file=<path>|-] [--session=<id>]`

Writes one staged upstream issue draft. Never publishes (publishing stays a
manual review step via the ax-repo skill / gh, per the core spec).

- Path: `~/.ax/dojo/outbox/<slug>-<shorthash>.md`, where `slug` =
  kebab of the title (new tiny `slugify` in `apps/axctl/src/dojo/slug.ts`,
  since the repo has none) truncated to ~50 chars, and `shorthash` = first 8
  hex of a stable hash of the title (collision guard; deterministic so the
  same title overwrites rather than duplicates). Hashing: reuse whatever the
  repo already uses for dedupe_sig-style short ids; if none reusable, a small
  FNV-1a in slug.ts (no crypto dep).
- Frontmatter: `title`, `kind`, `created_at` (ISO from injected nowMs),
  `session` (optional source ref). Body: `--body-file` path or `-` for stdin;
  empty body allowed (a stub the agent fills).
- Atomic write (tmp + rename), mirroring `improve/actions.ts` task writer.
- Prints the written path. `--json` prints `{ path, slug, title, kind }`.

## `ax dojo outbox [--json]`

Lists pending drafts: reads every `~/.ax/dojo/outbox/*.md`, parses frontmatter,
prints a table (`title`, `kind`, `created`, `file`) or JSON array. Read-only;
the morning review + the skill enumerate from here. Publishing/clearing is out
of scope (manual).

## Module shape

```
apps/axctl/src/dojo/
├── slug.ts            # slugify + shortHash (pure) + test
├── outbox.ts          # OutboxDraft type, writeDraft (FS), listDrafts (FS), parseFrontmatter (pure) + test
├── report.ts          # ReportData type, gatherReport (Effect: graph+fs+quota), renderReport (pure) + test
apps/axctl/src/improve/
├── report-queries.ts  # listVerdictsLockedSince, listProposalsCreatedSince (Effect, SurrealClient) + test
apps/axctl/src/cli/commands/
├── dojo.ts            # restructure: agendaCommand (was the leaf) + report/draft/outbox subcommands + handler-less root + db-conditional manifest
```

Pure cores (`slugify`, `shortHash`, `parseFrontmatter`, `renderReport`,
`renderOutboxTable`) are unit-tested in isolation; Effect glue
(`writeDraft`, `listDrafts`, `gatherReport`, the two queries) tested with the
BunFileSystem layer + the fake-SurrealClient harness from
`improve/show.test.ts`.

## Safety / scope

- Writers never publish anything outward (outbox is local; report is local).
- All three new subcommands are additive except the `agenda` rename.
- No new SurrealDB table; report derives from existing `checkpoint`/`proposal`.
- Idempotent: report overwrites today's file; draft overwrites same-title file.

## Out of scope (later)

- Publishing automation (`ax dojo outbox --publish`) -- stays manual per core spec.
- `dojo_run` history table + budget *diff* (start vs end) -- v1 shows ending budget only.
- Dashboard surface for reports.

## Open questions

- Should `report` also fold in filled-brief counts? Briefs are consumed
  (deleted) by their reconcilers, leaving no timestamped trace -- deferred
  unless a cheap signal exists.
