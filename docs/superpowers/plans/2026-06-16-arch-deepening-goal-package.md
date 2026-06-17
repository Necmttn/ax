# Arch-Deepening Goal Package — 2026-06-16

Overnight `/goal` runner. 9 candidates (A–I) distilled from a 45-agent scope+3-review+synth workflow. Each is a self-contained work-package. Trust the synthesis below — reviewers already corrected the original scopes; do NOT re-derive. Where a synth says "amend", the amendment is the spec, not the original scope.

Source: tasks/wcp02j6l8.output (latest, 45 agents). D synthesized here from its scope+3 reviews (synth:D crashed on a socket error).

---

## Execution protocol

- **One worktree + branch + PR per package.** Worktree under `/Users/necmttn/Projects/ax/.claude/worktrees/<branch>`, branch `arch/<id>-<slug>` (e.g. `arch/a1-recall-contract`). The global enforce-worktree hook BLOCKS edits/checkout on `main` in every repo (bypass only `ALLOW_MAIN_WRITE=1`, and only for docs like this file).
- **TDD, characterization-first.** Write the parity/unit/golden test FIRST, watch it fail, implement, green. For refactors of live code (C, D, E, F, H, I) pin current output on real fixtures BEFORE touching the source, then refactor to green.
- **Gate before PR:** `bun test` (repo-wide) AND `bun run typecheck`. Both. Test-green alone is a false signal where type-only imports exist (H: telemetry.ts; G: R-channel drift).
- **Pure-fn default.** Almost every package lands pure functions / data constants BELOW the Effect/Schema boundary. Do NOT wrap pure helpers in Effect (named explicitly per package).
- **Schema rules:** SurrealDB v3 SCHEMAFULL; new tables → SCHEMA_TABLES (insights.ts); datetime via JS Date.

### Sequencing

```
A1 ─→ B(zod-factory tier) ─→ G ─→ D ─→ C(shippable) ─→ ┬─ E ─┐
                                                        └─ F ─┘ ─→ H
```

