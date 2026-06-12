# Wrapped Remake (PR4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrapped landing becomes a Paxel-style headline-card recap whose copy is agent-generated (`ax wrapped generate` brief → agent → `ax wrapped publish`), falling back to the mechanical view when no cards exist.

**Architecture:** New `wrapped_card` table (agent-authored copy; trivial read, no TTL cache so publish reflects instantly). The heavy mechanical profile stays cached (PR2); the contract wrapped handlers merge `cards` into the payload. Brief template shared by CLI + a contract GET endpoint. Card visual = CSS halftone art, headline-first typography.

**Spec:** PR4 section of `docs/superpowers/specs/2026-06-12-improve-first-dashboard-design.md`. Paxel reference: eyebrow question → big headline → 2-line body, orange dither.

**Hard-won rules:** new table ⇒ SCHEMA_TABLES (apps/axctl/src/queries/insights.ts:45); new endpoint ⇒ contract group + CONTRACT_ROUTES pair (web-handler.ts) + capability + mock fixture + viaContract client; `bun run db:schema` to apply DDL locally; sensitivity value space matches facts: `public | sensitive`.

---

### Task 1: `wrapped_card` table + types
- schema.surql: question/headline/body (string), sensitivity (string DEFAULT 'public'), position (int DEFAULT 0), generated_at (datetime DEFAULT time::now()). SCHEMA_TABLES entry. `bun run db:schema`.
- dashboard-types: `WrappedCardDto { question, headline, body, sensitivity, position }`; `WrappedProfile.cards?: ReadonlyArray<WrappedCardDto>`.
- Commit `feat(schema): wrapped_card table + dto`.

### Task 2: cards module (TDD)
- `apps/axctl/src/dashboard/wrapped-cards.ts`: `fetchWrappedCards()` (SELECT ordered by position, type::string coercion on nothing needed - no record ids cross JS), `buildPublishStatements(cards)` pure (DELETE all + CREATE per card), `runPublishCards(raw)` (Schema-validated stdin shape `{ cards: [{question, headline, body, sensitivity?}] }`, 1..24 cards), `sanitizeWrappedCards` (drop sensitive).
- Mock-DB tests: fetch ordering, publish statements snapshot, validation rejects empty/oversized, sensitive filter.
- Commit `feat(dashboard): wrapped cards fetch + publish core`.

### Task 3: serve merged profile
- contract/insights.ts: `wrapped` handler → `Effect.all([fetchWrappedCached(), fetchWrappedCards()])` → `{...profile, cards}`; `wrappedPublicPreview` → sanitize profile + sanitizeWrappedCards.
- Commit `feat(dashboard): serve agent cards on /api/wrapped`.

### Task 4: generate brief + CLI
- `apps/axctl/src/dashboard/wrapped-generate-brief.ts`: template - mine `curl /api/wrapped` mechanical numbers + `ax cost models` + `ax sessions churn` + `ax recall`; write 10-16 Paxel cards (eyebrow question, ≤6-word headline, ≤2-line body, personality not template-speak; mark sensitive ones); publish via `ax wrapped publish` JSON shape. Test asserts shape docs + publish command.
- CLI `commands/wrapped.ts`: `wrapped generate [--force]` (writes .ax/tasks/wrapped-generate-<date>.md via Bun.write - NO node:fs, gate!), `wrapped publish [--file]` (stdin JSON → runPublishCards). Register in cli/index.ts + runtime manifest "db".
- Commit `feat(cli): ax wrapped generate + publish`.

### Task 5: brief endpoint
- Contract InsightsGroup (or new wrapped slot): GET `/api/wrapped/generate-brief` → `{ brief }`; CONTRACT_ROUTES pair; capability `wrapped-generate`; mock fixture; api client `wrappedGenerateBrief()`; contract-routing test line.
- Commit `feat(dashboard): wrapped generate-brief endpoint`.

### Task 6: studio remake
- wrapped.tsx: cards.length > 0 → `<WrappedCardGrid>` (eyebrow/headline/body, CSS halftone art header w/ deterministic per-index variant, slight rotation jitter, dotted borders) + collapsible `<details>` "The numbers" wrapping MetricGrid/heatmap/facts; header gains CopyButton(generate brief) labeled "Regenerate wrapped". No cards → current mechanical view + CTA panel "Generate your wrapped" with the same CopyButton + one-line instructions.
- styles.css: `.wrapped-cards` grid, `.wrapped-card`, `.wrapped-card-art` (orange radial-gradient dot field), headline typography (clamp ~28px, tight leading).
- Public preview keeps working (sanitized cards render there when present).
- Commit `feat(studio): paxel-style wrapped card landing`.

### Task 7: gate + e2e + PR
- Full tests/typecheck/build/no-node-fs. Live: publish sample cards → /api/wrapped serves them → preview in vite → screenshot-level eyeball by user. Clean up sample cards or leave (user data - leave real ones only if user generated; sample = delete). PR; merge at CLEAN.
