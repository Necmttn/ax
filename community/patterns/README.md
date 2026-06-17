# Community patterns

Cold-start library of **agent directives** - abstracted "how to work" instructions a
fresh ax install ships with, so users get value on day 1 before they've accumulated
their own history.

## Files

- `seed.json` - **curated** pack (hand-authored, versioned). Battle-tested directives
  across `verification / output / process / git / quality / communication`. Many are
  abstracted from real ax-user `feedback-*` memories. This is the floor; it has no
  privacy surface (outbound-curated only).
- `trending.json` - **compiled** board (generated nightly; do not hand-edit). Ranks
  community-contributed patterns by adoption. Empty until the contribution loop ships.

## Schema (per pattern)

| field | meaning |
|-------|---------|
| `id` | stable kebab identifier |
| `title` | short human label |
| `category` | `verification` \| `output` \| `process` \| `git` \| `quality` \| `communication` |
| `directive` | the instruction, generalized (no project names / paths / opinions) |
| `phrasings` | example user phrasings that signal this directive |
| `landing` | `memory` (passive recall) \| `guidance` (applied) \| `hook` (enforced gate) |
| `rationale` | why it matters |
| `source` | `curated` \| `community` |

## How it grows

The local **directive miner** (spec: `docs/superpowers/specs/2026-06-17-directive-mining-design.md`)
mines a user's own directives, abstracts them to pattern shape, and - **consent-gated,
never automatic** - contributes them. The nightly compile dedups + thresholds + ranks
contributions into `trending.json`, which feeds back as new seeds. Privacy model and
the full loop live in §7 of that spec.

`landing` escalates with recurrence: a directive a user keeps restating is not landing
as a passive note → it gets promoted toward an enforced `hook`.
