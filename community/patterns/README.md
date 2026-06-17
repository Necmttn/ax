# Community patterns

> **Status (post-review):** this is a **starter asset / docs checklist**, not a shipping
> subsystem. The community contribution loop is **deferred + BLOCKED on a security
> redesign** (spec §0.4); the `detector` refs are **illustrative**, pending the v2
> detector registry (spec §0.3). v1 reuses existing ax signals directly. See
> `docs/superpowers/specs/2026-06-17-directive-mining-design.md` §0.

Cold-start list of **agent directives** - generic "how to work" instructions, useful as
documentation and a setup checklist. (Low-tech by design; the value bet is the local
miner, not this file.)

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
