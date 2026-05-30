# Goal: Turn Section Aliases For Real Provider Transcripts

## Objective

Add a tested semantic alias layer on top of parsed turn content so ax can
identify real sections like objective, budget, continuation behavior,
environment context, skills instructions, tool output, plans, todos,
verification, and references across Codex, Claude, Pi, OpenCode, and Cursor
transcripts.

This is not a redesign of the low-level turn parser. Raw block kinds such as
`user_input_paragraph`, `assistant_text_heading`, `system_context`, and
`tool_result` remain factual parser output. The new layer derives stable,
provider-aware aliases from block text, XML tags, headings, and atoms so the
dashboard and graph queries can talk in user-facing concepts.

## Current Baseline

Already exists:

- Turn content parsing via `src/ingest/content-blocks/parse-turn.ts`.
- Persisted `content_document`, `content_block`, and `content_atom` rows.
- Structural block kinds for provider turns.
- Atom extraction for file references, symbols, errors, commands, URLs,
  citations, XML tags, and tool names.
- Dashboard session inspect reads parsed content and can render inline block
  highlights.
- Markdown artifact parsing has some semantic domain atoms, but provider turn
  parsing does not.

Observed real-sample reality:

- Labels such as `Budget:`, `Continuation behavior:`, `Completion audit:`,
  `Work from evidence:`, and `<objective>` appear in current local transcripts.
- XML-ish context sections such as `environment_context`, `skills_instructions`,
  `permissions`, `apps_instructions`, and `plugins_instructions` already appear
  as `xml_tag` atoms.
- These are currently stored as structural text blocks, not canonical semantic
  aliases.

Known gap:

- The UI prototype can show labels like `Budget`, but the graph does not yet
  store a reliable fact saying a block or range is the budget section.
- There is no alias table, confidence score, matched evidence, or provider
  applicability metadata for turn sections.
- There is no boundary-aware grouping that associates a heading like `Budget:`
  with the following list items.

## Target Capability

Given a session inspect view or a graph query, ax can answer:

- Which parts of this turn are user task, injected system context, objective,
  budget, skills manifest, environment context, tool output, plan, checklist,
  verification, or reference material?
- Which exact text range caused that classification?
- Which provider and parser version produced it?
- Which aliases are high confidence and which are heuristic guesses?
- Which aliases are common across providers, and which are provider-specific?
- Can the dashboard render a readable single-turn view using semantic colors
  without losing the raw text shape?

## Non-Goals

- Do not replace the existing parser with a general NLP classifier.
- Do not rely on LLM calls for v0 aliasing.
- Do not change raw `content_block.kind` values to semantic names.
- Do not require every provider to expose every alias.
- Do not block on symbol-AST analysis, BM25 search, or full reference graph
  expansion. Those are later phases that can consume the alias layer.

## Core Design

Add a deterministic classifier over parsed provider turn blocks.

Raw structural facts stay as they are:

```text
content_block.kind = user_input_list_item
content_block.text = "- Tokens remaining: unbounded"
```

The alias layer adds semantic facts:

```text
alias = budget
display = Budget
matched = "Tokens remaining"
confidence = 0.95
method = label-prefix
provider = codex
range = block start/end offsets
```

Preferred storage for v0:

- Add `section_alias` atoms to the relevant `content_block`.
- Store compact evidence in `content_atom.raw`.
- Optionally add block-level `labels.semantic_aliases` for fast dashboard reads
  if existing JSON label persistence makes that simpler.

Do not store aliases only in UI state. They should be queryable from the graph.

## Canonical Alias Set

Start with this intentionally small set:

