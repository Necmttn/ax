# `--derive-only` spans the full `derive` tag

`axctl ingest --derive-only` historically selected a hand-curated set of seven
re-derivation stages (signals, outcomes, session-health, closure, proposals,
opportunities, retro-proposals) - the slow transcript and git parse skipped,
the cheap re-derives kept. The stage registry refactor turned stage selection
into a tag-based query (`registry.byTag("derive")`) so that the canonical list
lives next to the stages themselves rather than in a CLI-side enum.

We accept the widening that falls out: `--derive-only` now selects every stage
carrying the `derive` tag - currently signals, outcomes, session-health,
closure, proposals, opportunities, retro-proposals, subagents, spawned, and
harness (10 stages, in registry order). Tag membership is the contract;
adding `derive` to a new stage's `tags` is enough to opt it in.

Consequence: on a fresh DB, `subagents` and `spawned` no-op silently because
no transcripts have been ingested yet, and `harness` runs a doctor health
check that the legacy set did not. All `derive`-tagged stages are idempotent
and safe to run against empty inputs, so the widening is acceptable: the
trade is a slightly broader pass for a single source of truth on the
registry. Alternative considered and rejected: split `derive` into
`derive-evidence`, `derive-from-transcripts`, and `health` for finer CLI
selection. Registry-as-single-source-of-truth was deemed more valuable than
one extra tag's worth of semantic precision; users who want a narrower set
can pass `--stages=<a,b,c>` explicitly.
