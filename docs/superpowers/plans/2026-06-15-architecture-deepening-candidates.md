# Architecture Deepening Candidates — 2026-06-15

Union of two explore passes (skill + manual). Deduped to 8 distinct candidates
plus 1 ADR-conflicting deferral. Vocabulary: **Module / Interface /
Implementation / Depth / Seam / Adapter / Leverage / Locality** (LANGUAGE.md)
over the domain terms in `CONTEXT.md`.

Deletion test on each: imagine deleting the module — does complexity **vanish**
(pass-through) or **reappear across N callers** (earns keep)? We want
"reappears" — a real seam waiting to be cut. Ranked by depth-per-effort.

---

## A. Query Input Contract — only CLI obeys it  ⭐ lead

**Files**
- `apps/axctl/src/dashboard/contract/insights.ts:28-42`, `contract/sessions.ts:43-48`
- `apps/axctl/src/mcp/tools.ts:113-136,245-254`
- `apps/axctl/src/dashboard/recall.ts:40-51` (no `normalizeRecallParams` at all)
- Window-clamp `Math.max(1, Math.trunc(sinceDays))` copy-pasted 15× across
  `cost-analytics.ts`, `dispatch-analytics.ts`, `thinking-analytics.ts`,
  `hook-latency.ts`, `wrapped.ts`.

**Problem** — The **Query Input Contract** is *defined* as the one seam every
transport delegates to for arg semantics (defaults, clamping, default windows).
Real shape: only CLI calls the normalizers. HTTP handlers and MCP tools rebuild
the param struct inline with their own `?? 0` / `?? 50` / `?? 200` defaults.
Recall has no normalizer — three transports, three copies. Window-clamp lives
nowhere central, so it reappears 15×.

**Optimal solution** — Every query module exports its `normalize*Input`; HTTP +
MCP route through it instead of hand-building structs. Add the missing
`normalizeRecallParams`. Lift window-clamp + default-window into a shared
`normalizeWindow(days, { default, max })` the normalizers call — delete the 15
inline copies. Where transports legitimately differ (e.g. a divergent limit
default) keep it a parameter, never silently unified (per CONTEXT.md).

**Why deep** — Deletion test PASS: inline builders vanish, semantics concentrate
in one tested function per query. Three adapters (CLI/MCP/HTTP) = a real seam.
Leverage: add a param once, three transports inherit it. Locality: arg meaning
can't drift CLI-vs-MCP-vs-HTTP — that bug class disappears. HTTP defaults are
untested today; the normalizer test becomes the test surface for all three.
Completes the Query Input Contract; contradicts no ADR.

**Effort** M · **ROI** high · pairs with B (B consumes this seam).

---

## B. MCP tool registry — 16 hand-wired adapters duplicating the contract

**Files**
- `apps/axctl/src/mcp/tools.ts` (~650 lines, `AxMcpTool` interface `:86-91`, 16
  inline `run` closures, Zod `inputSchema` per tool)
- Re-declares shapes already in `packages/lib/src/shared/api-contract.ts`
  (Effect `HttpApi` query schemas).

**Problem** — Each MCP tool restates the same chain by hand: coerce args → call
normalizer (when it remembers to) → call `fetch*` → build next-links. The
**Insights Surface Contract** (ADR-0013, Effect `HttpApi` + Schema) already
declares every route's input/output once; MCP re-declares the same shapes in
Zod. Two sources of truth that drift silently.

**Optimal solution** — A typed MCP-tool *factory*: takes `{ queryModule,
inputContract, nextLinks }` and produces the tool. Derive the MCP input schema
from the same Effect Schema the HTTP contract uses (Schema → JSON Schema → MCP),
not a parallel Zod declaration. New read query = one declarative registration.

**Why deep** — Deletion test PASS: the 16 bespoke closures collapse into N
data-only registrations + 1 factory. Leverage: schema change happens in the
contract, MCP follows for free. Locality: tool wiring in one place. Tests:
factory tested once vs 16 closures testable only end-to-end. Consumes A's seam.

**Effort** M · **ROI** high · do after A.

---

## C. Parser Toolkit stopped halfway  (== skill-pass "provider parser skeleton")

**Files**
- `apps/axctl/src/ingest/normalized/toolkit.ts` (6 probes; header comment admits
  copy-paste origin)
- Still per-parser: `textFromContent` (`transcripts.ts:195`, `codex.ts:138`,
  `pi.ts:186`, `opencode.ts:224`), `messageKind` (5 variants), `outputText`
  (3 variants), `compaction.ts` extractors (4×).