| Alias | Meaning | Common evidence |
| --- | --- | --- |
| `objective` | User-provided target or task objective | `<objective>`, `Objective:`, `Goal:`, `Task:` |
| `budget` | Token/time/budget constraints | `Budget:`, `Token budget`, `Tokens used`, `Tokens remaining` |
| `continuation_behavior` | Instructions about continuing across turns | `Continuation behavior:`, `Continue working`, `persists across turns` |
| `completion_audit` | Instructions/checks before claiming done | `Completion audit:`, `Before deciding`, `verify`, `done criteria` |
| `progress_visibility` | Requirements for progress updates/plans | `Progress visibility:`, `update_plan`, `todo`, `status` |
| `work_from_evidence` | Requirements to inspect actual repo/data | `Work from evidence:`, `do not rely on prior context`, `inspect` |
| `environment_context` | Runtime cwd/shell/date/timezone context | `<environment_context>`, `<cwd>`, `<shell>`, `<current_date>` |
| `permissions` | Sandbox/approval/tool permission context | `<permissions>`, `<permissions_instructions>`, `sandbox_mode`, `approval policy` |
| `agent_guidance` | Repo or harness instruction files | `AGENTS.md`, `CLAUDE.md`, `<INSTRUCTIONS>` |
| `skills_manifest` | Available skills/tooling manifest | `<skills_instructions>`, `Available skills`, `Skill roots` |
| `apps_manifest` | Apps/connectors manifest | `<apps_instructions>`, `Apps (Connectors)` |
| `plugins_manifest` | Plugin manifest | `<plugins_instructions>`, `Available plugins` |
| `tool_call` | Assistant tool invocation/request | `tool_use`, tool name atom |
| `tool_output` | Tool result/output payload | `tool_result`, command output, diagnostics |
| `plan` | Assistant plan or implementation steps | `## Plan`, numbered implementation plan |
| `todo` | Checklist or task progress | Markdown checklist, `TodoWrite`, `update_plan` |
| `verification` | Tests/checks/smoke validation | `Tests:`, `Verification:`, `bun test`, `typecheck` |
| `reference` | URLs, citations, files, symbols, docs | existing `url_ref`, `citation_ref`, `file_ref`, `symbol_ref` atoms |

Each alias definition should include:

- canonical id
- display label
- provider applicability
- positive patterns
- negative/false-positive guards
- confidence
- whether it starts a section boundary
- whether following sibling blocks should inherit the alias

## Section Boundary Rules

The first implementation should support simple, explainable inheritance:

- If a heading/label block matches a boundary alias, following sibling blocks
  inherit that alias until the next heading/label boundary at the same parent.
- XML wrapper spans classify only the wrapped block unless the parser produces
  child blocks under that wrapper later.
- Reference aliases can coexist with another alias. For example, a budget
  section may still contain file refs or command refs.
- A block may have multiple aliases, but exactly one may be marked as the
  primary display alias.

Example:

```text
Budget:
- Tokens used: 0
- Token budget: none
- Tokens remaining: unbounded
```

Expected:

- `Budget:` gets primary alias `budget`.
- Each list item inherits `budget`.
- Evidence records whether the list item matched directly or inherited from the
  section header.

## Real-Life Validation Dataset

Use real local transcripts, not only handcrafted strings.

Minimum fixture groups:

- Codex goal/context wrapper turn containing `Continuation behavior`, `Budget`,
  and `<objective>`.
- Codex system/developer context containing permissions, apps, plugins, skills,
  and environment context.
- Claude assistant plan with headings, todos, tool use, and verification.
- Pi plain user task with file/symbol references but no system wrapper.
- OpenCode plain/structured assistant turn if sample data is available.
- Cursor chat/composer turn if sample data is available.

Fixtures should be small redacted excerpts committed under
`src/ingest/content-blocks/fixtures/`, not full private transcripts.

## Success Benchmarks

| Metric | Baseline | Target |
| --- | ---: | ---: |
| Canonical aliases implemented | 0 | >= 12 |
| Real provider fixture groups | 0 | >= 5 |
| Alias fixture pass rate | 0 | 100% |
| False-positive guard fixtures | 0 | >= 8 |
| Dashboard uses alias labels/colors | no | yes |
| Queryable alias facts in DB | no | yes |
| Real DB smoke finds expected aliases | ad hoc | documented commands pass |
| `bun run typecheck` | passing | passing |

Do not inflate the alias count by adding weak synonyms. Prefer fewer aliases
with strong evidence and clean UI behavior.

## Acceptance Criteria

Implementation is done when:

- A pure TypeScript alias classifier exists and is tested independently.
- `parseProviderTurn` emits alias metadata without changing existing raw block
  kinds.
- Persistence writes alias facts in a queryable form.
- Real fixture tests cover Codex, Claude, Pi, OpenCode, and Cursor where sample
  data exists.
- Dashboard session inspect can render semantic alias colors/labels in the
  existing turn view.
- The UI can explain a hovered alias with canonical label, matched text,
  confidence, and source rule.
- Existing tests for content blocks and session inspect still pass.
- A documented smoke query shows alias counts from local data.

## Benchmark Commands

Run after each implementation slice:

```sh
bun test src/ingest/content-blocks/parse-turn.test.ts
bun test src/ingest/content-blocks/fixtures.test.ts
bun test src/dashboard/web/src/routes/inspector-filters.test.ts src/dashboard/web/src/routes/sessions.test.ts
bun run typecheck
```

Run after persistence or schema/read changes:

```sh
bun src/cli/index.ts ingest --stages=codex,claude,pi,opencode,cursor --since=7 --progress=plain
```

Add a smoke query or CLI helper that can answer:

```text
count section_alias atoms by alias
show 20 recent aliases with provider, session, turn seq, block kind, confidence
show one inspected session with aliases attached to turn content
```

