# Improve Impact Engine (PR5a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every proposal can answer "what is this worth": `GET /api/improve/:sig/impact` returns a backtested/estimated `ImpactEstimate`; next-action cards carry a cheap `impact_chip`.

**Spec:** docs/superpowers/specs/2026-06-12-improve-loop-v2-design.md (PR5a slice).

**Hard-won rules:** contract endpoint ⇒ ImproveGroup + CONTRACT_PATTERNS (param route) + capability + mock fixture + viaContract client; param handlers get DECODED params; raw rows ⇒ asJsonValue; TTL caches must not cache failures (use the invalidate-on-cause pattern or plain Map). No node:fs. New CLI? none this PR (no cli-reference change).

## Tasks

### 1. ImpactEstimate types (dashboard-types) - kind/headline/detail/basis/confidence + `NextActionCard.impact_chip?: string|null`.

### 2. impact.ts engine (TDD, mock-db)
`apps/axctl/src/improve/impact.ts`:
- `parseBaseline(p)` tolerant JSON parse.
- Estimators:
  - routing (form=hook && title is the stable routing title): `fetchDispatchCandidates({sinceDays: 30})` → `~$X/30d redirectable across N dispatches`, confidence "estimated", basis "recomputed from your last 30d of dispatch history".
  - hook with target_tool: deref-free SQL `SELECT count() FROM tool_call WHERE tool=$tool AND ts>$since GROUP ALL` + same w/ status="error" → "intersects M failures (of N calls) in 30d", confidence "indicative".
  - guidance: baseline {frequency, evidence} → correction_pressure headline `${frequency}× repeated correction pressure`, detail = evidence.
  - skill: baseline {tool, frequency} → `${frequency}× recurring friction${tool ? ` on ${tool}` : ""}`.
  - fallback: frequency kind from proposal.frequency.
- `estimateImpact(p: ProposalDto)` Effect + per-sig 10-min Map cache (failures not cached).

### 3. Endpoint
- ImproveGroup: GET `/api/improve/:sig/impact` params {sig: Schema.String}, success Schema.Unknown, errors NotFound/Internal.
- Handler (contract/improve.ts): find proposal via fetchImproveProposals() by sig → 404 or estimateImpact → asJsonValue.
- CONTRACT_PATTERNS += GET `/^\/api\/improve\/[^/]+\/impact$/` (BEFORE generic actions? actions pattern is POST-only - no clash). Routing test line.
- capability `improve-impact`; mock fixture; api client `improveImpact(sig)`.

### 4. Impact chips
- next-actions.ts: pure `impactChip(p)` - routing title → regex `est \$([\d,.]+)` from hypothesis → `~$X redirectable`; guidance/skill → `${frequency}× recurring`; else null. Set on proposal+verdict cards.
- Panel renders chip as bold accent span; improve.tsx table shows it next to title. Tests for chip extraction.

### 5. Gate + live smoke (curl impact for a real routing proposal - expect a $ headline) + PR.