**Problem** — The **Parser Toolkit** is the named shared layer the 5 provider
parsers compose (ADR-0012). It extracted the number/string probes then stopped
("behavioral-fidelity caution"). So content→text, message-kind classification,
output-text, and compaction extraction are each implemented ~5× with only a
type-predicate's worth of real variance.

**Optimal solution (two tiers)**
- *Shippable:* pull the remaining shapes behind the toolkit, parameterized by
  per-provider variance — `textFromContent(blocks, typePredicate)`,
  `messageKind(record, probes)`, etc. Providers keep only genuinely
  provider-specific bits (Codex `itemType`, SQLite columns).
- *Stretch:* a single stateful **transcript fold** — one walk (accumulate turns,
  match pending→realized tool calls, aggregate usage, extract compaction)
  parameterized by a per-provider field-probe table. Providers become field
  tables, not state machines.

**Why deep** — Deletion test PASS: shallow per-parser copies concentrate. Fix a
content-parsing bug once → 5 harnesses get it. Variance becomes an explicit
predicate arg instead of hidden across 5 copies. Parser tests shrink to "does it
pass the right predicate." ADR-0012 seam (`NormalizedTranscriptBatch`) untouched.

**Effort** M (shippable) / L (fold) · **ROI** high.

---

## D. OTLP signal flow — triplicated decode → normalize → write

**Files**
- `apps/axctl/src/otel/decode.ts` (3 fns)
- `apps/axctl/src/otel/normalize.ts:17-45,47-74,100-131` (3 fns, identical
  resource→scope→record loop)
- `apps/axctl/src/otel/writer.ts:30-86` (`metricStmt`/`spanStmt`/`logStmt`)
- `apps/axctl/src/dashboard/contract/otel.ts:55-73` (3 if-branches)

**Problem** — Three OTLP signal types (metrics/traces/logs) each get their own
decode + normalize + write + dispatch branch. The traversal shape (resource →
scope → record → extract → row) is identical; only field extraction + row type
vary. Three adapters at one seam = a real seam.

**Optimal solution** — One signal-agnostic OTLP traversal taking a per-signal
`{ extract: fields → row, land: row → statement }`. `handleOtlp` dispatches
through a signal table, not a 3-way `if`. Fail-open posture, `service.name` →
harness label, and attr-map access live once.

**Why deep** — Deletion test PASS: collapse one, its per-signal extraction moves
into a callback — the *traversal* triplication is removed. A 4th signal type
becomes one extractor. Traversal testable independent of signal specifics.

**Effort** M · **ROI** high.

---

## E. CLI table rendering — no column builder behind the render seam

**Files**
- `apps/axctl/src/cli/render.ts` (scalar helpers only: usd/integer/pct/truncate)
- 120+ hand-rolled `padEnd`/`padStart` across 13 commands: `ax-cost.ts:47-219`
  (same model→tokens→cost table built 3×), `ax-dispatches.ts:48-207`,
  `sessions.ts:65-96`, `costs.ts:63-92`, `ax-routing.ts`, `ax-thinking.ts`, …
- Contrast existing deep render modules: `cli/role-format.ts`,
  `skills-weighted-format.ts`, `session-show-format.ts`.

**Problem** — The render seam has scalar formatters but no *table* primitive, so
every command hand-pads columns with locally hardcoded widths. Rendering is
embedded in command Effects → untestable without running the whole command.

**Optimal solution** — A column-builder: `renderTable(rows, columnSpecs) →
lines`. Columns declare `{ header, get, align, width?, truncate? }`; the builder
owns width computation, truncation, terminal-width, empty-default. Migrate the
worst offenders (`ax-cost`, `ax-dispatches`) first.

**Why deep** — Deletion test PASS: 120 pad sites concentrate. Leverage:
consistent tables, one place for width/truncation policy. Locality: terminal
bugs in one tested function. Tests: pure-function table output (like existing
`renderUsage`/`renderDigestCli` tests) vs run-and-eyeball.

**Effort** M · **ROI** medium-high.

---

## F. Graph Access Toolkit — deep module, ~50 sites bypass it

**Files**
- Toolkit: `@ax/lib/shared/surreal.ts` (`stringField`/`countField`/
  `numberFieldOrNull`/`dateField`/`recordIdString`)
- Bypassed in `queries/cost-analytics.ts`, `hook-latency.ts`,
  `context-budget.ts`, `dispatch-analytics.ts`, `thinking-analytics.ts`,
  `dashboard/cost-query.ts`, `loc-query.ts`, `graph-explorer.ts`, + more.

**Problem** — A deep module for typed row-field access already exists, but ~50
parse sites hand-roll `String(r.x ?? "")` / `Number(r.x ?? 0)`. Not a missing
seam — an **under-adopted** one. Null-handling semantics drift per site.