## Iteration Plan

### 1. Classifier Contract And Fixtures

Create `src/ingest/content-blocks/turn-section-aliases.ts`.

Acceptance:

- Exports a small alias definition table.
- Exports a pure function that accepts parsed blocks/atoms plus provider labels.
- Returns aliases with block seq, canonical id, matched text, confidence,
  method, and inherited/direct marker.
- Tests cover handcrafted Codex goal context and false-positive guards.

### 2. Real Sample Fixture Pass

Extract small real samples into fixtures.

Acceptance:

- At least Codex, Claude, and Pi fixtures are committed.
- OpenCode and Cursor fixtures are added if local samples expose useful text.
- Tests assert exact aliases for known sections and assert no alias for ordinary
  prose that merely mentions words like "budget" casually.

### 3. Parser Integration

Wire the classifier into `parseProviderTurn`.

Acceptance:

- Existing structural block output remains stable unless a test intentionally
  updates expected metadata.
- Alias facts appear as `section_alias` atoms and/or block labels.
- `classifierVersions` includes a turn-section alias classifier version.

### 4. Persistence And Query Smoke

Ensure aliases survive ingest and are queryable.

Acceptance:

- `content_atom.kind = "section_alias"` rows exist after ingest.
- Raw evidence includes matched rule, matched text, method, and inheritance.
- A documented SurrealQL query returns alias counts by provider and alias.

### 5. Dashboard Read Path

Update session inspect DTO/UI to use aliases.

Acceptance:

- Inline turn rendering uses semantic alias colors when present.
- The turn anatomy/minimap uses aliases instead of only raw block families.
- Hover detail explains why a region is classified.
- Missing aliases fall back to structural block kind.

### 6. Provider Parity Audit

Run against recent local data and record gaps.

Acceptance:

- Document which aliases appear per provider.
- Mark raw-signal-unavailable cases explicitly.
- Add follow-up issues/spec notes for provider-specific extractors only where
  the raw data actually contains missing signal.

## Scorecard Format

Update this section after each iteration.

```text
iteration:
date:
changes:
fixture groups:
aliases implemented:
false-positive guards:
focused tests:
typecheck:
db smoke:
ui smoke:
known gaps:
next iteration:
```

## Initial Scorecard

```text
iteration: 0
date: 2026-05-30
changes:
  - Goal spec created.
fixture groups:
  - none yet
aliases implemented:
  - none yet
false-positive guards:
  - none yet
focused tests:
  - not run for this spec-only change
typecheck:
  - not run for this spec-only change
db smoke:
  - previous ad hoc checks showed real Budget/Continuation/Completion labels in content blocks and XML tag atoms for provider context wrappers
ui smoke:
  - prototype exists at docs/prototypes/turn-detail-alternatives.html, but it currently uses mocked semantic labels
known gaps:
  - No canonical alias classifier.
  - No queryable section_alias atoms.
  - Dashboard semantic coloring is not yet backed by persisted aliases.
next iteration:
  - Implement the pure alias classifier and fixture tests before touching persistence or UI.
```

```text
iteration: 1
date: 2026-05-30
changes:
  - Added pure turn section alias classifier in src/ingest/content-blocks/turn-section-aliases.ts.
  - Added canonical alias definitions and direct/inherited match metadata.
  - Integrated alias classifier into parseProviderTurn without changing raw block kinds.
  - parseProviderTurn now emits queryable section_alias atoms and block semantic alias labels.
  - Added turn-content-block derivation coverage proving normal turn writes carry section_alias atoms.
fixture groups:
  - Synthetic real-shaped Codex goal context
  - Synthetic Codex injected system wrapper context
  - Synthetic Claude assistant plan/tool/verification turn
  - Synthetic Pi plain user prose false-positive guard
aliases implemented:
  - objective
  - budget
  - continuation_behavior
  - completion_audit
  - progress_visibility
  - work_from_evidence
  - environment_context
  - permissions
  - agent_guidance
  - skills_manifest
  - apps_manifest
  - plugins_manifest
  - tool_call
  - tool_output
  - plan
  - todo
  - verification
  - reference
false-positive guards:
  - Casual prose mentioning "budget" does not create a budget section alias.
focused tests:
  - bun test src/ingest/content-blocks/parse-turn.test.ts src/ingest/content-blocks/turn-section-aliases.test.ts src/ingest/content-blocks/fixtures.test.ts src/ingest/turn-content-blocks.test.ts src/ingest/content-blocks/persist.test.ts => 24 pass
typecheck:
  - bun run typecheck => exits 0; existing Effect advisory messages remain informational
db smoke:
  - bun src/cli/index.ts ingest --stages=turn-content-blocks --since=1 --progress=plain => exits 0
  - SELECT normalized, count() AS total FROM content_atom WHERE kind = "section_alias" GROUP BY normalized ORDER BY total DESC LIMIT 20 => returned real rows including reference, verification, plan, objective, budget, skills_manifest, environment_context, permissions, and continuation_behavior
ui smoke:
  - not run this iteration
known gaps:
  - Real redacted provider fixtures are not committed yet.
  - Dashboard still needs to consume section_alias atoms for semantic colors, minimap, and hover explanations.
next iteration:
  - Add small redacted real-provider fixtures and wire dashboard semantic rendering to section_alias atoms.
```