- **Ordered backbone:** A1 → B → G → D → C → (E ∥ F) → H. Soft ordering — it front-loads the shared-seam wins and keeps risky refactors (D, H) after the cheap ones build confidence.
- **Independent / parallelizable overnight:** A2 (cost-window, sibling PR to A1), E and F (mechanical, no shared files — E=`cli/`, F=`packages/lib/shared/surreal.ts`+queries), I (touches `ingest/` but disjoint from G's stage-registry edit if G ships the de-scoped 2-file version). H is last because it is a judgment call on whether structural split is even wanted.
- **Spike gate:** B tier-1 (Effect-native MCP) is GATED on a one-tool interop spike (recall through Claude Code). If it fails, ship B tier-2 (zod z.infer factory) — also unblocks the rest. Do not block the backbone waiting on B tier-1; the zod tier is the safe floor.
- **I stays DEFERRED** unless schema-archaeology pain is confirmed; needs no ADR-0006 reopen (a code comment suffices). Ship only the surgical dedup if touched at all.

---

## A1 — Recall input contract   [confidence: high · effort: S]

**Verdict:** amend — split the original "Query Input Contract" candidate into A1 (recall, the genuine deepening) + A2 (cost-window, sibling). DROP the `packages/lib/package.json` edit and the 15-file SQL-clamp sweep (both flagged wrong by all 3 reviews).

**Deep module / seam:** pure helpers in `apps/axctl/src/dashboard/recall.ts`, mirroring the 5 existing `normalize*Input` modules (CONTEXT.md "Query Input Contract"):
```ts
export const RECALL_DEFAULT_OFFSET = 0;
export const RECALL_DEFAULT_LIMIT = 50;
export const isEmptyRecallQuery = (q: string): boolean        // q.trim().length === 0
export const normalizeRecallParams = (args: RecallQueryArgs): RecallParams
// RecallQueryArgs: { q?, project?, skill?, since?, offset?, limit?, sources?, scope? }
```
normalizeRecallParams: (a) echoes RAW `q` — no trim/lowercase (fetchRecall does that internally for matching); (b) passes `sources` through UNRESOLVED — fetchRecall + buildRecallNext already both call resolveRecallSources, pre-resolving double-applies; (c) fills offset/limit PRESENCE defaults only, NO clamp (fetchRecall owns clampPagination, RECALL_PAGINATION max 200); (d) passes project/skill/since/scope through.

**Files:** changed — `dashboard/recall.ts` (add helpers), `dashboard/contract/insights.ts:28-42` (recall handler), `mcp/tools.ts:124` (recallTool.run), `cli/commands/recall.ts` (cmdRecall), `queries/query-input-contract.test.ts` (tests). DROP: `packages/lib/package.json` (the `./*` wildcard already resolves new shared subpaths — pagination.ts is consumed unregistered).

**Hard constraints:**
- normalizeRecallParams MUST echo RAW q — fetchRecall returns `q: params.q` and emptyRecallResponse(params.q,...). Trimming/lowercasing in the normalizer = silent response-shape regression (`risk: recall.ts fetchRecall returns q.trim().toLowerCase() internally only for matching`).
- Keep BOTH empty-q guards — HTTP handler short-circuits to a no-DB canned page AND fetchRecall guards internally (recall.ts:99). Centralize the PREDICATE via isEmptyRecallQuery; do NOT collapse the two guards.
- NO second pagination clamp — fetchRecall:92 already calls clampPagination. normalizeRecallParams fills presence defaults only; a second clamp with different config can disagree.
- Do NOT pre-resolve sources (fetchRecall + buildRecallNext both resolve already).
- MCP currently echoes a TRIMMED q (tools.ts:114). Routing it through normalizeRecallParams makes it echo RAW q — this is a DELIBERATE, documented behavior change, not a mechanical refactor.

**Effect/idiom shape:** pure functions, no Effect wrapping, below the HttpApi Schema decode boundary. The exported constant is the single source of truth that Flag.withDefault / MCP / Schema each REFERENCE — never push the default into the HTTP-only Schema via Schema.optionalWith (re-forks the default for one transport). Prior art (effect reviewer): tRPC `.input` (one validator, all transports), OTel Collector `createDefaultConfig` → `Unmarshal` → `Validate` (defaults in constructor, decode vs validate distinct), Effect's own `effect/unstable/httpapi` (one HttpApi value shared server+client). ax can't fully unify (CLI/MCP/HTTP are genuinely different parsers) so the pure normalizer below decode is the pragmatic single source.

**Test surface / verify gate:** land in existing `query-input-contract.test.ts`. The high-value test is a PER-RULE parity test (NOT "identical RecallParams" — impossible: HTTP carries no sources/scope, MCP no scope): given the same logical inputs the SHARED fields agree — raw-q echo, source-resolution rule, offset/limit presence defaults, scope passthrough. Document HTTP-no-sources/scope and MCP-no-scope as genuine surface differences, not drift. Pure unit tests: normalizeRecallParams (raw-q preservation, presence defaults, no second clamp, scope passthrough), isEmptyRecallQuery. `bun test` + `bun run typecheck`.

**Open questions:**
- Accept the MCP raw-q echo change (loses today's trimmed echo) as the documented contract invariant, or special-case MCP to keep trimming? (Recommend: accept + document.)
- Should MCP gain sources/scope and HTTP gain sources via their Schemas to fully unify, or keep v0 surface differences? (Recommend: keep v0; the per-rule test documents them as intentional.)

---

## A2 — Cost-window default   [confidence: high · effort: S]   (sibling PR to A1, independent)

**Verdict:** amend — small separate concern; ship as A1 sibling or follow-up. REUSE pagination's clamp (generalize), do NOT spawn a parallel `window.ts` module (the original scope's `packages/lib/src/shared/window.ts` is dropped).

**Deep module / seam:**
```ts
// generalize the existing primitive in packages/lib/src/shared/pagination.ts:
export const clampInt = (value, { default, min, max }): number    // clampLimit minus the optional-max
// cost-analytics.ts:
export const COST_DEFAULT_WINDOW_DAYS = 14;
```
Keep a DISTINCT `sqlWindowDays` SQL-boundary floor — `Math.max(1, Math.trunc(n))` is a SQL-interpolation security boundary, never delete it. Apply ONLY to the 3 true day-window SQL builders in cost-analytics.ts (lines 51 / 101 / 190).

**Files:** changed — `packages/lib/src/shared/pagination.ts` (add clampInt + test), `queries/cost-analytics.ts` (export const + sqlWindowDays at 51/101/190), `cli/commands/ax-cost.ts` (Flag.withDefault(COST_DEFAULT_WINDOW_DAYS)), MCP cost_models / cost_split / dispatches handlers. Do NOT touch dispatch/thinking/hook-latency/hooks/context-budget/feedback-cases — their clamps are LIMIT/tail/windowMinutes, NOT day windows (cost-analytics.ts:120 is a LIMIT clamp, not a window).

**Hard constraints:**
- 14 is duplicated 5×: CLI 3× `Flag.withDefault(14)` + MCP 2× `typeof args.days==='number'?args.days:14`. The exported constant is the single source; each transport references it.
- Keep sqlWindowDays as a separate injection-boundary guard; do NOT fold the SQL clamp into the transport default call.
- The 15-file Math.max(1,Math.trunc) sweep from the original scope is DROPPED — it conflates day-windows with unrelated clamps.

**Effect/idiom shape:** pure; prior art (effect reviewer): oclif/@effect/cli `Flag.withDefault` is exactly where the drift originates; reconcile onto a shared constant. Drizzle/Prisma centralize limit/offset in one builder layer — clampPagination is already that; extending it with clampInt continues established consolidation.

**Test surface:** clampInt unit (default/min/max/non-finite/fractional truncation) in pagination test. `bun test` + `bun run typecheck`.

**Open questions:**
- Constant alone vs constant + clampInt helper, when only 3 cost transports consume the default today? (Recommend: constant + reuse clampInt; skip a new module.)
- hooks.ts:59 and feedback-cases.ts:105 use bare Math.trunc with no floor (negative sinceDays → broken SQL interval). Fix via sqlWindowDays in a SEPARATE change with its own test — explicitly OUT of scope here.

---

## B — MCP tool registry factory   [confidence: med · effort: M (1–1.5d)]

**Verdict:** spike-first. REJECT the original premise (16 adapters "duplicate the HttpApi contract", "two sources of truth drift") — verified FALSE: zod inputSchemas in tools.ts are the SOLE source for MCP inputs, do not mirror api-contract.ts, and 5+ tools have no endpoint. REJECT the bespoke `defineAxMcpTool`-over-low-level-SDK-`Server` mechanism (all 3 reviews reject it as reinventing tested framework code + a robustness downgrade). Two tiers below; ship tier 1 if the spike holds, else tier 2.

**Real (reframed) win:** collapse ~16 hand-wired descriptors; one Effect Schema (or zod object) per tool as the single input source; make the advertised JSON Schema testable; delete manual arg-coercion the SDK already makes redundant; kill the per-call Effect.provide smell, scattered rt.runPromise boundary, the TS2589 register cast (server.ts:54-63), and manual lifecycle. DO NOT wire api-contract.ts into this.

**Tier 1 (PRIMARY — gated on spike): Effect-native MCP** via effect/unstable/ai (confirmed in effect@4.0.0-beta.78, dist/unstable/ai: `McpServer.layerStdio`/`toolkit` at McpServer.d.ts:246/289, `Tool.make` with `parameters: Schema.Struct` + getJsonSchema, McpSchema):
```ts
Tool.make(name, { description, parameters: <per-tool Schema.Struct>, success: Schema.Unknown })
Toolkit.make(...).toLayer(handlers)   // handlers stay in Effect-land: (params, ctx) => Effect.Effect<R, E, AppServices>
McpServer.toolkit(tk) + McpServer.layerStdio({ name: "ax", version })   // + NodeStdio + Logger.LogToStderr, NodeRuntime.runMain
```
Replaces buildServer/serveMcp's ManagedRuntime + SIGINT/dispose dance, the @modelcontextprotocol/sdk dep, zod, and the TS2589 cast. JSON Schema derives from the Schema for free; arg decode + structured decode-error envelope become framework responsibility.

**THE SPIKE (decisive gate):** stand up ONE tool (recall) end-to-end through McpServer.layerStdio, connect Claude Code as a real MCP client, confirm tools/list + tools/call parity INCLUDING the isError/error envelope, and confirm stdout-is-sacred (all logs to stderr, zero non-JSON-RPC stdout frames). Hold → 16 conversions are mechanical (~4-6 lines each), delete zod + SDK + lifecycle/cast cruft. Fail → tier 2.

**Tier 2 (FALLBACK — codex's minimal path on the existing SDK):** keep `McpServer.registerTool` + zod; author each input as a concrete `z.object`; type `run` via `z.infer` (sidesteps TS2589); DELETE the now-redundant manual coercion (SDK mcp.js L172-180 already returns parsed typed args via safeParseAsync); move the lone bespoke check (sessions_around date parse, tools.ts:158-160) into a zod `.refine` for a free uniform error. Under NEITHER branch hand-roll the low-level @modelcontextprotocol/sdk Server.

**KEEP VERBATIM (scope got these right, both tiers):** NEW per-tool input schemas co-located with each query module (NOT derived from api-contract.ts); reuse existing `normalize*`/`buildXNext` inside each handler unchanged; `Schema.optionalKey` (NOT `Schema.optional`) so decoded args OMIT absent keys for the `...(x!==undefined?{x}:{})` callers; `success: Schema.Unknown` to preserve `{...result, next}` passthrough; branching tools (signal_show, dispatches --candidates, dojo_agenda) keep control flow inside the handler; provide AppLayer + QuotaEnvLive ONCE into the handlers layer.

**Files:** `mcp/tools.ts`, `mcp/server.ts` (delete TS2589 cast at L54-63), `mcp/tools.test.ts`, `mcp/server.smoke.test.ts`; new per-tool input schemas (co-located OR one `mcp/tool-inputs.ts` barrel). Tier-2-only: keep zod. Do NOT touch package.json catalog (zod used elsewhere repo-wide).

**Hard constraints:**
- Decoded params MUST omit absent Schema.optionalKey fields (not pass undefined) — confirm in spike, else normalize spread-callers break.
- Fail-open / error envelope (isError text) must reach parity with today's wrapping.
- The drift/HttpApi rationale is FALSE — do not let it pull api-contract.ts into scope.

**Effect/idiom shape:** prior art (effect reviewer): `effect/unstable/ai/Tool.ts` + Toolkit + McpServer is the native stack; the repo already depends on `effect/unstable/httpapi` (api-contract.ts) so beta-surface precedent exists.

**Test surface:** rewrite the two MCP test files from zod-shape assertions to jsonSchema assertions; new pure factory/tool test. `bun test` + `bun run typecheck`.

**Open questions:**
- Does Effect's native McpServer stdio transport (RpcServer/NDJSON-RPC + McpSchema) interop cleanly with Claude Code — tools/list, tools/call, isError envelope at parity? (The single gate.)
- Is effect/unstable/ai (beta-78) stable enough for a shipped CLI surface? Pin the version.
- If tier 2: accept zod at the MCP edge + Effect Schema at the HttpApi edge as a deliberate documented boundary (not a consistency regression)?

---

## C — Parser Toolkit finish (shippable tier)   [confidence: high · effort: S (~½d)]

**Verdict:** amend — ship the 2 genuinely deep cuts, DROP the shallow one (outputText), do NOT create `content-text.ts`. Reject the messageKind mega-config and the stateful-fold stretch.

**Deep module / seam:**
1. Add to EXISTING `apps/axctl/src/ingest/normalized/toolkit.ts` (ADR-0012 JSON-access layer, sibling to stringField/jsonText/parseJsonl):
```ts
export function textFromContent(input: unknown, opts: { acceptedTypes: ReadonlySet<string>; emptyStringIsNull?: boolean }): string | null
export const CLAUDE_TEXT_TYPES = new Set(['text'])
export const RESPONSES_TEXT_TYPES = new Set(['text','input_text','output_text'])
```
Collapses 3 copies: transcripts.ts:194, codex.ts:138 (textFromCodexContent), pi.ts:186 (textFromPiContent). Body reuses isRecord/stringField: string passthrough (null when emptyStringIsNull && empty, else input); Array→filter(isRecord)→filter(type∈acceptedTypes)→map(stringField 'text')→filter(nonEmpty)→join('\n')→null when empty; else null. Wire: claude `{CLAUDE_TEXT_TYPES, emptyStringIsNull:false}`, codex `{RESPONSES_TEXT_TYPES, false}`, pi `{RESPONSES_TEXT_TYPES, true}`.
2. NEW `apps/axctl/src/ingest/normalized/message-kind.ts`:
```ts
export function classifyUserText(excerpt: string|null, rules: UserTextRules): "control"|"context"|"task"
export interface UserTextRules { control: readonly string[]; contextStartsWith: readonly string[]; contextIncludes: readonly string[] }
export const FULL_CONTEXT_RULES   // claude≡codex, proven byte-identical (transcripts.ts 213-227 ≡ codex.ts 156-169)
export const PI_CONTEXT_RULES     // 4-prefix subset
```
classifyUserText: startsWith any control → 'control'; startsWith any contextStartsWith OR includes any contextIncludes → 'context'; else 'task'. FULL_CONTEXT_RULES.contextStartsWith = `['# AGENTS.md instructions','# CLAUDE.md','<local-command-caveat>','Base directory for this skill:','Base directory for this plugin:']`; contextIncludes = `['<environment_context>','<INSTRUCTIONS>']`; control = `['<command-name>']`. Each parser keeps its own role-dispatch branch; only the user branch calls classifyUserText.
3. DROP outputText extraction entirely.

**Files:** changed — `ingest/normalized/toolkit.ts`, `ingest/transcripts.ts`, `ingest/codex.ts`, `ingest/pi.ts`; new `ingest/normalized/message-kind.ts`. Tests: `toolkit.test.ts`, `message-kind.test.ts`. NOT changed: `opencode.ts` (text extraction is per-part `textFromPartData` at opencode.ts:228 with an external join — different signature, does not fit textFromContent), `compaction.ts` (already at target: makeCompactionWrite spine + thin interpreters), `cursor.ts`.

**Hard constraints:**
- Behavior-drift is the whole danger — toolkit header says "never merge and hope". pi's empty-string→null and claude's per-type filtering MUST be preserved bit-for-bit. Characterization tests on real fixtures FIRST, then refactor to green.
- outputText DROPPED because the 3 copies diverge on an uncaptured null axis: `jsonText(null)`→literal string `'null'` for claude/codex (transcripts.ts:258, codex.ts:128) vs opencode short-circuiting to null (opencode.ts:255). A merged helper would silently flip codex/claude null output from `'null'` to `null`.
- Do NOT fold messageKind's role dispatch — genuinely divergent (claude=tool_result-from-blocks; codex=itemType function_call→tool_call which is NOT tool_result; pi/opencode/cursor=role-string; claude does NOT special-case system/developer while the other 4 do). A 5-field config would be shallower than the current functions.

**Effect/idiom shape:** pure functions, NO Effect Service/Schema — idiomatic precisely because it stays out of Effect (unknown→string|null transforms on the per-event ingest hot path; presets/rules are exported data constants = "config is data"; no Schema-decode of block arrays = no ParseError/allocation per event). Prior art (effect reviewer): unified `hast-util-to-text` / `mdast-util-to-string` (extract text from heterogeneous node tree via an options bag of contributing types — `textFromContent` IS this); Drizzle dialect objects (per-backend variance as a passed-in value, not a forked builder). Babel/ESLint visitor-key registries = what the STRETCH goal is unknowingly chasing → cite as the reason NOT to attempt the stretch without an AST framework.

**Test surface:** characterization fixtures (real transcripts) pinning all 6 functions FIRST; then table-driven unit specs — textFromContent (accepted-types matrix × string passthrough × empty→null(pi) × unknown-block drop), classifyUserText (one parametric table proving claude≡codex share FULL_CONTEXT_RULES, pi uses subset). `bun test` + `bun run typecheck`.

**Open questions:**
- Is pi's narrower context table intentional or stale drift? Pi (pi.ts:214-219) omits 3 prefixes claude+codex carry. If drift, collapse to ONE shared CONTEXT_RULES + delete PI_CONTEXT_RULES (deeper + latent bugfix) — but then pi's characterization test needs a deliberate documented expectation change. NEEDS a domain-owner decision; do not silently pick.
- Skip unifying cursorMessageKind (cursor.ts:135) + opencode messageKind? (Recommend: skip — two ~5-line classifiers with divergent fallthroughs, shallow churn.)

---

## D — OTLP signal-flow unify   [confidence: med · effort: S-M (~½–1d)]   (synthesized here)

**Verdict:** amend — 2 of 3 reviews amend toward THINNER extraction; effect endorses the registry with 2 adjustments. Converged spec: extract only the genuinely deep shared seams + a thin dispatch table to kill the 3-way `if`; keep per-signal normalizers/leaves (do NOT build a universal leaf walker); keep flat greppable SQL (do not let a Column DSL become an untested footgun). The triplicated decode→normalize→render→write IS real (3 near-identical resource→scope→leaf loops in normalize.ts, 3 stmt builders in writer.ts differing only in column lists, a 3-way if in dashboard/contract/otel.ts).

**Deep module / seam (the deep seams only):**
```ts
// otel/signal.ts
const harnessFromResource = (resource) => ({ res: AttrMap; harness: string })   // attrMap + harnessOf, repeated 3x
const resourceContext / walkResources                                           // abstracts resource+scope+harness ONLY
const decode = <P>(spec) => (json) => Effect.Effect<P, OtelDecodeError>          // typed error — fail-open NOT here
const renderUpsert / writeRows = (rows, stmt) => rows.length ? executeStatements(rows.map(stmt)) : Effect.void
// otel/signals.ts — registry to dispatch through (kills the 3-way if):
const SIGNALS: Record<Signal, OtelSignalSpec<any,any,any>> = { metrics, traces, logs }
const defineSignal = <P,Rec,Row>(s) => s                                        // identity helper, keeps each spec typed at def site
```
handleOtlp collapses to: `const spec = SIGNALS[signal]; const payload = yield* decode(spec)(json).pipe(Effect.orElseSucceed(() => null)); if (payload) yield* landRows(spec)(normalize(spec)(payload))`. Keep per-signal `leaves`/normalizers (metrics owns its `metric→sum/gauge.dataPoints` 1→N fan-out + metric-level name/unit closure — traces/logs have no such level).

**Files:** changed — `otel/decode.ts`, `otel/normalize.ts`, `otel/writer.ts`, `dashboard/contract/otel.ts`, + the 3 test files; new `otel/signal.ts`, `otel/signals.ts`, `otel/signal.test.ts`. `rows.ts`/`otlp-schema.ts` UNCHANGED. Keep writer named exports (writeMetrics/writeSpans/writeLogs, normalizeMetrics/Trace/Logs) as thin delegations → zero test churn.

**Hard constraints:**
- **Fail-open is byte-sensitive (highest blast radius — exporter retry-storm).** decode must return `Effect<Payload, OtelDecodeError>` (typed channel via the existing Schema.TaggedErrorClass); apply `orElseSucceed(null)` at the handleOtlp dispatch SEAM, NOT inside decode (effect ADJUSTMENT 1). Three distinct scopes must stay byte-identical: schema-error→OtelDecodeError (decode.ts:11/16/21), JSON-parse failure swallowed before writer lookup (otel.ts:45/53), decode-failure branch (otel.ts:58/61/66), raw HTTP wrapper swallow (otel.ts:87/90).
- **Unguarded gzip:** gzip decode happens OUTSIDE the parse try (otel.ts:43). Add an explicit malformed-gzip test before claiming fail-open is centralized.
- **Log record-id index:** logEventKey includes `index` (rows.ts:64) supplied by `writeLogs(rows.map((r,i)=>...))` at writer.ts:84 AFTER normalizeLogs drops non-allowlisted records (normalize.ts:100/110). The generic must compute `key(row,i)` at RENDER time over the post-allowlist-filter emitted array, NEVER at normalize/leaf-iteration time, or it produces colliding record ids. metricPointKey/spanKey ignore index.
- **Per-column NONE vs raw is load-bearing:** metrics `value` (writer.ts:35) and span `duration_ms` (writer.ts:57) render RAW numbers; log token/cost columns render `NONE` for null via local optNum (writer.ts:28/69). A wrong helper writes literal `'null'` or `0`. `attrs` is already a JSON-encoded option<string> (normalize.ts:37/67/124; schema.surql:1913/1927/1943) — do NOT re-encode it as an object.
- **Possible pre-existing key bug — verify, don't freeze:** metricPointKey omits agent_name though persisted (normalize.ts:36, rows.ts:36, writer.ts:40); spanKey uses only span_id while rows carry trace_id too (rows.ts:21/40). Confirm uniqueness BEFORE abstracting.
- Keep `OtelWriter` as a `Context.Service` with OtelWriterLive (preserves `Effect<void, DbError, SurrealClient>` + the stub-DB test layer). Do NOT make OtelSignalSpec itself a Schema (it's a record of functions).

**Effect/idiom shape:** registry `Record<Signal, spec>` + `defineSignal<P,Rec,Row>` identity helper (any-erasure at the dispatch seam is acceptable — handleOtlp only needs json→Effect<void>). Prior art (effect reviewer): OpenTelemetry Collector pdata (shared pcommon Resource/Scope/attr Map + per-signal leaf record, deliberately NO universal leaf walker), opentelemetry-js (shared OTLPExporterBase + per-signal Serializer registry), Drizzle (columns derived from one schema definition — argues for deriving SET-clause from the Row Schema AST + a NONE-vs-raw storage annotation), tRPC (heterogeneous registry typed at def site, any at the router boundary). ADJUSTMENT 2: the Column DSL duplicates the field set already in the Row `Schema.Struct` — either derive the SET-clause from the Row Schema AST + a per-field storage-policy annotation, OR (if too heavy for a ½d change) make `columns ⊇ schema fields` a HARD CI gate (not optional). walkResources abstracts resource+scope+harness ONLY.

**Test surface:** characterization/SQL-text tests FIRST (the named traps): malformed-gzip path; log-key stability after allowlist filtering; every writer column's literal SQL output (raw vs NONE); metric/span record-key uniqueness. Then DB-free unit targets: Column/render helpers in isolation, walkResources/normalize against a synthetic 1-field spec, a meta-test over SIGNALS asserting each spec's column name-set ⊇ its Row schema fields. Keep rows.test.ts (keys) + writer.test.ts SQL-text assertions as the regression guard. `bun test` + `bun run typecheck`.

**Open questions:**
- Derive SET-clause from Row Schema AST + storage annotation now, or ship the Column DSL behind a hard `columns⊇schema` CI gate this round? (Effect reviewer accepts either; AST-derivation is the strategic end-state.)
- The metricPointKey/spanKey uniqueness gap (agent_name / trace_id omitted) — fix as part of this PR or file separately? Do NOT silently freeze it into the registry.

---

## E — CLI table column-builder   [confidence: high · effort: M (~½–1d)]   (parallel with F)

**Verdict:** amend (ship as-corrected) — lowest-risk candidate. Footers/rules become FIRST-CLASS members of renderTable, NOT a separate public `layoutColumns` escape hatch (the original two-API split re-introduces the positional padEnd/padStart assembly the builder exists to delete and lets a TOTAL row silently desync — the single biggest defect both adversarial reviews flagged).

**Deep module / seam:** new pure `apps/axctl/src/cli/table.ts` (sibling to role-format.ts):
```ts
type Align = 'left' | 'right';   // padEnd | padStart
interface Column<T> { header: string; get: (row: T, i: number) => string; align?: Align; width?: number; min?: number; max?: number; overflow?: 'clip'|'ellipsis'; }
type FooterLine = { kind: 'cells'; cells: ReadonlyArray<string|null> } | { kind: 'rule'; cols?: ReadonlyArray<number> };
interface TableOptions { gap?: string; header?: boolean; footer?: ReadonlyArray<FooterLine>; maxWidth?: number; }
function renderTable<T>(rows: readonly T[], columns: readonly Column<T>[], opts?: TableOptions): string[];
```
Column.get returns RAW cell text and owns null-fallbacks (`?? '?'` / `''`) and synthesized prefixes (the `'!'`+child_model in ax-dispatches); the builder owns 100% of width/truncation (no truncate()/slice() in get). Footer cells inherit each column's RESOLVED width+align (null=blank) so a TOTAL row cannot desync. Width resolution stays a private helper.

**Files:** changed — `cli/commands/ax-cost.ts` (3 subcmds + TOTAL row at :204-219), `cli/commands/ax-dispatches.ts` (3 views), `cli/render.ts`, AND `cli/role-format.ts` + `role-format.test.ts` (the canary). New `cli/table.ts`, `cli/table.test.ts`. Defer ~6-8 remaining grid sites (costs.ts, ax-thinking, skills-weighted-format) to follow-on PRs.

**Hard constraints (each guards a verified byte-drift trap):**
- Auto-width INCLUDES the header: `Math.max(min ?? 0, header.length, ...cellLengths)`. role-format.ts (the only golden-tested table) uses max(header,...cells); ax-cost's floor 20 dominates its 5-char 'model' header so inclusion is a no-op there. (OVERRIDES the codex review's "exclude header" — contradicted by the canary.)
- `width` (fixed: slice+pad) and `min` (auto floor) are DISTINCT, never one number: ax-cost model = auto `Math.max(20,...)` no cap; cost-sessions/costs.ts model = hard fixed 28/30.
- `overflow` is PER-COLUMN: ax-dispatches renders ellipsis-truncate (desc) next to slice-clip (dispatch_model/suggest) in the SAME row. ellipsis MUST call render.ts `truncate` verbatim (`slice(0,len-1)+'…'`) — do not fork a `'...'` variant.
- `gap` is per-call (`'  '` everywhere except costs.ts `' '`).
- Footer rule draws `'─'.repeat(resolvedWidth)` on named cols, blank elsewhere — single-sources alignment so TOTAL rows (ax-cost.ts:204-219, ax-thinking's two TOTAL rows) cannot desync.
- Empty-states + printNextLinks/summary/tip stay OUTSIDE the table, in the command Effect (each early-returns a bespoke string before any table).
- Terminal-width is opt-in `opts.maxWidth` ONLY; NEVER read `process.stdout.columns`/env inside renderTable (only sessions.ts is responsive today; baking it in breaks byte-identity). Cells must be ANSI-free (no strwidth seam yet — doc it).

**Effect/idiom shape:** pure string library, ZERO Effect/Service/Layer/Schema; Column.get synchronous/pure. Seed order: role-format.ts FIRST (already pure AND byte-snapshot-tested = true canary), THEN ax-cost, THEN ax-dispatches. Gate every migration on golden-string byte-equality.

**Test surface:** `table.test.ts` (auto-width incl. header, min floor, fixed width, max cap, clip vs ellipsis, custom gap, right-align, empty rows, footer cells+rule width inheritance) — no Effect/DB. Plus golden-string before/after: extend role-format.test.ts, then ax-cost models/sessions/split + ax-dispatches default/candidates/economy against fixtures, byte-identical. `bun test` + `bun run typecheck`.

**Open questions:**
- ax-cost's rule row draws `'─'` only on cost+share cols AND prepends a blank line. Does `{kind:'rule',cols}` + a caller-pushed `''` reproduce the exact leading `\n`, or should FooterLine carry an explicit blank-before flag? Verify against golden before locking footer shape.
- Does renderTable own the inter-section blank line between data and footer, or the caller? (Lean caller-side; confirm with ax-cost split golden.)
- Confirm role-format.test.ts snapshots assert FULL strings (not row counts) so the canary actually guards header bytes.

---

## F — Graph Access Toolkit adoption (Phase 1 only)   [confidence: high · effort: M (~½–1d)]   (parallel with E)

**Verdict:** amend — strengthen the existing ROW-form seam + collapse the drifted dup copies. DROP the value-form bulk layer, the `numberField` twin, and the always-on CI gate. The candidate's framing ("one missing helper + 50-site sweep") is wrong both directions.

**Deep module / seam (extends `packages/lib/src/shared/surreal.ts` §2):**
- DO NOT add `numberField` — `countField` (surreal.ts:274-280) is ALREADY `Number(row[key] ?? 0)` finite-guarded (the "missing helper" already ships). Adopt countField for token/cost columns; optionally add a `numberField` deprecated ALIAS, never a second implementation.
- Add only genuinely-missing helpers, named by BEHAVIOR: (a) ROW-form `stringFieldOr(row, key, fallback="")` for `String(r.x ?? "")` sites (distinct from strict `stringField` which is null-for-non-string); (b) the minimal VALUE-form primitives needed SOLELY as the shared tested body of the dup-collapse (a coercing-finite-number-with-default + a non-empty/defaulted-string) — NOT a 6-helper coerce* vocabulary.
- Bulk sweep uses ROW-form, not value-form (100% of named-file sites are direct `Number(row.X ?? 0)` / `String(r.X ?? "")` row reads → `countField(row,"X")` / `stringFieldOr(row,"X")` fit with a tiny diff and keep key access in the seam).

**Files:** changed — `packages/lib/src/shared/surreal.ts` (+test), `queries/cost-analytics.ts`, `queries/dispatch-analytics.ts`, + collapse 4 drifted local copies into deprecated re-export shims (precedent: surql.ts:1, row-fields.ts:1): `metrics/util.ts` {numOrNull,numOrZero,strOrNull}, `dashboard/cost-query.ts` {nullableNumber,numberOrZero,stringOrNull}, `dashboard/session-summary.ts` {numOrNull,intOf}, `dashboard/loc-query.ts` {stringOrNull}. EXCLUDE `cli/classifiers-workflow-candidates.ts` {asNumber,asString} — those read parsed-JSON, not DB rows. NO CI grep-gate.

**Hard constraints:**
- Behavior drift is the dominant risk: `String(x ?? "")` coerces numbers + defaults `""`; routing such a site through strict `stringField` (null-for-non-string, null default) silently flips output. Per-site helper choice is mechanical-but-attentive, NOT find/replace.
- The 4 dup copies differ materially (`Number("")=0` is finite → empty columns read 0 in some specs, null in others) — that IS a live drift-bug class; collapsing to one tested spec is the real win.
- Latent NaN-leak sites: cost-analytics.ts:63, dispatch-analytics.ts:422 (unguarded `Number(...??0)`). Adopting countField's finite guard is a real BEHAVIOR change — pin exact semantics with mapper-level regression tests before swapping; decide explicitly whether to fix or preserve bug-for-bug.
- coerceString/stringFieldOr must keep RecordId.toString behavior (recordIdString already encodes it) — avoid `'[object Object]'` regressions.
- NO always-on CI grep-gate in Phase 1 — it reds main until the full long tail lands and can't tell row coercion from a legit `Number(userInput ?? 0)`. If ever shipped, follow the allowlisted/ratcheted scripts/check-*.ts test-only pattern (check-record-select runs via its test; check-no-node-fs is the only CI-wired one).

**Effect/idiom shape:** pure helpers extending the toolkit (no new module). The strategic follow-on (record it, don't build it): Schema.decodeUnknown at the existing defineQuery/mapRow boundary (mirrors @effect/sql) — the value-form helpers are a TACTICAL bridge, not a parallel parser to ossify.

**Test surface:** table-driven in surreal.test.ts pinning the boundaries that distinguish helpers (`String(3??"")`="3" vs stringField=null; finite/NaN guard; empty-string→0; RecordId.toString preservation). PLUS mapper-level regression tests for the named query files (the sweep is a behavior change at latent-bug sites). `bun test` + `bun run typecheck`.

**Open questions:**
- Adopt countField as-is, or rename → numberField with a deprecated alias? Pick one; do not add a second implementation.
- Deliberately adopt the finite/NaN-guarded semantics (fixing cost-analytics.ts:63 / dispatch-analytics.ts:422), or preserve current bug-for-bug behavior? Explicit call + regression test either way.
- Defer the ~190-site long tail (CLI-render/ingest) — fold into the future Schema migration rather than mechanically routing through helpers.

---

## H — File-context hook split   [confidence: high · effort: S (~½d)]   (last in sequence)

**Verdict:** amend — minimal, NOT the 6-module folder. All 3 "amend" verdicts converge: export-in-place the 4 private pure helpers + add their missing unit tests, FIX the triple-suppression redundancy (don't freeze it), extract the composer tail into a pure `finalizeInjection` — all WITHOUT creating a `file-context/` folder. If a structural split is still mandated, fall back to codex's 3-module shape (input/decision/render) with the public composer intact and ALL symbols re-exported — never the 6 one-function modules.

**Deep module / seam (3 moves, priority order):**
1. **EXPORT-IN-PLACE + TESTS (the real win, ~0 risk):** add `export` to 4 private pure fns in `hooks/file-context-hook.ts`: `isSuppressedPath` (215), `generateLookupCandidates` (147), `adaptClaudePayload`+`normalizeSessionId` (162-184), `isHighSignalSession` (224). No new files, no types barrel, no re-export tax — symbols stay in-module so hooks.ts/telemetry.ts are untouched.
2. **FIX TRIPLE-SUPPRESSION:** composer passes `usableFiles` (not `input.files`) into shouldInjectFileMemory at line 418. The composer already guards empty/all-suppressed at line 388, so shouldInject's internal no_files/suppressed_path branches are already dead on the composer path; passing usableFiles is behavior-identical (filter is idempotent) and removes one of three suppression applications. Optionally factor one `filterSuppressed` helper used by composer 387/411, preserving the exact leading-slash normalization at 217.
3. **EXTRACT finalizeInjection** as a pure exported fn reproducing the tri-state at line 438 EXACTLY: `inject = decision.inject && rendered.length > 0; reason = inject ? decision.reason : decision.inject ? "empty_render" : decision.reason`. Co-locate next to shouldInjectFileMemory, NOT a separate module.

**Files:** `hooks/file-context-hook.ts`, `hooks/file-context-hook.test.ts` (add tests to existing — no new test files), `cli/commands/hooks.ts` + `hooks/telemetry.ts` UNCHANGED (nothing moves).

**Hard constraints:**
- The `reason` strings key recordHookFire telemetry — finalizeInjection parity at line 438 is MANDATORY.
- The empty_render branch is effectively DEAD under current invariants (every inject-true path guarantees a non-empty render: corrections→section, commits≥2→section, high-signal prior session→priorFileSessions.length>0→fallback section at 346). Keep finalizeInjection as a small DEFENSIVE pure fn; do NOT justify it as "finally unit-testing empty_render coverage" (codex's verified catch).
- Gate on BOTH `bun test` AND `bun run typecheck` — telemetry.ts's type-only imports (FileContextHookInput, FileContextHookDecision) fail typecheck but pass the test runner; test-green alone is a false signal.
- Keep the fail-open `Effect.catch` dedup degradation in the composer (lines 400-405).
- Undertested case to add: the Claude payload test at lines 103-116 feeds RELATIVE paths and never asserts lookupPaths (codex + the second review flagged it).

**Effect/idiom shape:** textbook functional-core / imperative-shell. The single Effect value `buildFileContextHookResponse` (R = SurrealClient) stays the thin composer; never lift any pure helper into Effect (keep R=never on all). Prior art (effect reviewer): OTel Collector pipeline stages (pure receiver/processor/exporter, pipeline only wires), Effect @effect/platform HttpApi (pure Schema/handler defs vs the Effect serve loop), tRPC (input validation separate from resolver).

**Test surface:** focused unit tests in the existing file-context-hook.test.ts: suppression (lockfile basenames, node_modules/dist substrings, .gen.ts/.map suffixes, leading-slash normalization edge); generateLookupCandidates (monorepo 3-level parent walk, cwd-prefix-miss → [], AND the undertested relative-path case); adaptClaudePayload (Edit/Write/MultiEdit→pre-edit, bare-UUID→`session:` prefixing, missing tool_input, lookupPaths assertion); isHighSignalSession (weight≥3, corrections, merged_to_main, review_pain, produced_commits boundaries); finalizeInjection (both branches as a contract). `bun test` + `bun run typecheck`.

**Open questions:**
- Is empty_render confirmed dead, or can evidence-shape skew make rendered.length===0 while decision.inject===true? Worth a 10-min trace before deciding defensive-only vs live-behavior.
- Does the deepening exercise REQUIRE a visible structural split, or is export-in-place + redundancy-fix + finalizeInjection acceptable? Two reviewers argue a 447-line file with section comments is MORE AI-navigable than 10 files, and that `context/file-context.ts` (1215 lines) is the more compelling deepening target — consider redirecting structural effort there.
- If the 3-module fallback is taken: the exported parsing seams (normalizeEvent/normalizeFormat/dedupeFiles/parseFileContextHookFlags, generic stdin parsing) belong in the input module (the original 6-module sketch omitted them).

---

## G — Ingest stage registry single-source   [confidence: high · effort: S (core; M if optional upgrade)]

**Verdict:** amend — delete-and-derive, NOT factory-and-sync. REJECT the 31-file `defineStage` sweep as the headline; demote it to an optional, consumer-justified follow-up. The original's justification (runtime drift: "silent stage-doesn't-load / type-narrowed-wrong") is factually FALSE — `IngestStageKey` is dead (never decoded; pure type re-export through pipeline.ts); stage loading + `--stages` validation run entirely off `ALL_STAGES`, so union/array drift has zero runtime/type consequence today.

**Deep module / seam (CORE — ship now, ~2 files, net-negative LOC):**
1. `registry.ts`: DELETE `export const IngestStageKey = Schema.Union([...29 literals])` and the 29 `XxxKey` imports that exist only to feed it. Replace with a pure derived type: `export type IngestStageKey = (typeof ALL_STAGES)[number]["meta"]["key"]`. (With `StageMeta.key = Schema.String` this resolves to `string` today — fine, the union has ZERO consumers, verified.) The per-stage `export const XxxKey = Schema.Literal("xxx")` stays untouched (17 stage tests decode it).
2. `registry.test.ts`: add 2 guards the deleted union never gave us:
   - key-uniqueness: `new Set(ALL_STAGES.map(s => s.meta.key)).size === ALL_STAGES.length`.
   - **deps-validity (THE real fix):** assert every `s.meta.deps` value is in the key set — closes the silent dependency-drop bug in runner.ts:97-98/133-135 where a typo'd dep is filtered out and the stage runs in the wrong topo order. Higher-value than anything in the original candidate.

**Files:** core — `ingest/stage/registry.ts`, `ingest/stage/registry.test.ts` only. The original 31-file changedFiles list (types.ts + 29 stage files + define-stage.ts) is the OPTIONAL UPGRADE, not the core.

**Hard constraints:**
- Keep the 29 per-stage `XxxKey = Schema.Literal` exports — the 17 decode tests still need them. Do NOT over-delete during the registry edit.
- The deps-validity test is the load-bearing deliverable; do not skip it for the cosmetic union deletion.

**Effect/idiom shape:** derive the type from the one canonical const, never a parallel hand-written enum. Prior art (effect reviewer): Drizzle `pgEnum('name',[...] as const)` + `InferSelectModel` (one tuple, type derived), Zod `z.enum(Keys as const)`, Effect's own `Schema.Literals` + TaggedClass unions (the registry IS the union, no second enum), OTel Collector factory map (known-types derived from map keys), oclif manifest (derived, not a hand-written command-name union).

**Test surface:** the 2 new guards in registry.test.ts; full `bun run typecheck` + `bun test` (flush any R-channel inference drift if the optional upgrade is taken).

**OPTIONAL UPGRADE (do ONLY when a typed key union has a genuine consumer — currently none):** add a 3rd `const K extends string` generic to `StageDef` + a `defineStage`/`stageMeta` helper, sweep the 29 sites so the literal flows, then `IngestStageKey = Schema.Literals(ALL_STAGES.map(s=>s.meta.key))` resolves to a real literal union. Must EARN its keep: (a) decode `--stages` through `Schema.Literals(keys)`; (b) type `deps` against the union. Gate on a widening-guard test (a non-literal key collapses the union to `string`) + the uniqueness test + full typecheck (R-inference drift: stages currently pin R via explicit `StageDef<S,R>` annotations, e.g. signalsStage: SurrealClient; gitStage: SurrealClient|FileSystem|Path — defineStage infers R from `run` instead; any stage using the annotation to WIDEN R surfaces as a layer-composition error). CAVEAT: typing `deps` at authoring sites against the registry-derived union is blocked by a CIRCULAR import (stage files can't import registry without a cycle) — the deps test is the pragmatic substitute until a keys-only module is extracted.

**Open questions:**
- Does any consumer genuinely need a narrowed IngestStageKey literal union? If none materializes, the optional sweep should NEVER be done.
- Resolve the circular-import constraint via the runtime deps test (cheap, recommended) or by extracting a keys-only module (more churn)?
- Move `--stages` validation from selectByKeys's hand-rolled unknown-key error to `Schema.Literals(keys)` decode? (Minor, only if the optional upgrade is taken.)

---

## I — DEFERRED: derive-stage typed read layer   [confidence: high · effort: ~1d if pursued]

**Verdict:** DEFERRED — amend if ever pursued. Does NOT need ADR-0006 reopen (ADR-0006 governs inter-stage DATA FLOW, not read typing — a one-line code comment suffices: "reads of the DB contract are typed via co-located Query defs, not a central registry"). DROP the speculative central `evidence/` registry. If touched at all overnight, ship ONLY the zero-risk dedup. The infra already exists (`@ax/lib/shared/surreal.ts` toolkit, `shared/query.ts` defineQuery, `shared/graph-query.ts` runQuery) — adoption not greenfield.

**If pursued, in order:**
1. **ZERO-RISK DEDUP (1hr, no design question):** delete derive-spawned.ts lines 23-46 (local stringField/dateField/recordIdToString) and import stringField/dateField/recordIdString/numberFieldOrNull from `@ax/lib/shared/surreal.ts`. Reuse recordListSource/selectByIds for the record-list quirks. The only genuine untested coercer duplication; toolkit header forbids exactly this.
2. **ADD A FAIL-PRESERVING READ VARIANT (load-bearing prerequisite):** add `runQueryOrFail`/`runSingleQueryOrFail` to `shared/graph-query.ts` that preserve the DbError channel (mirror queryPagedWithCount + @effect/sql SqlSchema.findAll). The existing `runQuery` catches DbError → [] (error channel `never`); wiring ingest through it converts a failed upstream read into a clean derive reporting written:0 as SUCCESS. Ingest reads MUST use the fail-preserving variant.
3. **EXTRACT THE ONE ≥3-CONSUMER READ:** `SELECT name FROM skill` appears in derive-signals (fetchSkillNames), derive-proposals, derive-retro-proposals, + an in-loop N+1 in derive-opportunities. The only read crossing ADR-0006's rule of three → one defineQuery in @ax/lib (also reaches the messiest file the original scoped out).
4. **CO-LOCATE, DON'T HOIST:** single-consumer reads (failed-tool-calls in derive-signals, the turn bundle, the derive-intents re-derive scan) → defineQuery + mapRow co-located IN the stage file, returning via runQueryOrFail. No shared evidence/ module.
5. **KEEP DISTINCT PROJECTIONS DISTINCT:** turn has two consumer-specific projections (signals TurnRow with seq/has_error/invoked_skills/->invoked->skill.name traversal vs derive-intents TurnIntentRow); tool_call has two (16-col failed-call vs 5-col spawn-source). Do NOT force one Row-per-table.
6. **PRESERVE INSTRUMENTATION:** re-pipe Effect.withSpan/annotateCurrentSpan in the thin accessors (signals.fetch-turns, fetch-failed-tools, fetch-skills) — runQuery emits no span; collapsing to one-liners silently regresses the trace seam.

**Hard constraints:**
- The headline benefit is NOT "compiler-caught column renames" (impossible while reads are opaque SQL strings — rename stays green and returns undefined→null exactly like today) but DRY + fixture-unit-testable mapRow decoders.
- The since-clause footgun (sinceWhereClause vs sinceAndClause — silent-0-row) is MOVED not fixed; mitigate with per-query SQL-text assertions only.
- DECODE: keep mapRow (toolkit coercers), NOT effect/Schema — deliberate project choice for SurrealDB RecordId/Date/undefined normalization. Do not invent a third decode mechanism.

**Effect/idiom shape:** co-location per ADR-0006's grain (StageDef/keys/tags per stage file argues AGAINST a central evidence/ directory — wrapping one caller and relaying = net-indirection shallow module). NO ADR ceremony, NO Phase-3 amendment debate.

**Test surface:** one SQL-text assertion per migrated query pinning the since WHERE-vs-AND placement; migrate SQL-substring mocks (derive-metrics.test.ts `/FROM tool_call/`, derive-claude-subagents.test.ts keyed on literal `"SELECT name FROM skill"`) to mock-by-stable-query-name. `bun test` + `bun run typecheck`.

**Open questions (only if undeferred):**
- Add runQueryOrFail now or when the first ingest read migrates? (Recommend now — load-bearing prerequisite, trivially small.)
- Thread the shared skill-name query into derive-opportunities' N+1 sites this PR, or follow-up?
- One-sentence ADR-0006 note vs bare code comment? (Lean code comment unless a reviewer has been bitten by the central-registry temptation.)