**Optimal solution** — Mechanical sweep routing all row coercion through the
toolkit; add any missing helper (e.g. `numberField` default-0) so no site needs
raw coercion. Optionally a grep/lint gate to keep it adopted.

**Why deep** — Deletion test PASS: coercion logic reappears identically across
every bypassing caller; consolidating fixes a null/NaN rule once. Lowest-design,
highest-coverage. Consolidation, not redesign.

**Effort** S-M (mechanical) · **ROI** medium (locality-only, no new capability).

---

## G. Ingest stage registry — single source of truth split in two

**Files**
- `apps/axctl/src/ingest/stage/registry.ts:3-63` — per-stage import +
  `IngestStageKey` `Schema.Union` (28-item literal union) + `ALL_STAGES` runtime
  array, all hand-synced.

**Problem** — Adding an **Ingest Stage** touches 3 spots; the key-union and the
array must agree by hand. Two definitions of one truth → silent "stage doesn't
load / type narrowed wrong" bugs.

**Optimal solution** — One canonical stage list (array of stage objects, each
carrying its own key literal); derive `IngestStageKey` via
`Schema.Literal(...ALL_STAGES.map(s => s.key))`. Stage authors append one entry.

**Why deep** — Deletion test on the array: registry is dead, but the union
duplicates the same facts with no derivation. Locality: stage set defined once,
key type follows. Removes a bug class. Cheapest win on the board.

**Effort** S · **ROI** medium (cheap, clean).

---

## H. File-context hook — 5 concerns fused in one module

**Files**
- `apps/axctl/src/hooks/file-context-hook.ts` — path suppression (`49-86`),
  lookup-candidate generation (`147-158`), Claude payload adaptation
  (`167-184`), high-signal injection heuristic (`243-273`), all interleaved.

**Problem** — Deciding whether to inject a **File Memory** means bouncing through
suppression → path candidates → corrections/commits/co-touches → signal
heuristic. Each piece is a clean pure function but they're fused; the actual
taste (the injection heuristic) hides behind plumbing.

**Optimal solution** — Split into `suppressionPolicy` / `pathResolution` /
`claudeAdapter` / `signalEvaluation`; the hook composes them. Each becomes
independently unit-testable.

**Why deep** — Deletion test PASS *by splitting* (rare inversion): the concerns
genuinely separate rather than relocate. The injection heuristic stops hiding.
Test surface per concern shrinks.

**Effort** M · **ROI** medium.

---

## (deferred) Derive stages read upstream tables via scattered raw SQL  ⚠ ADR conflict

**Files** — `apps/axctl/src/ingest/derive-spawned.ts:12-21`,
`derive-signals.ts:40-108`, `derive-intents.ts:85-93`, `turn-analysis.ts`.

**Problem** — **Ingest Stages** declare deps but reach into upstream stages'
output via hand-written SQL against `tool_call` / `turn` / `skill`. Field names
are implicit in SQL scattered across N stage files; rename a column →
grep-and-pray. The **Graph Access Toolkit** gives safe *primitives* but not
typed *domain-table reads*.

**Optimal solution** — A typed read layer over the canonical evidence tables
(`tool_call`/`turn`/`skill`) stages consume, so the schema is referenced through
one interface, not re-spelled per stage. Stages become testable against a fake
read layer instead of a live DB.

**⚠ Contradicts ADR-0006** ("the DB is the inter-stage data contract"). Surface
*only if* schema-archaeology pain on column renames is real today. If
"raw-SQL-is-the-contract" still holds, this stays closed — don't re-litigate the
ADR for a hypothetical. **Decision deferred to user.**

**Effort** L · **ROI** conditional.

---

## Suggested sequencing

1. **A → B** — one arc. A completes the Query Input Contract seam; B's factory
   consumes it and deletes the 16-closure registry. Biggest compounding win.
2. **G** — cheap locality fix, land anytime (low risk, removes a bug class).
3. **D** — OTLP traversal unify; self-contained, no cross-deps.
4. **C** (shippable tier) — finish the Parser Toolkit; defer the fold rewrite.
5. **E** + **F** — two mechanical render/coercion sweeps; independent, low risk.
6. **H** — file-context split; isolated.
7. **(deferred)** raw-SQL read layer — only if ADR-0006 pain is felt.

Dropped as hygiene / deliberate-by-ADR: `delegation.ts` helper dup, compaction
builder, stage-runner Effect wraps, thin contract handlers, router strangler
seam (ADR-0013), serve daemon lifecycle (necessary complexity).