```text
iteration: 2
date: 2026-05-30
changes:
  - Updated the session inspect turn renderer to prefer section_alias atoms for inline colors, labels, and hover titles.
  - Added semantic alias chips in turn headers when parsed content includes aliases.
  - Added a compact alias minimap strip above parsed raw text for long-turn scanning.
  - Updated parsed structure drawer to display alias pills and section alias evidence details.
  - Kept structural block kind rendering as the fallback when no semantic alias exists.
  - Added redacted provider-shaped turn fixtures for Codex, Claude, Pi, OpenCode, and Cursor.
fixture groups:
  - Codex goal context fixture
  - Codex system context fixture
  - Claude assistant plan fixture
  - Pi plain task fixture
  - OpenCode assistant plan fixture
  - Cursor plain task false-positive fixture
aliases implemented:
  - unchanged from iteration 1
false-positive guards:
  - unchanged from iteration 1
focused tests:
  - bun test src/dashboard/web/src/routes/inspector-filters.test.ts src/dashboard/web/src/routes/sessions.test.ts => 18 pass
  - bun test src/ingest/content-blocks/parse-turn.test.ts src/ingest/content-blocks/turn-section-aliases.test.ts src/ingest/content-blocks/fixtures.test.ts src/ingest/turn-content-blocks.test.ts src/ingest/content-blocks/persist.test.ts => 30 pass
  - bun run dashboard:build => exits 0
typecheck:
  - bun run typecheck => exits 0; existing Effect advisory messages remain informational
db smoke:
  - Existing local section_alias counts remain queryable from content_atom.
ui smoke:
  - Existing API server on :1738 returned session inspect payloads containing section_alias atoms.
  - Runtime visual browser smoke not run in this iteration.
known gaps:
  - Dashboard semantic rendering is implemented, but still needs browser-level dogfood against a long real turn.
  - The minimap is intentionally compact; browser dogfood should decide whether it needs labels, grouping, or a side rail.
next iteration:
  - Run browser dogfood against session inspect to tune density/hover behavior and decide whether the richer minimap should ship now or later.
```

```text
iteration: 3
date: 2026-05-30
changes:
  - Ran browser-level dogfood against a real long session inspect page using Chrome DevTools Protocol.
  - Fixed mixed root/child block visibility so standalone system wrapper blocks keep their semantic aliases even when nearby user_input blocks have child segments.
  - Suppressed reference-only aliases from turn summary chips/minimap when richer section aliases exist in the same turn.
  - Toned down offset-mismatch debug styling from red boxes to a subtle dotted underline.
fixture groups:
  - unchanged from iteration 2
aliases implemented:
  - unchanged from iteration 1
false-positive guards:
  - unchanged from iteration 2
focused tests:
  - bun test src/dashboard/web/src/routes/inspector-filters.test.ts src/dashboard/web/src/routes/sessions.test.ts => 18 pass
  - bun test src/ingest/content-blocks/parse-turn.test.ts src/ingest/content-blocks/turn-section-aliases.test.ts src/ingest/content-blocks/fixtures.test.ts src/ingest/turn-content-blocks.test.ts src/ingest/content-blocks/persist.test.ts => 30 pass
  - bun run dashboard:build => exits 0
typecheck:
  - bun run typecheck => exits 0; existing Effect advisory messages remain informational
db smoke:
  - unchanged from iteration 1
ui smoke:
  - Chrome CDP rendered http://127.0.0.1:1739/sessions/019e7427-b6e7-7e01-9cd9-3a4806a565f7/inspect.
  - First semantic minimap exposes Permissions, Apps, Skills, and Plugins titles with method/confidence/matched evidence.
  - Screenshot evidence written to dogfood-output/turn-section-aliases/screenshots/cdp-session-inspect-visible-block-fix.png.
known gaps:
  - No blocking gaps for v0. Future polish can add a labeled side rail or grouped minimap if the compact strip proves too subtle.
next iteration:
  - Completion audit: verify acceptance criteria against current code/tests/DB/browser evidence and mark the goal complete if every item is proven.
```
