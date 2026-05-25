# ax brand

The brand is the product. Every contributor surface should feel like
the same hand drew it. This page is the contract.

## Wordmark

```
ax  AGENT EXPERIENCE
```

- **`ax`** - lowercase, Georgia serif, 32px in the dashboard masthead,
  matching size in the README hero. No uppercase. No abbreviation
  ("axctl" is the CLI; "ax" is the project).
- **`AGENT EXPERIENCE`** - uppercase, ui-monospace, 10px,
  letter-spacing 0.14em, baseline-aligned to the wordmark, muted.
- The two are separated by 10px horizontal gap on screen, a single
  space in markdown.

No logo, no glyph. The brand is the typography.

## Voice

| | |
|---|---|
| **Pronoun** | Second person ("your agent", "you"). Never first-person plural ("we"). |
| **Case** | Lowercase headings where they fit (e.g. `ax retro`, `ax doctor`). Sentence case prose. |
| **Tone** | Terse, evidence-first, no startup voice. State facts, then move on. |
| **Forbidden words** | "magical", "delight", "revolutionary", "powered by AI", "unlock". |
| **Hedge sparingly** | Say what's true. Mark what's roadmap with "tracked next". |

Examples:

> ✅ "ax answers these by reading what already happened."
> ❌ "ax magically uncovers hidden patterns in your agent history."

> ✅ "Skill triage - which of your installed skills get used, which never fire."
> ❌ "Get powerful insights into your skill usage."

## Palette

CSS custom properties locked in `src/dashboard/web/src/styles.css`:

| Variable | Value (light) | Role |
|---|---|---|
| `--ink` | near-black | Primary text, wordmark, borders |
| `--page` | paper | Background |
| `--panel` | soft off-white | Card / panel background |
| `--line` | light gray | Hairline borders |
| `--muted` | mid gray | Secondary text, tags, captions |
| `--green` | live signal | `LIVE` pulse, success states, primary accent |
| `--blue` | reference | Highlight rows, links, info |
| `--red` | failure | Errors, offline state |
| `--yellow` | review | Review-bucket triage |
| `--orange` | watch | Recommendations that need attention |

Rule of thumb: monochrome by default, color only when it carries
information.

## Typography

| Stack | Use |
|---|---|
| Georgia, serif | Wordmark, masthead h1 |
| ui-monospace, Menlo, monospace | Brand tag, data tables, code, panel meta |
| system-ui sans (default body) | Prose |

Numbers in tables are right-aligned, ui-monospace, no thousands
separator in CLI (`40389`), thousands separator in dashboard (`40,389`).

## Motifs

- **The live pulse** - green dot, 1.6s ease-in-out opacity loop. Use
  this once per surface to indicate freshness. Don't duplicate.
- **Hairline rules** - 1px lines separating sections. Never use shadows
  for hierarchy.
- **Code as evidence** - actual CLI output in README and docs. Real
  numbers, real timestamps, real session IDs. Scrub project names with
  the `acme-app` placeholder. Don't fake data.

## Naming pattern

User-facing commands and surfaces follow `ax <verb>`:

- `ax doctor` - system check
- `ax retro` - retrospective
- `ax wrapped` - annual recap
- `ax studio` (= the dashboard at `axctl serve`)
- `ax pilot` (= the agent skill)
- `ax score` (= the composite taste metric)

The CLI binary is `axctl` when the technical layer matters
(`axctl install`, `axctl daemon`). User stories say "run ax doctor",
not "run axctl doctor".

See [`docs/language.md`](language.md) for the full vocabulary.

## Don'ts

- No emoji in commit messages, code, or docs unless the user explicitly
  asks.
- No ALL-CAPS section headings except `AGENT EXPERIENCE` (the brand tag)
  and uppercase column headers in dashboard tables.
- No marketing taglines on individual commands. "ax doctor - checks
  your system" beats "ax doctor - your trusted AI health companion".
- No screenshots without scrubbed project names.
