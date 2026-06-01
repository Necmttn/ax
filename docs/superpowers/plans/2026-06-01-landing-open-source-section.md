# Landing Open Source Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an open-source and local-first proof section to the landing page.

**Architecture:** Create one focused React component for the section, export it through the existing landing-v2 barrel, and render it between the lineage flow and footer cards. Add scoped `.landing-v2` CSS for desktop and mobile layout.

**Tech Stack:** React 19, TanStack Start route components, TypeScript, global CSS scoped by `.landing-v2`.

---

### Task 1: Add Section Component

**Files:**
- Create: `site/app/components/landing-v2/open-source-section.tsx`
- Modify: `site/app/components/landing-v2/index.tsx`

- [x] **Step 1: Create the component**

Create `site/app/components/landing-v2/open-source-section.tsx` with a terminal proof block, four trust cards, and action links.

- [x] **Step 2: Export the component**

Add `export { OpenSourceSection } from "./open-source-section";` to `site/app/components/landing-v2/index.tsx`.

### Task 2: Render Section

**Files:**
- Modify: `site/app/routes/index.tsx`

- [x] **Step 1: Import through the existing barrel**

Add `OpenSourceSection` to the existing `~/components/landing-v2` import.

- [x] **Step 2: Place the section**

Render `<OpenSourceSection />` after `<LineageFlow />` and before `<FooterCards />`.

### Task 3: Style Section

**Files:**
- Modify: `site/app/styles/globals.css`

- [x] **Step 1: Add scoped desktop styles**

Add `.landing-v2 section.open-source`, `.open-source-grid`, `.oss-terminal`, `.oss-proof-grid`, `.oss-proof-card`, and `.oss-actions` rules near the existing landing-v2 section styles.

- [x] **Step 2: Add mobile rules**

Extend existing `@media (max-width: 860px)` and `@media (max-width: 520px)` landing-v2 rules so the two-column layout collapses to one column and action links wrap cleanly.

### Task 4: Verify

**Files:**
- Inspect: `site/app/components/landing-v2/open-source-section.tsx`
- Inspect: `site/app/routes/index.tsx`
- Inspect: `site/app/styles/globals.css`

- [x] **Step 1: Search for expected strings**

Run: `rg -n "If it shapes your agent|Local SurrealDB|OpenSourceSection|open-source" site/app`

- [x] **Step 2: Typecheck**

Run: `bun run typecheck` from `site/`. Existing unrelated TypeScript failures may remain; record whether any new failure points to the new component.

- [x] **Step 3: Browser smoke if dependencies allow**

Run the site dev server and inspect the landing page if practical. Confirm the section appears between the lineage flow and footer cards.
