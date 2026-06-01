# Landing Open Source Section Design

## Context

The live landing route renders `DashboardPreview`, `LineageFlow`, and `FooterCards`
inside `.landing-v2`. The page already frames ax as a local agent experience
layer. It now needs a proof section that answers whether users can inspect,
trust, fork, and operate the tool locally.

## User Goal

Add a section similar in spirit to the T3 Code open-source section: a centered
open-source claim, a terminal proof block, and compact cards for trust signals.
The section should communicate both open-source and local-first properties.

## Placement

Insert the section between `LineageFlow` and `FooterCards`. That puts the trust
message after the product explanation and before the final navigation links.

## Content

Use this structure:

- Eyebrow: `open source`
- Headline: `If it shapes your agent, you should be able to fork it.`
- Supporting copy: ax is MIT licensed, local-first, typed, and inspectable.
- Terminal panel with realistic setup commands:
  - `gh repo clone Necmttn/ax`
  - `bun install`
  - `axctl daemon start`
- Four proof cards:
  - `MIT` with commercial-friendly/license copy
  - `TypeScript` with strict/end-to-end typed copy
  - `Local SurrealDB` with local database copy
  - `No telemetry` with no upload/no SaaS copy
- Bottom actions linking to GitHub, repository fork view, and docs or
  contributing material.

## Visual Direction

Use the chosen “screenshot echo” layout without copying the source image:

- Centered eyebrow, headline, and paragraph.
- A two-column desktop composition: terminal panel on the left, four cards on
  the right.
- Warm `.landing-v2` palette, existing mono and serif font variables, existing
  border tokens, and 8-10px radii.
- Quiet hover states on action links and cards.
- Responsive collapse to a single column on mobile with no horizontal scroll.

## Implementation

Create a focused `OpenSourceSection` component under
`site/app/components/landing-v2/`, export it from the landing-v2 index, and render
it in `site/app/routes/index.tsx` after `LineageFlow`.

Add CSS scoped under `.landing-v2` in `site/app/styles/globals.css`. Keep all
selectors section-specific to avoid changing older landing sections.

## Validation

Verify that:

- The section renders between the lineage flow and footer cards.
- `https://github.com/Necmttn/ax` is used for GitHub actions.
- The layout collapses cleanly at existing mobile breakpoints.
- Existing unrelated TypeScript errors are not treated as introduced by this
  change.
