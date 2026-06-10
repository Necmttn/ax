# Phase 2: CLI Command Families Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the ~5,870-line `apps/axctl/src/cli/index.ts` dispatcher into per-family command modules under `apps/axctl/src/cli/commands/`, kill the typed-options→string-array→re-parse round-trip family-by-family, and replace the hand-maintained `DB_COMMANDS` set with per-family runtime declarations that `index.ts` derives (guarded by an exhaustiveness test). Behavior-preserving: same flags, same output, same exit codes, same hidden/visible status, same `main()` triage semantics.

**Architecture:** Each family module (`apps/axctl/src/cli/commands/<family>.ts`) owns its `cmd*` handlers (typed option objects, no string re-parse), its Effect CLI `Command.make` registrations, and a `RuntimeManifest` declaring how each of its **top-level** command names must be routed (`"db"` → `withDb`, `"ingest"` → `withIngest`, `"none"` → `withoutDb`). `index.ts` shrinks to: imports, `rootCommand` assembly (`Command.make("axctl")` + `Command.withSubcommands` with the existing visibility policy), the `withDb`/`withIngest`/`withoutDb` runtime wrappers, `RUNTIME_BY_COMMAND` (spread of all family manifests) → derived `DB_COMMANDS`, and `main()` triage. The pattern mirrors the three family modules that already exist outside index.ts: `src/agents/cli.ts` (exports a whole `Command`), `src/hooks/cli.ts` / `src/skills/cli.ts` (export subcommand arrays spliced into a group).

**Tech Stack:** bun ≥1.3, TypeScript strict (`noUnusedLocals: true`, `exactOptionalPropertyTypes: true`), Effect v4 beta - CLI primitives come from `effect/unstable/cli` (`Command`, `Flag`, `Argument`; verified against `.references/effect-smol/packages/effect/src/unstable/cli/Command.ts`: `Command.make`, `Command.withSubcommands` (accepts `ReadonlyArray<Command.SubcommandEntry>`), `Command.withHidden`, `Command.withDescription` all exist as used today). Tests: bun:test, colocated. Typecheck: `bun run typecheck` (repo root, turbo). Local run: `apps/axctl/bin/axctl` shim → `bun apps/axctl/src/cli/index.ts`.

---

## 0. Ground rules (read before every task)

- **Pure moves are verbatim.** "Move X from `cli/index.ts:A–B`" means cut the declaration *including its leading doc/JSDoc comment block* and paste unchanged. Line ranges below are inclusive and were measured against the current file (5,870 lines, HEAD of `main` at plan time). If Phase 1 (queries extraction) lands first, line numbers around `cmdStats`/`cmdUnused` will have shifted - locate by declaration name, not line number, and move whatever the function body is *then* (see "Merge-conflict hotspots").
- **Relative import depth changes.** `commands/*.ts` is one level deeper than `cli/*.ts`: imports of cli siblings become `../<file>.ts` (e.g. `../insights-format.ts`), imports of other src dirs become `../../<dir>/...` (e.g. `../../dashboard/recall.ts`). `@ax/lib/...` package imports are unchanged. Keep the `.ts` extension (`allowImportingTsExtensions`).
- **`noUnusedLocals` is your pruning tool.** After each move, `bun run typecheck` will flag every import in `index.ts` that became unused - delete exactly those. Do not pre-emptively delete imports.
- **`exactOptionalPropertyTypes` gotcha.** New typed handler input interfaces must declare optional members as `| undefined` (e.g. `readonly windowDays: number | undefined`), NOT `?:`, so registration sites can pass `optionValue(flag)` directly. When forwarding into existing fetchers with `?:` optional params, keep the established conditional-spread idiom: `...(x !== undefined ? { x } : {})`.
- **Behavior parity for flag validation.** Today `Flag.integer` parses, the handler rebuilds `--limit=${n}`, and `parsePositiveIntFlag` re-validates positivity (exit 2). Typed handlers must keep that validation via the new `requirePositiveInt` / `requireOptionalPositiveInt` helpers (Task 1) which print the byte-identical message `axctl <cmd>: --<flag> must be a positive integer (got "<n>")` and `process.exit(2)`.
- **Guards made dead by the CLI parser get deleted, with a comment.** E.g. `cmdStats`'s "missing skill name" check is unreachable once the handler receives a required `Argument.string` - the Effect CLI parser already rejects the bare invocation. Deleting these is behavior-preserving *via the CLI*, which is the only caller after the move.
- **Handlers that delegate to external string-array modules keep building string arrays.** `cmdShare`, `cmdRetroReflect/Meta/Plan`, `cmdProject`, `cmdDogfoodTerminal`, `cmdClassifiersEval/List`, `runClassifiers*` wrappers, `printVersion`/`updateAxctl`, `cmdDaemon`, `cmdDoctor`, and `jsonSelfImprove` parse args inside their own modules. Changing those module contracts is out of scope; the `boolArg`/`intArg`/`stringArg` bridges move to `commands/shared.ts` for them. The same applies to `cmdIngest`/`cmdIngestHere`: `runIngest({ args })` consumes string args downstream (its own `resolveStages`/flag parsing in `src/ingest/run.ts`), so the ingest family keeps its `args: string[]` internal shape - documented exception.
- **Per-task gate:** `bun run typecheck` green, `bun test apps/axctl` green, one smoke invocation of a command from the moved family, then commit. If a local harness hook blocks `bun test` directly, run it via a tmp wrapper script (`echo 'cd /path/to/repo && bun test apps/axctl' > /tmp/run-tests.sh && bash /tmp/run-tests.sh`).
- **Smoke invocations** run from the repo root: `bun apps/axctl/src/cli/index.ts <args>` (what the `bin/axctl` shim execs). DB-backed smokes need the local SurrealDB (`ax daemon status` to check). If the DB is down, fall back to `bun apps/axctl/src/cli/index.ts <family> --help` - that still exercises module loading + registration + parser wiring. **Never smoke with a bare `ax ingest`** (watcher-collision risk); use `ingest --dry-run`.
- **Commits:** conventional commits, one per task, ending with the trailer shown in each task.

---

## 1. Complete inventory (the heart of this plan)

Every top-level declaration in `apps/axctl/src/cli/index.ts`, its current line range (inclusive, leading comment block included), target file, and disposition. Disposition legend: **move** = verbatim move; **typed** = move + convert handler signature from `(args: string[])` to a typed input object and update its registration to stop rebuilding string arrays; **delete** = removed (replaced by typed plumbing); **stay** = remains in index.ts.

### → `commands/shared.ts` (Task 1)

| Declaration | Current lines | Disposition |
|---|---|---|
| `boolArg` | 174–176 | move |
| `intArg` | 177–179 | move |
| `stringArg` | 180–182 | move |
| `optionValue` | 183–185 | move (re-export of `../config-core/cli-util.ts` is equivalent; keep local copy for zero-risk) |
| `fmtCount` | 242–251 | move |
| `positiveLimit` | 1726–1727 | move |
| `optionalSince` | 1728 | move |
| `jsonFlag` | 1729 | move |
| `parseFileHints` | 5163–5167 | move (used by context **and** hooks families) |
| `requirePositiveInt` / `requireOptionalPositiveInt` | (new) | typed replacements for `parsePositiveIntFlag`/`parseOptionalPositiveIntFlag` validation semantics |

`flag` (186–190), `parsePositiveIntFlag` (191–219), `parseOptionalPositiveIntFlag` (221–240) **stay in index.ts during migration** (unmoved `cmd*`s still call them) and are **deleted in Task 20** when the last string-parsing handler is gone. `wantsJsonFlag` (new, Task 1) goes in `cli/output.ts` next to `wantsJson`.

### → `commands/report.ts` - top-levels: `report`, `insights`, `timeline` (Task 2, pilot)

| Declaration | Current lines | Disposition |
|---|---|---|
| `cmdInsights` | 608–628 | typed |
| `cmdReport` | 630–643 | typed |
| `insightView` | 1920 | move |
| `insightsCommand` | 1922–1930 | move + typed call |
| `reportCommand` | 4388–4395 | move + typed call |
| `cmdTimeline` | 4872–4893 | move (already typed) |
| `timelineCommand` | 4895–4901 | move |

### → `commands/signals.ts` - top-level: `signals` (Task 3)

| Declaration | Current lines | Disposition |
|---|---|---|
| `formatCascadeEdges` | 3752–3760 | move |
| `cmdSignalsList` | 3762–3767 | move (already typed) |
| `cmdSignalsShow` | 3769–3789 | move (already typed) |
| `signalsListCommand` | 3791–3793 | move |
| `signalsShowCommand` | 3795–3806 | move |
| `signalsCommand` | 3808–3814 | move |

### → `commands/evidence.ts` - top-level: `evidence` (Task 4)

| Declaration | Current lines | Disposition |
|---|---|---|
| `jsonSelfImprove` | 5433–5443 | move (delegates to `parseSelfImproveArgs` - string bridge stays) |
| `evidenceGuidanceNextCommand` | 5445–5449 | move |
| `evidenceSessionSummaryCommand` | 5451–5455 | move |
| `evidenceWeeklyCommand` | 5457–5461 | move |
| `evidenceCommand` | 5463–5470 | move |

### → `commands/context.ts` - top-level: `context` (Task 5)

| Declaration | Current lines | Disposition |
|---|---|---|
| `contextFileCommand` | 5169–5191 | move (handler already typed inline; uses `parseFileHints` from shared) |
| `contextCommand` | 5193–5196 | move |

### → `commands/project.ts` - top-level: `project` (Task 6)

| Declaration | Current lines | Disposition |
|---|---|---|
| `projectContextCommand` | 5140–5144 | move (delegates to `cmdProject` in `../project.ts` - string bridge stays) |
| `projectVerifyCommand` | 5146–5150 | move |
| `projectHarnessCommand` | 5152–5156 | move |
| `projectCommand` | 5158–5161 | move |

### → `commands/serve.ts` - top-levels: `serve`, `mcp`, `tui` (Task 7)

| Declaration | Current lines | Disposition |
|---|---|---|
| `serveCommand` | 4374–4378 | move |
| `mcpCommand` | 4380–4386 | move (keep the "deliberately NOT in DB_COMMANDS" comment) |
| `tuiCommand` | 5502–5510 | move |

### → `commands/share.ts` - top-level: `share` (Task 8)

| Declaration | Current lines | Disposition |
|---|---|---|
| `shareCommand` | 5117–5138 | move (delegates to `cmdShare` in `../share.ts`; `main()`'s direct `cmdShare` bypass stays in index.ts) |

### → `commands/dogfood.ts` - top-level: `dogfood` (Task 9)

| Declaration | Current lines | Disposition |
|---|---|---|
| `dogfoodTerminalCommand` | 4757–4782 | move (delegates to `cmdDogfoodTerminal` - string bridge stays) |
| `cmdDogfoodRuns` | 4784–4811 | typed |
| `dogfoodRunsCommand` | 4813–4820 | move + typed call |
| `dogfoodCommand` | 4822–4825 | move |

### → `commands/costs.ts` - top-levels: `costs`, `loc`, `pricing` (Task 10)

| Declaration | Current lines | Disposition |
|---|---|---|
| `usd` | 4397–4400 | move |
| `integer` | 4402–4405 | move |
| `cmdCosts` | 4407–4466 | move (already typed) |
| `costsSummaryCommand` | 4468–4483 | move |
| `formatCostSummary` | 4485–4514 | move |
| `splitCostTerms` | 4516–4519 | move |
| `costQueryTerms` | 4521–4525 | move |
| `cmdCostsFor` | 4527–4579 | move (already typed) |
| `costsForCommand` | 4581–4608 | move |
| `costsGroupCommand` | 4610–4613 | move |
| `formatLocSummary` | 4615–4637 | move |
| `cmdLoc` | 4639–4675 | move (already typed) |
| `locCommand` | 4677–4700 | move |
| `cmdPricing` | 4702–4740 | move (already typed) |
| `pricingCommand` | 4742–4755 | move |

### → `commands/recall.ts` - top-level: `recall` (Task 11)

| Declaration | Current lines | Disposition |
|---|---|---|
| `VALID_SOURCES` | 645 | move |
| `parseSourcesFlag` | 647–658 | move |
| `RecallCliOpts` | 660–668 | move |
| `resolveScope` | 670–709 | move |
| `pickFromList` | 711–752 | move |
| `resolveProject` | 754–805 | move |
| `resolveSkill` | 807–851 | move |
| `cmdRecall` | 853–938 | move (already typed: takes `RecallCliOpts`) |
| `recallCommand` | 4836–4864 | move |

### → `commands/hooks.ts` - top-levels: `hook`, `hooks` (Task 12)

| Declaration | Current lines | Disposition |
|---|---|---|
| `readStdinAll` | 5198–5207 | move |
| `mergeHookInputs` | 5209–5219 | move |
| `hookFileContextCommand` | 5221–5292 | move (handler already typed inline) |
| `hookLogCommand` | 5294–5322 | move (handler already typed inline) |
| `hookCommand` | 5324–5327 | move |
| `hooksSummaryCommand` | 5329–5350 | move (handler already typed inline) |
| `hooksInvocationsCommand` | 5352–5373 | move |
| `hooksSessionCommand` | 5375–5390 | move |
| `hooksBacktestCase` | 5392–5394 | move |
| `hooksBacktestCommand` | 5396–5420 | move |
| `hooksCommand` | 5422–5431 | move (keeps splicing `...hooksConfigSubcommands` from `../../hooks/cli.ts`) |

### → `commands/retro.ts` - top-level: `retro` (Task 13)

| Declaration | Current lines | Disposition |
|---|---|---|
| `cmdRetroEmit` | 3831–3917 | typed |
| `cmdRetroList` | 3919–3940 | typed |
| `PendingSessionRow` | 3942–3963 | move |
| `PendingSession` | 3965–3976 | move |
| `PendingQueryOpts` | 3978–3995 | move |
| `queryPendingSessions` | 3997–4074 | move |
| `cmdRetroPending` | 4076–4102 | typed |
| `formatRetroBrief` | 4104–4164 | move |
| `suggestModelFor` | 4166–4170 | move |
| `cmdRetroBrief` | 4172–4244 | typed |
| `retroEmitCommand` | 4246–4260 | move + typed call |
| `retroListCommand` | 4262–4274 | move + typed call |
| `retroReflectCommand` | 4276–4290 | move (delegates to `cmdRetroReflect` - string bridge stays) |
| `retroMetaCommand` | 4292–4304 | move (string bridge stays) |
| `retroPlanCommand` | 4306–4335 | move (string bridge stays) |
| `retroPendingCommand` | 4337–4353 | move + typed call |
| `retroBriefCommand` | 4355–4367 | move + typed call |
| `retroCommand` | 4369–4372 | move |

### → `commands/improve.ts` - top-level: `improve` (Task 14)

| Declaration | Current lines | Disposition |
|---|---|---|
| `formatProposalLine` | 2517–2530 | move |
| `cmdImproveList` | 2532–2553 | typed |
| `cmdImproveShow` | 2555–2573 | typed |
| `cmdImproveLint` | 2575–2616 | typed |
| `cmdImproveRecommend` | 2618–2674 | typed |
| `improveRecommendCommand` | 2676–2698 | move + typed call |
| `improveLintCommand` | 2700–2713 | move + typed call |
| `improveListCommand` | 2715–2730 | move + typed call |
| `improveShowCommand` | 2732–2739 | move + typed call |
| `cmdImproveReject` | 2741–2755 | typed |
| `improveAcceptCommand` | 2757–2861 | move (handler already typed inline) |
| `improveRejectCommand` | 2863–2870 | move + typed call |
| `ALLOWED_VERDICTS` | 2872–2874 | move |
| `cmdImproveVerdict` | 2876–3006 | typed |
| `improveVerdictCommand` | 3008–3024 | move + typed call |
| `cmdImproveReset` | 3026–3062 | typed |
| `improveResetCommand` | 3064–3070 | move + typed call |
| `cmdImproveCheckpoint` | 3072–3089 | typed |
| `improveCheckpointCommand` | 3091–3099 | move + typed call |
| `improveCommand` | 3816–3829 | move |

⚠ Also updates `cli/recommend.test.ts` + `cli/lint.test.ts` (they read index.ts **source text** and slice between `const improveRecommendCommand` / `const improveLintCommand` / `const improveListCommand` markers - point them at `apps/axctl/src/cli/commands/improve.ts` and **preserve the relative declaration order** `improveRecommendCommand` → `improveLintCommand` → `improveListCommand` in the new file or the slices come back empty).

### → `commands/sessions.ts` - top-level: `sessions` (Task 15)

| Declaration | Current lines | Disposition |
|---|---|---|
| `formatSessionsTable` | 3101–3137 | move |
| `STALE_THRESHOLD_DEFAULT` | 3139–3147 | move |
| `AUTO_BACKFILL_TIMEOUT_SECONDS` | 3149–3154 | move |
| `maybeAutoIngestStale` | 3156–3212 | typed (takes `StaleCheckOpts` instead of raw args) |
| `cmdSessionsHere` | 3214–3260 | typed |
| `cmdSessionsAround` | 3262–3311 | typed |
| `cmdSessionsNear` | 3313–3376 | typed |
| `cmdSessionShow` | 3378–3445 | typed |
| `sessionShowCommand` | 3447–3473 | move + typed call |
| `noStaleCheckFlag` | 3475–3482 | move |
| `staleThresholdFlag` | 3483 | move |
| `staleCheckArgs` | 3484–3487 | **delete** (string bridge; replaced by `StaleCheckOpts` object) |
| `sessionsHereCommand` | 3489–3511 | move + typed call |
| `sessionsAroundCommand` | 3513–3528 | move + typed call |
| `sessionsNearCommand` | 3530–3544 | move + typed call |
| `cmdSessionsCompare` | 3546–3589 | typed |
| `sessionsCompareCommand` | 3591–3607 | move + typed call |
| `cmdSessionsMetrics` | 3609–3697 | move (already typed) |
| `sessionsMetricsCommand` | 3699–3738 | move |
| `sessionsCommand` | 3740–3750 | move |

### → `commands/skills.ts` - top-levels: `skills`, `roles` (Task 16)

| Declaration | Current lines | Disposition |
|---|---|---|
| `cmdSearch` | 940–1054 | typed |
| `skillExists` | 1056–1071 | move |
| `cmdStats` | 1073–1193 | typed ⚠ Phase-1 conflict hotspot |
| `cmdRecent` | 1195–1211 | typed |
| `cmdUnused` | 1213–1344 | typed ⚠ Phase-1 conflict hotspot |
| `cmdSkillsWeighted` | 1346–1371 | typed (showcase example A below) |
| `cmdSkillsByRole` | 1373–1401 | typed |
| `cmdRolesForSkill` | 1403–1431 | typed |
| `cmdRoles` | 1433–1450 | typed |
| `cmdTaste` | 1452–1652 | typed |
| `cmdPairs` | 1654–1702 | typed |
| `cmdRecovery` | 1704–1724 | typed |
| `searchCommand` | 4827–4834 | move + typed call |
| `statsCommand` | 4866–4870 | move + typed call |
| `recentCommand` | 4903–4907 | move + typed call |
| `unusedCommand` | 4909–4921 | move + typed call |
| `tasteCommand` | 4923–4934 | move + typed call |
| `pairsCommand` | 4936–4943 | move + typed call |
| `recoveryCommand` | 4945–4949 | move + typed call |
| `classifyCommand` | 4951–4972 | move (`cmdSkillsClassify` already takes a typed object) |
| `tagCommand` | 4974–4999 | move (`cmdSkillsTag` already typed) |
| `skillsLintCommand` | 5001–5024 | move (`cmdSkillsLint` already typed) |
| `weightedCommand` | 5026–5051 | move + typed call |
| `byRoleCommand` | 5053–5068 | move + typed call |
| `rolesForSkillCommand` | 5070–5082 | move + typed call |
| `skillsCommand` | 5084–5102 | move (keeps splicing `...skillsConfigSubcommands` from `../../skills/cli.ts`) |
| `rolesCommand` | 5104–5115 | move + typed call |

### → `commands/classifiers.ts` - top-level: `classifiers` (Task 17)

| Declaration | Current lines | Disposition |
|---|---|---|
| `classifiersEvalCommand` | 1932–1940 | move (string bridge to `cmdClassifiersEval` stays) |
| `classifiersListCommand` | 1942–1948 | move (string bridge stays) |
| `cmdClassifiersExplain` | 1950–1972 | typed |
| `classifiersExplainCommand` | 1974–1984 | move + typed call |
| `classifiersPackageOperationsCommand` | 1986–2095 | move (handler already typed inline) |
| `classifiersGraphCommand` | 2097–2167 | move |
| `parseRouteInputValues` | 2169–2185 | move |
| `classifiersLifecycleCommand` | 2187–2233 | move |
| `classifiersWorkflowCandidatesCommand` | 2235–2436 | move |
| `classifiersLabelMiningCommand` | 2438–2501 | move (handler already typed inline) |
| `classifiersCommand` | 2503–2515 | move |
| `classifiersPackageOperationsNeedsDb` | 5784–5791 | move + re-export from index.ts (main() + effect-cli.test.ts use it) |

### → `commands/ingest.ts` - top-levels: `ingest`, `derive`, `derive-signals`, `derive-intents` (Task 18)

| Declaration | Current lines | Disposition |
|---|---|---|
| `runIdFor` | 253–255 | move |
| `numericCounts` | 257–264 | move |
| `errorText` | 266–268 | move |
| `progressModeFor` | 270–277 | **delete** (typed `Flag.choice` already yields a validated `ProgressMode`) |
| `writeIngestEvent` | 279–294 | move |
| `telemetryStage` | 296–353 | move |
| `progressUpdater` | 355–361 | move |
| `resolveIngestStages` | 363–386 | move + re-export from index.ts (effect-cli.test.ts imports it) |
| `REMOVED_INGEST_FLAGS` | 389–398 | move |
| `detectRemovedIngestFlag` | 400–409 | move + re-export (main() + test) |
| `IngestCommandOpts` | 411–416 | move |
| `INGEST_LOCK_STALE_GRACE_MS` | 418–423 | move |
| `cmdIngest` | 425–473 | move (keeps `args: string[]` - `runIngest({ args })` contract, documented exception) |
| `cmdIngestHere` | 475–519 | move (same exception) |
| `cmdDeriveSignals` | 521–565 | typed |
| `cmdIngestInsights` | 567–606 | typed |
| `checkFlag` | 1730 | → `commands/lifecycle.ts` (only version/update use it) |
| `verboseFlag` | 1731 | move (ingest/derive only) |
| `debugFlag` | 1732–1738 | move |
| `progressFlag` | 1739–1741 | move |
| `insightsOnlyConflicts` | 1743–1755 | move + re-export (test) |
| `ingestHereCommand` | 1757–1779 | move |
| `ingestCommand` | 1781–1856 | move |
| `deriveSignalsFlags` | 1858–1862 | move |
| `handleDeriveSignals` | 1863–1868 | move + typed call |
| `deriveIntentsFlags` | 1870–1873 | move |
| `handleDeriveIntents` | 1874–1895 | move (already typed) |
| `deriveSignalsDescription` / `deriveIntentsDescription` | 1897–1898 | move |
| `deriveSignalsCommand` | 1900–1903 | move (⚠ LaunchAgent plists call `derive-signals` by name - name must not change) |
| `deriveIntentsCommand` | 1905–1906 | move (same constraint) |
| `deriveCommand` | 1908–1918 | move |

### → `commands/lifecycle.ts` - top-levels: `version`, `update`, `install`, `setup`, `daemon`, `doctor`, `uninstall` (Task 19)

| Declaration | Current lines | Disposition |
|---|---|---|
| `checkFlag` | 1730 | move |
| `bannerFlag` | 5472 | move |
| `versionCommand` | 5474–5488 | move (string bridge to `printVersion` stays) |
| `updateCommand` | 5490–5500 | move (string bridge stays) |
| `installCommand` | 5512–5514 | move |
| `setupCommand` | 5516–5536 | move (`cmdSetup` already typed) |
| `daemonStatusCommand` | 5538–5542 | move (string bridge to `cmdDaemon` stays) |
| `daemonStartCommand` | 5544–5546 | move |
| `daemonStopCommand` | 5548–5550 | move |
| `daemonRestartCommand` | 5552–5554 | move |
| `daemonCommand` | 5556–5564 | move |
| `doctorCommand` | 5566–5570 | move |
| `uninstallCommand` | 5572–5580 | move |

### Stays in `index.ts`

| Declaration | Current lines | Notes |
|---|---|---|
| `flag` / `parsePositiveIntFlag` / `parseOptionalPositiveIntFlag` | 186–240 | stay during migration; deleted in Task 20 |
| `devOnlyCommands` | 5582 | stays (env check at module scope; imports `dogfoodCommand`) |
| `rootCommand` | 5584–5636 | stays - assembly + visibility policy verbatim, only the command consts now come from imports |
| `runCli` | 5638–5647 | stays |
| `CliProgram` | 5649–5650 | stays |
| `withDb` | 5652–5658 | stays |
| `resolveProgressStages` | 5660–5683 | stays (entry-point wiring; uses `ALL_STAGES`) |
| `withIngest` | 5685–5726 | stays |
| `withoutDb` | 5728–5750 | stays |
| `DB_COMMANDS` | 5752–5782 | **replaced** by derivation from `RUNTIME_BY_COMMAND` (Task 2); export name/shape preserved (`ReadonlySet<string>`) |
| `classifiersPackageOperationsNeedsDb` | 5784–5791 | moves to classifiers.ts (Task 17), re-exported here |
| `main` | 5793–5858 | stays; only its imports change |
| `import.meta.main` block | 5860–5870 | stays |

---

## 2. The runtime manifest (DB_COMMANDS fix)

Current mechanism (index.ts:5752–5791 + main() 5793–5858): a hand-maintained `Set` of top-level names routed through `withDb`; everything else gets `withoutDb` (a Proxy SurrealClient that throws on access); `ingest` and `classifiers` have explicit pre-dispatch branches in `main()`. Drift mode: add a new DB-backed family, forget the set, command dies at runtime with the Proxy error.

Smallest honest fix: each family declares the routing for the top-level names it registers; index derives the set; an exhaustiveness test fails CI if any registered top-level name lacks a declaration.

```ts
// apps/axctl/src/cli/commands/manifest.ts  (new, Task 1)
/**
 * How a top-level axctl command must be routed by main() in cli/index.ts.
 * Every command-family module exports a RuntimeManifest covering exactly the
 * top-level names it registers; index.ts spreads them into RUNTIME_BY_COMMAND
 * and derives DB_COMMANDS. effect-cli.test.ts enforces exhaustiveness against
 * rootCommand, so an undeclared new command fails CI instead of dying at
 * runtime on the no-DB Proxy.
 */
export type CommandRuntime =
    /** handlers reach SurrealDB - route through withDb (AppLayer) */
    | "db"
    /** ingest pipeline - route through withIngest (IngestRuntimeLayer + trace transports) */
    | "ingest"
    /** must never touch the DB - route through withoutDb (Proxy SurrealClient that throws) */
    | "none";

export type RuntimeManifest = Readonly<Record<string, CommandRuntime>>;
```

Each family module exports e.g. `export const sessionsRuntime: RuntimeManifest = { sessions: "db" };`. In index.ts (introduced in Task 2, shrinking each task):

```ts
// Names not yet migrated to a family module. Shrinks to {} by Task 19 and is
// deleted in Task 20. Mirrors the legacy DB_COMMANDS set exactly.
const LEGACY_RUNTIME: RuntimeManifest = { /* see Task 2 */ };

export const RUNTIME_BY_COMMAND: RuntimeManifest = {
    ...LEGACY_RUNTIME,
    ...reportRuntime,
    // ...one spread per migrated family
};

// Commands whose handlers reach into SurrealClient via AppLayer (or the
// ingest superset layer). Anything outside this set runs through `withoutDb`
// so the user gets fast, honest errors (e.g. "unknown command") instead of a
// 5s connect timeout. Derived - do not hand-edit; declare runtime in the
// owning commands/<family>.ts manifest instead.
export const DB_COMMANDS: ReadonlySet<string> = new Set(
    Object.entries(RUNTIME_BY_COMMAND)
        .filter(([, runtime]) => runtime === "db" || runtime === "ingest")
        .map(([name]) => name),
);
```

Notes for parity:
- `ingest` is in today's `DB_COMMANDS` even though `main()`'s explicit `if (args[0] === "ingest")` branch returns first (the set entry is unreachable but asserted by `effect-cli.test.ts`: `DB_COMMANDS.has("ingest")`). Deriving with `"db" || "ingest"` keeps the set's contents byte-identical.
- `main()` keeps its explicit `ingest`, `classifiers`, `share`, `star`, `upgrade`, help/version branches verbatim - only `detectRemovedIngestFlag` and `classifiersPackageOperationsNeedsDb` become imports from family modules.
- Routing semantics per name (matches today exactly): `"db"` for `derive`, `derive-signals`, `derive-intents`, `insights`, `classifiers`, `sessions`, `signals`, `improve`, `retro`, `report`, `costs`, `loc`, `pricing`, `recall`, `skills`, `roles`, `project`, `context`, `hook`, `hooks`, `agents`, `evidence`, `timeline`, `tui`, `dogfood`; `"ingest"` for `ingest`; `"none"` for `serve`, `mcp`, `share`, `install`, `setup`, `daemon`, `doctor`, `uninstall`, `version`, `update`.
- `agents` lives in `src/agents/cli.ts` (not part of this split): Task 20 adds `export const agentsRuntime: RuntimeManifest = { agents: "db" };` there.
- The exhaustiveness guard (Task 20) in `effect-cli.test.ts`:

```ts
test("every registered top-level command declares its runtime (anti-drift, replaces hand-maintained DB_COMMANDS)", () => {
    for (const name of topLevelNames()) {
        expect(RUNTIME_BY_COMMAND[name], `command "${name}" missing from a family RuntimeManifest`).toBeDefined();
    }
});
```

(`RUNTIME_BY_COMMAND` gets exported from index.ts for this. Manifest entries for commands that register conditionally - `dogfood` under `AX_DEV=1` - exist unconditionally; the test only checks registered ⊆ declared, so that is fine.)

---

## 3. Typed-handler conversion pattern (kill the round-trip)

### Showcase A - `ax skills weighted` (current code, real)

**Before** - handler re-parses strings (index.ts:1346–1371):

```ts
const cmdSkillsWeighted = (args: string[]) =>
    Effect.gen(function* () {
        const limit = parsePositiveIntFlag("skills weighted", "limit", args, 25);
        const windowDays = parseOptionalPositiveIntFlag("skills weighted", "window", args);
        const doctorThreshold = parsePositiveIntFlag("skills weighted", "doctor-threshold", args, 5);
        const json = args.includes("--json");
        const includeTools = args.includes("--include-tools");

        // --window=0 is invalid: parseOptionalPositiveIntFlag rejects it (n <= 0).
        // If the user passes --window, but 0 or negative, process.exit(2) already fired.

        const result = yield* fetchSkillsWeighted({
            ...(windowDays !== undefined ? { windowDays } : {}),
            limit,
            doctorThreshold,
            includeTools,
        }).pipe(
            catchDbErrorAndExit("axctl skills weighted"),
        );

        if (json) {
            console.log(renderWeightedJson(result));
        } else {
            console.log(renderWeightedTable(result));
        }
    });
```

…and the registration rebuilds the string array (index.ts:5026–5051):

```ts
const weightedCommand = Command.make(
    "weighted",
    {
        window: Flag.integer("window").pipe(Flag.optional),
        limit: positiveLimit(25),
        doctorThreshold: Flag.integer("doctor-threshold").pipe(Flag.withDefault(5)),
        includeTools: Flag.boolean("include-tools").pipe(Flag.withDefault(false)),
        json: jsonFlag,
    },
    ({ window, limit, doctorThreshold, includeTools, json }) =>
        cmdSkillsWeighted([
            `--limit=${limit}`,
            ...intArg("window", optionValue(window)),
            `--doctor-threshold=${doctorThreshold}`,
            ...boolArg("include-tools", includeTools),
            ...boolArg("json", json),
        ]),
).pipe(
    Command.withDescription(
        "Rank skills by usage × role-weight (classified skills score higher). " +
        "Provider built-in tools (codex/pi/etc.) are excluded by default; pass " +
        "--include-tools to rank them too. " +
        "Doctor mode warns when many skills are unclassified. " +
        "--window=Nd  --limit=N  --doctor-threshold=N  --include-tools  --json",
    ),
);
```

**After** - in `commands/skills.ts` (handler takes typed options; validation parity via shared helpers; same flags, output, exit codes):

```ts
interface SkillsWeightedInput {
    readonly limit: number;
    readonly windowDays: number | undefined;
    readonly doctorThreshold: number;
    readonly includeTools: boolean;
    readonly json: boolean;
}

const cmdSkillsWeighted = (input: SkillsWeightedInput) =>
    Effect.gen(function* () {
        const limit = requirePositiveInt("skills weighted", "limit", input.limit);
        const windowDays = requireOptionalPositiveInt("skills weighted", "window", input.windowDays);
        const doctorThreshold = requirePositiveInt("skills weighted", "doctor-threshold", input.doctorThreshold);

        // --window=0 is invalid: requireOptionalPositiveInt rejects it (n <= 0)
        // with exit 2, mirroring the old parseOptionalPositiveIntFlag behavior.

        const result = yield* fetchSkillsWeighted({
            ...(windowDays !== undefined ? { windowDays } : {}),
            limit,
            doctorThreshold,
            includeTools: input.includeTools,
        }).pipe(
            catchDbErrorAndExit("axctl skills weighted"),
        );

        if (input.json) {
            console.log(renderWeightedJson(result));
        } else {
            console.log(renderWeightedTable(result));
        }
    });

const weightedCommand = Command.make(
    "weighted",
    {
        window: Flag.integer("window").pipe(Flag.optional),
        limit: positiveLimit(25),
        doctorThreshold: Flag.integer("doctor-threshold").pipe(Flag.withDefault(5)),
        includeTools: Flag.boolean("include-tools").pipe(Flag.withDefault(false)),
        json: jsonFlag,
    },
    ({ window, limit, doctorThreshold, includeTools, json }) =>
        cmdSkillsWeighted({
            limit,
            windowDays: optionValue(window),
            doctorThreshold,
            includeTools,
            json,
        }),
).pipe(
    Command.withDescription(
        "Rank skills by usage × role-weight (classified skills score higher). " +
        "Provider built-in tools (codex/pi/etc.) are excluded by default; pass " +
        "--include-tools to rank them too. " +
        "Doctor mode warns when many skills are unclassified. " +
        "--window=Nd  --limit=N  --doctor-threshold=N  --include-tools  --json",
    ),
);
```

### Showcase B - `ax sessions here` (includes the `maybeAutoIngestStale` arg-threading)

**Before** (index.ts:3214–3260 handler, 3484–3487 bridge, 3489–3511 registration):

```ts
const cmdSessionsHere = (args: string[]) =>
    Effect.gen(function* () {
        const days = parsePositiveIntFlag("sessions here", "days", args, 14);
        const json = wantsJson(args);
        const includeSubagents = args.includes("--include-subagents");
        const limit = flag("limit", args) === undefined
            ? null
            : parsePositiveIntFlag("sessions here", "limit", args);

        const pwdResolution = yield* resolvePwdRepository().pipe(
            Effect.catchTag("NotAGitRepoError", (err) =>
                Effect.sync(() => {
                    process.stderr.write(
                        `axctl sessions here: not in a git repository (cwd=${err.cwd})\n`,
                    );
                    process.exit(2);
                }),
            ),
        );

        const repositoryKey = pwdResolution.repositoryRecordId.id as string;
        yield* maybeAutoIngestStale("sessions here", pwdResolution.repoRoot, args);
        const allRows = yield* listSessionsHere({ repositoryKey, days });
        // ... (subagent filtering + table output, verbatim)
    });

const staleCheckArgs = (noStaleCheck: boolean, staleThreshold: Option.Option<number>): string[] => [
    ...boolArg("no-stale-check", noStaleCheck),
    ...intArg("stale-threshold", optionValue(staleThreshold)),
];

const sessionsHereCommand = Command.make(
    "here",
    {
        days: Flag.integer("days").pipe(Flag.withDefault(14)),
        limit: Flag.integer("limit").pipe(Flag.optional),
        includeSubagents: Flag.boolean("include-subagents").pipe(Flag.withDefault(false)),
        json: jsonFlag,
        noStaleCheck: noStaleCheckFlag,
        staleThreshold: staleThresholdFlag,
    },
    ({ days, limit, includeSubagents, json, noStaleCheck, staleThreshold }) =>
        cmdSessionsHere([
            `--days=${days}`,
            ...intArg("limit", optionValue(limit)),
            ...boolArg("include-subagents", includeSubagents),
            ...boolArg("json", json),
            ...staleCheckArgs(noStaleCheck, staleThreshold),
        ]),
).pipe(Command.withDescription(
    "List sessions for the current git repository (default: last 14 days). "
    + "Subagent (claude-subagent) sessions are hidden by default - --include-subagents shows them; "
    + "--limit N caps the rows printed.",
));
```

**After** - in `commands/sessions.ts`:

```ts
interface StaleCheckOpts {
    readonly noStaleCheck: boolean;
    readonly staleThreshold: number | undefined;
}

const maybeAutoIngestStale = (
    cmdLabel: string,
    repoRoot: string,
    opts: StaleCheckOpts,
): Effect.Effect<void, DbError, SurrealClient | AxConfig | FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        if (opts.noStaleCheck) return;
        const threshold =
            requireOptionalPositiveInt(cmdLabel, "stale-threshold", opts.staleThreshold)
                ?? STALE_THRESHOLD_DEFAULT;
        // ... body from index.ts:3170-3212 verbatim (cfg lookup, detectStaleness,
        //     silent backfill vs warning, AUTO_BACKFILL_TIMEOUT_SECONDS timebox) ...
    });

interface SessionsHereInput {
    readonly days: number;
    readonly limit: number | undefined;
    readonly includeSubagents: boolean;
    readonly json: boolean;
    readonly staleCheck: StaleCheckOpts;
}

const cmdSessionsHere = (input: SessionsHereInput) =>
    Effect.gen(function* () {
        const days = requirePositiveInt("sessions here", "days", input.days);
        const json = wantsJsonFlag(input.json);
        const includeSubagents = input.includeSubagents;
        const limit = input.limit === undefined
            ? null
            : requirePositiveInt("sessions here", "limit", input.limit);

        const pwdResolution = yield* resolvePwdRepository().pipe(
            Effect.catchTag("NotAGitRepoError", (err) =>
                Effect.sync(() => {
                    process.stderr.write(
                        `axctl sessions here: not in a git repository (cwd=${err.cwd})\n`,
                    );
                    process.exit(2);
                }),
            ),
        );

        const repositoryKey = pwdResolution.repositoryRecordId.id as string;
        yield* maybeAutoIngestStale("sessions here", pwdResolution.repoRoot, input.staleCheck);
        const allRows = yield* listSessionsHere({ repositoryKey, days });
        // ... rest verbatim from index.ts:3237-3260 (subagent filter, limit slice,
        //     JSON vs formatSessionsTable + notes), with `json`/`limit`/
        //     `includeSubagents` referring to the locals above ...
    });

const sessionsHereCommand = Command.make(
    "here",
    {
        days: Flag.integer("days").pipe(Flag.withDefault(14)),
        limit: Flag.integer("limit").pipe(Flag.optional),
        includeSubagents: Flag.boolean("include-subagents").pipe(Flag.withDefault(false)),
        json: jsonFlag,
        noStaleCheck: noStaleCheckFlag,
        staleThreshold: staleThresholdFlag,
    },
    ({ days, limit, includeSubagents, json, noStaleCheck, staleThreshold }) =>
        cmdSessionsHere({
            days,
            limit: optionValue(limit),
            includeSubagents,
            json,
            staleCheck: { noStaleCheck, staleThreshold: optionValue(staleThreshold) },
        }),
).pipe(Command.withDescription(
    "List sessions for the current git repository (default: last 14 days). "
    + "Subagent (claude-subagent) sessions are hidden by default - --include-subagents shows them; "
    + "--limit N caps the rows printed.",
));
```

Note `wantsJsonFlag` (Task 1, in `cli/output.ts`): the old `wantsJson(args)` returned `--json present OR stdout not a TTY` - the auto-JSON-when-piped behavior must survive the typed conversion. Use `wantsJsonFlag(input.json)` everywhere the old handler called `wantsJson(args)`; use plain `input.json` where the old handler did `args.includes("--json")` only.

### Conversion map for every remaining typed conversion

(`F.x` = typed flag/argument value passed straight through; `RPI`/`ROPI` = `requirePositiveInt`/`requireOptionalPositiveInt`; `WJF` = `wantsJsonFlag`.)

| Handler | New input object | Validation / quirks to preserve |
|---|---|---|
| `cmdInsights` | `{ view: (typeof INSIGHT_VIEWS)[number]; limit: number; json: boolean }` | `RPI("insights","limit")`; drop `isInsightView` guard (dead - `Argument.choice` already restricts; leave a comment) |
| `cmdReport` | `{ limit: number; out: string \| undefined }` | `RPI("report","limit")` |
| `cmdDogfoodRuns` | `{ limit: number; json: boolean }` | `RPI("dogfood runs","limit")` |
| `cmdClassifiersExplain` | `{ turnId: string; json: boolean }` | drop missing-turn-id guard (required `Argument.string`); keep `useJson = json \|\| process.stdout.isTTY === false` (= `WJF`) |
| `cmdRetroEmit` | `{ session: string \| undefined; fromFile: string \| undefined; source: string \| undefined; json: boolean }` | `sessionFlag = input.session ?? process.env.AX_SESSION_ID`; `sourceFlag = (input.source ?? (fromFile ? "claude_stop_hook" : "heuristic")) as RetroSource` - verbatim logic, just no `flag()` calls |
| `cmdRetroList` | `{ limit: number; since: string \| undefined; json: boolean }` | `RPI("retro list","limit")`; keep `since ? \`WHERE created_at > time::now() - ${parseInt(since, 10) \|\| 7}d\` : ""` verbatim (string flag, garbage→7 quirk) |
| `cmdRetroPending` | `{ since: number; idleMin: number; limit: number; includeSubagents: boolean; json: boolean }` | preserve the `Math.max(1, parseInt(x,10) \|\| N)` quirks as `Math.max(1, input.since \|\| 7)`, `Math.max(1, input.idleMin \|\| 30)`, `Math.max(1, input.limit \|\| 20)` (0 falls back to the default, negatives clamp to 1 - identical to today through the round-trip) |
| `cmdRetroBrief` | `{ session: string; outDir: string \| undefined; json: boolean }` | drop missing `--session` guard (required `Flag.string`) with comment |
| `cmdImproveList` | `{ limit: number; form: string \| undefined; status: string \| undefined; json: boolean }` | `RPI("improve list","limit")`; `statusFilter = input.status ?? "open"` |
| `cmdImproveShow` | `{ id: string; json: boolean }` | drop missing-id guard (required Argument) |
| `cmdImproveLint` | `{ roots: ReadonlyArray<string>; json: boolean; staleDays: number }` | `RPI("improve lint","stale-days")`; `roots` comes straight from `Flag.string("root").pipe(Flag.atLeast(0))` |
| `cmdImproveRecommend` | `{ limit: number; forms: ReadonlyArray<string>; sinceDays: number \| undefined; json: boolean; noClipboard: boolean; apply: boolean }` | `RPI`/`ROPI`; preserve comma-splitting: `const forms = input.forms.flatMap((v) => v.split(",").map((s) => s.trim()).filter((s) => s.length > 0));` |
| `cmdImproveReject` | `{ id: string; reason: string \| undefined }` | `reason ?? "not_worth_packaging"` |
| `cmdImproveVerdict` | `{ id: string \| undefined; set: string \| undefined; json: boolean }` | delete the `--set` arg-scanning block (lines 2893–2899); `ALLOWED_VERDICTS` check + everything else verbatim |
| `cmdImproveReset` | `{ yes: boolean }` | `if (!input.yes) { ...same error block, exit 2 }` |
| `cmdImproveCheckpoint` | `{ force: boolean; json: boolean }` | direct |
| `cmdSessionsAround` | `{ date: string; days: number; project: string \| undefined; json: boolean }` | date-regex parsing verbatim on `input.date` (it is a required `Argument.string` - the missing-date guard is dead, delete with comment); `RPI("sessions around","days")`; `WJF` |
| `cmdSessionsNear` | `{ sha: string; json: boolean; staleCheck: StaleCheckOpts }` | drop missing-sha guard; `WJF`; pass `staleCheck` through to `maybeAutoIngestStale` |
| `cmdSessionShow` | `{ id: string; expand: ReadonlyArray<string>; all: boolean; byRole: boolean; json: boolean }` | `expandSet = new Set(input.expand.map((v) => v.trim()).filter((v) => v.length > 0))`; `useJson = WJF(input.json)`; drop missing-id guard |
| `cmdSessionsCompare` | `{ ids: ReadonlyArray<string>; turns: boolean; json: boolean }` | `Argument.variadic({ min: 2 })` makes the `< 2` guard dead - delete with comment; keep the post-fetch `payload.sessions.length < 2` check (still reachable: unknown ids); `WJF` |
| `cmdSearch` | `{ query: string; limit: number }` | registration passes `query.join(" ")`; `RPI("search","limit")`; keep the empty-query guard (a quoted empty string can still arrive) |
| `cmdStats` | `{ name: string }` | drop missing-name guard (required Argument) |
| `cmdRecent` | `{ limit: number }` | `RPI("recent","limit")` |
| `cmdUnused` | `{ days: number; includeScoped: boolean }` | `RPI("unused","days")` |
| `cmdSkillsByRole` | `{ role: string; limit: number; json: boolean }` | drop missing-role guard; `WJF`; `RPI("skills by-role","limit")` |
| `cmdRolesForSkill` | `{ skill: string; json: boolean }` | drop missing-skill guard; `WJF` |
| `cmdRoles` | `{ json: boolean }` | `WJF` |
| `cmdTaste` | `{ limit: number; includeTools: boolean }` | `RPI("taste","limit")` |
| `cmdPairs` | `{ name: string; limit: number }` | drop missing-name guard; `RPI("pairs","limit")` |
| `cmdRecovery` | `{ limit: number }` | `RPI("recovery","limit")` |
| `cmdDeriveSignals` | `{ sinceDays: number \| undefined; progress: ProgressMode; verbose: boolean }` | `Flag.choice` already validated progress - pass `mode: input.progress` into `createProgressReporter` (delete `progressModeFor`); `ROPI("derive-signals","since",input.sinceDays)` |
| `cmdIngestInsights` | `{ progress: ProgressMode; verbose: boolean }` | same progress treatment |

---

## 4. Tasks

### Task 1: Scaffold `commands/shared.ts` + `commands/manifest.ts`

**Files:**
- create `apps/axctl/src/cli/commands/manifest.ts` (full content in §2 above)
- create `apps/axctl/src/cli/commands/shared.ts`
- edit `apps/axctl/src/cli/output.ts` (add `wantsJsonFlag`)
- edit `apps/axctl/src/cli/index.ts` (delete moved helpers at 174–185, 242–251, 1726–1729, 5163–5167; import them from `./commands/shared.ts`)

Steps:

- [ ] Create `apps/axctl/src/cli/commands/manifest.ts` with the exact content from §2.
- [ ] Create `apps/axctl/src/cli/commands/shared.ts`:

```ts
/**
 * Shared helpers for the command-family modules under cli/commands/.
 * Extracted from cli/index.ts in the Phase 2 CLI split. Two kinds of helper
 * live here:
 *   - typed-flag plumbing (optionValue, requirePositiveInt, shared Flag specs)
 *   - string-array bridges (boolArg/intArg/stringArg) for registrations that
 *     delegate to external modules still taking `args: string[]`
 *     (share, project, retro reflect/meta/plan, dogfood terminal, version,
 *     update, daemon, classifiers eval/list, evidence).
 */
import { Option } from "effect";
import { Flag } from "effect/unstable/cli";

export const boolArg = (name: string, enabled: boolean): string[] =>
    enabled ? [`--${name}`] : [];

export const intArg = (name: string, value: number | undefined): string[] =>
    value === undefined ? [] : [`--${name}=${value}`];

export const stringArg = (name: string, value: string | undefined): string[] =>
    value === undefined ? [] : [`--${name}=${value}`];

export const optionValue = <A>(value: Option.Option<A>): A | undefined =>
    Option.getOrUndefined(value);

export const positiveLimit = (fallback: number) =>
    Flag.integer("limit").pipe(Flag.withDefault(fallback));
export const optionalSince = Flag.integer("since").pipe(Flag.optional);
export const jsonFlag = Flag.boolean("json").pipe(Flag.withDefault(false));

/**
 * Typed replacement for the old string-based parsePositiveIntFlag: the Effect
 * CLI parser already guarantees an integer; this preserves the positivity
 * check (and exact error wording + exit 2) that used to run on the rebuilt
 * string array. See issues #38, #45 for why bad values must not reach SQL.
 */
export function requirePositiveInt(cmd: string, flagName: string, n: number): number {
    if (!Number.isInteger(n) || n <= 0) {
        console.error(
            `axctl ${cmd}: --${flagName} must be a positive integer (got "${n}")`,
        );
        process.exit(2);
    }
    return n;
}

/** Optional-flag variant: absent stays absent; present must be a positive integer. */
export function requireOptionalPositiveInt(
    cmd: string,
    flagName: string,
    n: number | undefined,
): number | undefined {
    if (n === undefined) return undefined;
    return requirePositiveInt(cmd, flagName, n);
}

/**
 * Format a numeric counter with thousand-separators (issue #46). Keeps short
 * values short; long ones become e.g. `597,508` rather than blowing the
 * column.
 */
export function fmtCount(v: unknown): string {
    const n = Number(v ?? 0);
    if (!Number.isFinite(n)) return "0";
    return n.toLocaleString("en-US");
}

/** Split a comma-separated file-hint flag into trimmed non-empty entries. */
export const parseFileHints = (value: Option.Option<string>): readonly string[] =>
    (Option.getOrUndefined(value) ?? "")
        .split(",")
        .map((file) => file.trim())
        .filter((file) => file.length > 0);
```

- [ ] Add to `apps/axctl/src/cli/output.ts` (below `wantsJson`):

```ts
/**
 * Typed-flag variant of wantsJson: JSON when --json was passed OR stdout is
 * piped. Used by handlers converted off the string-array round-trip.
 */
export const wantsJsonFlag = (json: boolean): boolean =>
    json || process.stdout.isTTY === false;
```

- [ ] In `index.ts`: delete the now-duplicated declarations (`boolArg` 174–176, `intArg` 177–179, `stringArg` 180–182, `optionValue` 183–185, `fmtCount` 242–251, `positiveLimit`/`optionalSince`/`jsonFlag` 1726–1729, `parseFileHints` 5163–5167) and add `import { boolArg, intArg, stringArg, optionValue, fmtCount, positiveLimit, optionalSince, jsonFlag, parseFileHints } from "./commands/shared.ts";`. (`checkFlag`/`verboseFlag`/`debugFlag`/`progressFlag` 1730–1741 stay in index.ts for now - they move with their families.)
- [ ] `bun run typecheck` - green (prune any import the checker flags).
- [ ] `bun test apps/axctl` - green.
- [ ] Smoke: `bun apps/axctl/src/cli/index.ts skills weighted --limit=3` (or `skills --help` if DB down) - output unchanged.
- [ ] Commit:

```
refactor(cli): extract shared CLI helpers + runtime manifest types for command-family split

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

### Task 2 (pilot): `commands/report.ts` (`report`, `insights`, `timeline`) + derived DB_COMMANDS

This task proves all three patterns at small scale: verbatim move (`timeline`), typed conversion (`insights`, `report`), and the runtime manifest with `LEGACY_RUNTIME` shrinkage.

**Files:**
- create `apps/axctl/src/cli/commands/report.ts`
- edit `apps/axctl/src/cli/index.ts` (delete 608–643, 1920–1930, 4388–4395, 4872–4901; replace `DB_COMMANDS` literal 5752–5782)

Steps:

- [ ] Create `apps/axctl/src/cli/commands/report.ts` - full module:

```ts
/**
 * `ax report` / `ax insights` / `ax timeline` - one-shot read-only reporting
 * commands. Extracted from cli/index.ts (Phase 2 CLI split). Handlers take
 * typed option objects; no string-array round-trip.
 */
import { Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { Flag } from "effect/unstable/cli";
import { SurrealClient } from "@ax/lib/db";
import { INSIGHT_VIEWS, insightSqlForView } from "../../queries/insights.ts";
import { enrichInsightRows } from "../../queries/insights-enrich.ts";
import { formatInsightRows } from "../insights-format.ts";
import { writeDashboard } from "../../dashboard/report.ts";
import { extractSessionTimeline, SessionTimelineServiceLayer } from "../../timeline/service.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { fmtCount, jsonFlag, optionValue, positiveLimit, requirePositiveInt } from "./shared.ts";

type InsightView = (typeof INSIGHT_VIEWS)[number];

const cmdInsights = (input: { readonly view: InsightView; readonly limit: number; readonly json: boolean }) =>
    Effect.gen(function* () {
        // Argument.choice("view", INSIGHT_VIEWS) already rejected unknown views
        // at parse time - the old isInsightView/exit(2) guard was dead code
        // through the CLI and is intentionally gone.
        const limit = requirePositiveInt("insights", "limit", input.limit);
        const db = yield* SurrealClient;
        const result = yield* db.query<[Array<Record<string, unknown>>]>(
            insightSqlForView(input.view, limit),
        );
        // Classifier views resolve their per-row context here via indexed
        // lookups (the correlated $parent.session form scanned ~1s/row).
        const rows = yield* enrichInsightRows(input.view, result?.[0] ?? []);
        console.log(formatInsightRows(input.view, [...rows], { json: input.json }));
    });

const cmdReport = (input: { readonly limit: number; readonly out: string | undefined }) =>
    Effect.gen(function* () {
        const limit = requirePositiveInt("report", "limit", input.limit);
        const result = yield* writeDashboard({ out: input.out, limit });
        console.log(`report: ${result.url}`);
        console.log(
            `evidence: tools=${fmtCount(result.data.counts.toolCalls)} plans=${fmtCount(
                result.data.counts.planSnapshots,
            )} friction=${fmtCount(
                result.data.counts.frictionEvents,
            )} sessions=${fmtCount(result.data.counts.sessions)}`,
        );
    });

const insightView = Argument.choice("view", INSIGHT_VIEWS).pipe(Argument.withDefault("repositories"));

export const insightsCommand = Command.make(
    "insights",
    {
        view: insightView,
        limit: positiveLimit(20),
        json: jsonFlag,
    },
    ({ view, limit, json }) => cmdInsights({ view, limit, json }),
).pipe(Command.withDescription("Run built-in graph insight queries"));

export const reportCommand = Command.make(
    "report",
    {
        limit: positiveLimit(12),
        out: Flag.string("out").pipe(Flag.optional),
    },
    ({ limit, out }) => cmdReport({ limit, out: optionValue(out) }),
).pipe(Command.withDescription("Write a static evidence report (one-shot HTML snapshot)"));

// --- timeline: moved verbatim from cli/index.ts:4872-4901 ---

const cmdTimeline = (sessionId: string, json: boolean) =>
    extractSessionTimeline(sessionId).pipe(
        Effect.provide(SessionTimelineServiceLayer),
        Effect.flatMap((tl) =>
            Effect.sync(() => {
                // ... body verbatim from index.ts:4875-4892 ...
            })
        ),
    );

export const timelineCommand = Command.make(
    "timeline",
    { sessionId: Argument.string("session-id"), json: jsonFlag },
    ({ sessionId, json }) => cmdTimeline(sessionId, json),
).pipe(Command.withDescription(
    "Highlight/event timeline for a session (segments + ranked events, LLM-free). --json for the full structure.",
));

export const reportRuntime: RuntimeManifest = {
    report: "db",
    insights: "db",
    timeline: "db",
};
```

(The `cmdTimeline` inner body is a pure verbatim move of index.ts:4875–4892 - copy it whole; the elision above is only to keep this plan readable. `writeDashboard({ out: input.out, ... })` is fine under `exactOptionalPropertyTypes` only if `writeDashboard`'s `out` param already accepts `string | undefined` - it does today, since the old code passed `flag("out", args)` which is `string | undefined`.)

- [ ] In `index.ts`: delete the seven moved declarations; add `import { insightsCommand, reportCommand, timelineCommand, reportRuntime } from "./commands/report.ts";`. The `rootCommand` list keeps `Command.withHidden(insightsCommand)`, `Command.withHidden(reportCommand)`, `Command.withHidden(timelineCommand)` exactly as before (only the source of the consts changed).
- [ ] Replace the `DB_COMMANDS` literal (5752–5782) with the manifest derivation from §2. Initial `LEGACY_RUNTIME` (everything except this family):

```ts
import type { RuntimeManifest } from "./commands/manifest.ts";

// Names not yet migrated to a commands/<family>.ts module. Shrinks each task;
// deleted in the final cleanup task. Mirrors the legacy DB_COMMANDS exactly.
const LEGACY_RUNTIME: RuntimeManifest = {
    ingest: "ingest",
    derive: "db",
    "derive-signals": "db",
    "derive-intents": "db",
    classifiers: "db",
    sessions: "db",
    signals: "db",
    improve: "db",
    retro: "db",
    costs: "db",
    loc: "db",
    pricing: "db",
    recall: "db",
    skills: "db",
    roles: "db",
    project: "db",
    context: "db",
    hook: "db",
    hooks: "db",
    agents: "db",
    evidence: "db",
    tui: "db",
    dogfood: "db",
};

export const RUNTIME_BY_COMMAND: RuntimeManifest = {
    ...LEGACY_RUNTIME,
    ...reportRuntime,
};

// Commands whose handlers reach into SurrealClient via AppLayer. Anything
// outside this set runs through `withoutDb` so the user gets fast, honest
// errors (e.g. "unknown command") instead of a 5s connect timeout.
// Derived from family manifests - declare new commands there, not here.
export const DB_COMMANDS: ReadonlySet<string> = new Set(
    Object.entries(RUNTIME_BY_COMMAND)
        .filter(([, runtime]) => runtime === "db" || runtime === "ingest")
        .map(([name]) => name),
);
```

(`insights`/`report`/`timeline` came out of the legacy list because `reportRuntime` now supplies them. The derived set is content-identical to the old literal - all 26 names.)
- [ ] `bun run typecheck` green; prune index.ts imports flagged by `noUnusedLocals` (at minimum: `INSIGHT_VIEWS`/`insightSqlForView`/`isInsightView`, `enrichInsightRows`, `formatInsightRows`, `writeDashboard`, `extractSessionTimeline`/`SessionTimelineServiceLayer` - `isInsightView` import dies entirely).
- [ ] `bun test apps/axctl` green (effect-cli.test.ts asserts `insights` hidden + DB membership - both preserved).
- [ ] Smoke: `bun apps/axctl/src/cli/index.ts insights repositories --limit=3` and `bun apps/axctl/src/cli/index.ts insights bogus` (must fail with the CLI parser's choice error, exit non-zero).
- [ ] Commit:

```
refactor(cli): extract report/insights/timeline family; derive DB_COMMANDS from runtime manifests

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

### Tasks 3–13: small/medium families (one task each, identical recipe)

Each task follows the same recipe - listed once here, then per-task specifics:

- [ ] Create `apps/axctl/src/cli/commands/<family>.ts` with: header comment (`Extracted from cli/index.ts (Phase 2 CLI split)`), imports (copy the relevant lines from index.ts's import block, adjusting relative depth `../` → `../../` for src dirs, `./` → `../` for cli siblings, plus `./shared.ts` + `./manifest.ts`), the declarations from the inventory table **in their original relative order**, `export` on every `*Command` const the rootCommand references, and `export const <family>Runtime: RuntimeManifest = {...}`.
- [ ] Apply the typed conversions listed for the family in §3's conversion map (handlers get an input interface; registrations pass the typed object; `parsePositiveIntFlag` → `requirePositiveInt`, `args.includes("--x")` → `input.x`, `flag("x", args)` → `input.x`, `wantsJson(args)` → `wantsJsonFlag(input.json)`).
- [ ] In `index.ts`: delete the moved line ranges, add the family import, append `...<family>Runtime` to `RUNTIME_BY_COMMAND`, and remove the family's names from `LEGACY_RUNTIME`.
- [ ] `bun run typecheck` green (prune flagged imports in index.ts).
- [ ] `bun test apps/axctl` green.
- [ ] Family smoke (below).
- [ ] Commit `refactor(cli): extract <family> command family into cli/commands/<family>.ts` + trailer:

```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

Per-task specifics:

**Task 3 - `commands/signals.ts`** (inventory §1; pure moves, handlers already typed). Imports needed: `Effect` from `effect`; `Argument, Command` from `effect/unstable/cli`; `prettyPrint` from `@ax/lib/json`; `SIGNAL_CATALOG, findSignal, runRelationSignal` from `../../metrics/catalog.ts`; `cleanSessionId` from `../../metrics/util.ts`; `CascadeEdge` type from `../../metrics/fragility-cascade.ts`; `jsonFlag, positiveLimit` from `./shared.ts`. Manifest: `{ signals: "db" }`. Exports: `signalsCommand`, `signalsRuntime`. Smoke: `bun apps/axctl/src/cli/index.ts signals list`.

**Task 4 - `commands/evidence.ts`** (pure moves; string bridge to `../../self-improve/commands.ts` stays). Imports: `Effect`; `Command` from `effect/unstable/cli`; `prettyPrint`; `guidanceNext, parseSelfImproveArgs, selfImproveWeekly, sessionSummary` from `../../self-improve/commands.ts`; `boolArg, jsonFlag` from `./shared.ts`. Manifest: `{ evidence: "db" }`. Exports: `evidenceCommand`, `evidenceRuntime`. Smoke: `bun apps/axctl/src/cli/index.ts evidence session-summary`.

**Task 5 - `commands/context.ts`** (pure moves; `parseFileHints` comes from shared). Imports: `Effect`; `Argument, Command, Flag` from `effect/unstable/cli`; `prettyPrint`; `buildFileContextPack` from `../../context/file-context.ts`; `jsonFlag, parseFileHints` from `./shared.ts`. Manifest: `{ context: "db" }`. Exports: `contextCommand`, `contextRuntime`. Smoke: `bun apps/axctl/src/cli/index.ts context file "ingest pipeline" --json | head -5`.

**Task 6 - `commands/project.ts`** (pure moves; string bridge to `../project.ts` stays). Imports: `Command` from `effect/unstable/cli`; `cmdProject` from `../project.ts`; `boolArg, jsonFlag` from `./shared.ts`. Manifest: `{ project: "db" }`. Exports: `projectCommand`, `projectRuntime`. Smoke: `bun apps/axctl/src/cli/index.ts project context --json | head -5` (run inside the repo).

**Task 7 - `commands/serve.ts`** (`serve`, `mcp`, `tui`; pure moves - keep the mcp "deliberately NOT in DB_COMMANDS" comment and tui's dynamic-import comment). Imports: `Effect`; `Command, Flag` from `effect/unstable/cli`; `serveDashboard` from `../../dashboard/server.ts`; `serveMcp` from `../../mcp/server.ts` (tui's `../tui/index.tsx` import is dynamic inside the handler → becomes `../../tui/index.tsx`). Manifest: `{ serve: "none", mcp: "none", tui: "db" }`. Exports: `serveCommand`, `mcpCommand`, `tuiCommand`, `serveRuntime`. Smoke: `bun apps/axctl/src/cli/index.ts serve --help`.

**Task 8 - `commands/share.ts`** (pure move; `main()`'s `cmdShare(args.slice(1))` bypass and its `--help` reroute stay in index.ts untouched). Imports: `Effect`; `Argument, Command, Flag` from `effect/unstable/cli`; `cmdShare` from `../share.ts`; `boolArg` from `./shared.ts`. Manifest: `{ share: "none" }`. Exports: `shareCommand`, `shareRuntime`. Smoke: `bun apps/axctl/src/cli/index.ts share --help`.

**Task 9 - `commands/dogfood.ts`** (`cmdDogfoodRuns` typed per §3; terminal wrapper keeps its string bridge to `../../dogfood/wterm.ts`). Imports: `Effect`; `Command, Flag` from `effect/unstable/cli`; `SurrealClient` from `@ax/lib/db`; `prettyPrint`; `cmdDogfoodTerminal` from `../../dogfood/wterm.ts`; `boolArg, stringArg, optionValue, jsonFlag, positiveLimit, requirePositiveInt` from `./shared.ts`. Manifest: `{ dogfood: "db" }`. Exports: `dogfoodCommand`, `dogfoodRuntime`. Note: index.ts's `devOnlyCommands` (5582) now reads `import { dogfoodCommand, dogfoodRuntime } from "./commands/dogfood.ts";` - the `process.env.AX_DEV` check stays in index.ts so the existing AX_DEV re-import test keeps working. Smoke: `AX_DEV=1 bun apps/axctl/src/cli/index.ts dogfood runs --limit=3`.

**Task 10 - `commands/costs.ts`** (`costs`, `loc`, `pricing`; ALL pure moves - these handlers are already typed; this is the proof that late-era index.ts code already followed the target pattern). Imports: `Effect`; `Command, Flag` from `effect/unstable/cli`; `SurrealClient` from `@ax/lib/db`; `prettyPrint, surrealLiteral` from `@ax/lib/json`; `fetchCostSummary, type CostSummary` from `../../dashboard/cost-query.ts`; `fetchLocSummary, type LocSummary, type LocSelector` from `../../dashboard/loc-query.ts`; `resolvePwdRepository` from `../../pwd.ts`; `jsonFlag, optionalSince, optionValue, positiveLimit` from `./shared.ts`. Manifest: `{ costs: "db", loc: "db", pricing: "db" }`. Exports: `costsGroupCommand`, `locCommand`, `pricingCommand`, `costsRuntime`. Smoke: `bun apps/axctl/src/cli/index.ts costs summary --limit=3`.

**Task 11 - `commands/recall.ts`** (pure moves; `cmdRecall` already takes `RecallCliOpts`). Imports: `Effect, FileSystem` from `effect` (the `resolveScope` R-type references `FileSystem.FileSystem`); `Option` from `effect` (registration uses `Option.getOrNull`); `Argument, Command, Flag` from `effect/unstable/cli`; `SurrealClient` from `@ax/lib/db`; `ProcessService` from `@ax/lib/process`; `prettifyProjectSlug` from `@ax/lib/shared/project-slug`; `fetchRecall, type RecallSource, type RecallScope` from `../../dashboard/recall.ts`; `resolvePwdRepository` from `../../pwd.ts`; `DbError` type from `@ax/lib/errors`; `jsonFlag` from `./shared.ts`. (`resolveScope`'s inline `import("../pwd.ts")` type references become `import("../../pwd.ts")` - two occurrences, lines 682 and 697.) Manifest: `{ recall: "db" }`. Exports: `recallCommand`, `recallRuntime`. Smoke: `bun apps/axctl/src/cli/index.ts recall "ingest" --scope=all --json | head -5`.

**Task 12 - `commands/hooks.ts`** (`hook` + `hooks`; pure moves, handlers already typed inline). Imports: `Effect`; `Argument, Command, Flag` from `effect/unstable/cli`; `prettyPrint`; `buildFileContextHookResponse, parseFileContextHookFlags, parseFileContextHookStdin, type FileContextHookInput` from `../../hooks/file-context-hook.ts`; `recordHookFire` from `../../hooks/telemetry.ts`; `hooksConfigSubcommands` from `../../hooks/cli.ts`; `TelemetryHarness` type from `@ax/lib/telemetry-base`; `formatHookLogRowsTsv, queryHookLog` from `../../hooks/log.ts`; `formatHookInvocationRows, formatHookSummaryRows, queryHookInvocations, queryHookSession, queryHookSummary` from `../../queries/hooks.ts`; `backtestEnforceWorktreeCase, formatFeedbackBacktestSummary` from `../../queries/feedback-cases.ts`; `jsonFlag, optionValue, parseFileHints` from `./shared.ts`. Manifest: `{ hook: "db", hooks: "db" }`. Exports: `hookCommand`, `hooksCommand`, `hooksRuntime`. Smoke: `bun apps/axctl/src/cli/index.ts hooks summary --tail=3`.

**Task 13 - `commands/retro.ts`** (typed conversions for emit/list/pending/brief per §3 map; reflect/meta/plan keep string bridges to `../retro-reflect.ts` / `../retro-meta.ts` / `../retro-plan.ts`). Imports: `Effect, FileSystem, Path` from `effect`; `Command, Flag` from `effect/unstable/cli`; `SurrealClient` from `@ax/lib/db`; `prettyPrint` from `@ax/lib/json`; `safeJsonParse` from `@ax/lib/shared/safe-json`; `prettifyProjectSlug` from `@ax/lib/shared/project-slug`; `recordRef` from `@ax/lib/shared/surql`; `retroFromSession, upsertRetro, type RetroSource` from `../../ingest/retro.ts`; `cmdRetroReflect` from `../retro-reflect.ts`; `cmdRetroMeta` from `../retro-meta.ts`; `cmdRetroPlan` from `../retro-plan.ts`; `boolArg, stringArg, jsonFlag, optionValue, positiveLimit, requirePositiveInt` from `./shared.ts`. Manifest: `{ retro: "db" }`. Exports: `retroCommand`, `retroRuntime`. Smoke: `bun apps/axctl/src/cli/index.ts retro list --limit=3`.

### Task 14: `commands/improve.ts` (+ source-slicing test updates)

**Files:**
- create `apps/axctl/src/cli/commands/improve.ts`
- edit `apps/axctl/src/cli/index.ts` (delete 2517–3099 and 3816–3829; import `improveCommand, improveRuntime`)
- edit `apps/axctl/src/cli/recommend.test.ts` (path string)
- edit `apps/axctl/src/cli/lint.test.ts` (path string)

Steps:

- [ ] Create the module. Declaration order **must** be preserved from the inventory table (recommend/lint tests slice source text between `const improveRecommendCommand`, `const improveLintCommand`, `const improveListCommand` markers). Imports: `Effect` from `effect`; `Argument, Command, Flag` from `effect/unstable/cli`; `SurrealClient` from `@ax/lib/db`; `prettyPrint, surrealLiteral` from `@ax/lib/json`; `surrealString` from `@ax/lib/shared/surql`; `homedir` from `node:os`; `deriveCheckpoints` from `../../ingest/derive-checkpoints.ts`; `runAgentAccept` from `../../improve/agent-accept.ts`; `acceptProposal, rejectProposal` from `../../improve/actions.ts`; `lintFiles` from `../../improve/lint.ts`; `listProposals, type ProposalRow` from `../../improve/list.ts`; `recommend, formatRecommendations, copyToClipboard, selectByIndices, parseIndexInput` from `../../improve/recommend.ts`; `showExperiment, formatShow` from `../../improve/show.ts`; `jsonFlag, optionValue, positiveLimit, requirePositiveInt, requireOptionalPositiveInt, stringArg` from `./shared.ts` (drop `stringArg` if the typed conversions leave it unused - typecheck decides).
- [ ] Apply the eight typed conversions from §3's map. The exported surface: `export const improveCommand`, `export const improveRuntime: RuntimeManifest = { improve: "db" };`. Note `improveRecommendCommand`'s flag spec uses literal `Flag.integer("limit")`/`Flag.boolean("json")` (not the shared specs) - keep them literal so `recommend.test.ts`'s `toContain('Flag.integer("limit")')` assertions still match.
- [ ] `recommend.test.ts:6`: `readFileSync("apps/axctl/src/cli/index.ts", ...)` → `readFileSync("apps/axctl/src/cli/commands/improve.ts", ...)`.
- [ ] `lint.test.ts:9`: same path swap. Its `toContain('json: jsonFlag')` assertion keeps matching because the moved registration still reads `json: jsonFlag` (imported from shared). Leave the AX_E2E_DB-gated spawn test untouched (it invokes `src/cli/index.ts improve lint`, which still works).
- [ ] index.ts edits + manifest spread + LEGACY_RUNTIME removal of `improve`.
- [ ] `bun run typecheck`; `bun test apps/axctl`; smoke: `bun apps/axctl/src/cli/index.ts improve list --limit=3`.
- [ ] Commit: `refactor(cli): extract improve command family into cli/commands/improve.ts` + trailer.

### Task 15: `commands/sessions.ts`

**Files:**
- create `apps/axctl/src/cli/commands/sessions.ts`
- edit `apps/axctl/src/cli/index.ts` (delete 3101–3750)

Steps:

- [ ] Create the module per the inventory table. Showcase B (§3) gives the full `here` + `maybeAutoIngestStale` conversion; apply the §3 map to `around`/`near`/`show`/`compare`. `cmdSessionsMetrics` + its registration move verbatim (already typed). Imports: `Effect, FileSystem, Option, Path` from `effect`; `Argument, Command, Flag` from `effect/unstable/cli`; `SurrealClient` from `@ax/lib/db`; `AxConfig` from `@ax/lib/config`; `prettyPrint` from `@ax/lib/json`; `prettifyProjectSlug` from `@ax/lib/shared/project-slug`; `listSessionsHere, listSessionsAround, listSessionsNear, type SessionRow` from `../../dashboard/sessions-query.ts`; `findCommitWindow` from `@ax/lib/git-window`; `fetchSessionShow` from `../../dashboard/session-show.ts`; `fetchSessionCompare` from `../../dashboard/session-compare.ts`; `fetchSessionMetrics` from `../../metrics/session-metrics-query.ts`; the aggregates block (`AGGREGATE_LEGEND, GROUP_BY_KEYS, aggregateGroups, applyAggregateFilters, computeSkillEfficacy, fetchAggregateRows, fetchSkillSessionSet, formatGroupAggregates, formatSkillEfficacy, type GroupByKey`) from `../../metrics/aggregates.ts`; `fetchSessionDurabilityDetail` from `../../metrics/reverted-commits.ts`; `formatSessionMetrics, SESSION_METRICS_LEGEND` from `../../metrics/util.ts`; `renderSessionMarkdown, renderSessionJson` from `../session-show-format.ts`; `renderCompareTable, renderCompareJson` from `../session-compare-format.ts`; `resolvePwdRepository` from `../../pwd.ts`; `detectStaleness` from `@ax/lib/transcript-staleness`; `ingestTranscripts` from `../../ingest/transcripts.ts`; `encodeClaudeProjectSlug` from `@ax/lib/transcript-locator`; `DbError` type from `@ax/lib/errors`; `catchDbErrorAndExit, wantsJsonFlag` from `../output.ts`; `jsonFlag, optionalSince, optionValue, positiveLimit, requirePositiveInt, requireOptionalPositiveInt` from `./shared.ts`.
- [ ] Delete `staleCheckArgs` (replaced by `StaleCheckOpts`); `noStaleCheckFlag`/`staleThresholdFlag` move with the family.
- [ ] Exports: `sessionsCommand`, `sessionsRuntime: RuntimeManifest = { sessions: "db" }`. index.ts edits + LEGACY shrink.
- [ ] `bun run typecheck`; `bun test apps/axctl`.
- [ ] Smoke: `bun apps/axctl/src/cli/index.ts sessions metrics --limit=3` AND (inside the repo) `bun apps/axctl/src/cli/index.ts sessions here --days=7 --limit=3 --no-stale-check` - confirms the typed stale-check plumbing (`--no-stale-check` must still be accepted).
- [ ] Commit: `refactor(cli): extract sessions command family into cli/commands/sessions.ts` + trailer.

### Task 16: `commands/skills.ts` (`skills` + `roles`)

**Files:**
- create `apps/axctl/src/cli/commands/skills.ts`
- edit `apps/axctl/src/cli/index.ts` (delete 940–1724 minus the flag-spec block 1726–1741 remnants, plus 4827–4834, 4866–4870, 4903–5115)

Steps:

- [ ] ⚠ **Merge-conflict hotspot:** if Phase 1 (queries extraction) already landed, `cmdStats` and `cmdUnused` bodies now call into `apps/axctl/src/queries/` instead of holding inline SQL, and all line numbers in this region shifted. Locate by name; move whatever the current bodies are; the typed-conversion signature change is identical either way (`{ name }` / `{ days, includeScoped }`).
- [ ] Create the module per the inventory table, original order. Apply §3 map conversions (12 handlers) - showcase A (§3) is the worked example. Imports: `Effect, FileSystem, Path` from `effect`; `Argument, Command, Flag` from `effect/unstable/cli`; `SurrealClient` from `@ax/lib/db`; `prettyPrint` from `@ax/lib/json`; `prettifyProjectSlug` from `@ax/lib/shared/project-slug`; `orAbsent` from `@ax/lib/shared/fs-error`; `loadAgentScopeMap` from `../../ingest/agent-scope.ts`; `fetchSkillsWeighted` from `../../dashboard/skills-weighted.ts`; `renderWeightedTable, renderWeightedJson` from `../skills-weighted-format.ts`; `fetchSkillsByRole, fetchRolesForSkill, fetchAllRoles` from `../../dashboard/role-queries.ts`; the six `render*` role formatters from `../role-format.ts`; `cmdSkillsClassify` from `../skills-classify.ts`; `cmdSkillsTag` from `../skills-tag.ts`; `cmdSkillsLint` from `../skills-lint.ts`; `skillsConfigSubcommands` from `../../skills/cli.ts`; `catchDbErrorAndExit, wantsJsonFlag` from `../output.ts`; `fmtCount, jsonFlag, optionValue, positiveLimit, requirePositiveInt, requireOptionalPositiveInt` from `./shared.ts`.
- [ ] Exports: `skillsCommand`, `rolesCommand`, `skillsRuntime: RuntimeManifest = { skills: "db", roles: "db" }`. index.ts edits + LEGACY shrink (`skills`, `roles`).
- [ ] `bun run typecheck`; `bun test apps/axctl` (effect-cli.test.ts asserts the skills subcommand names - all preserved).
- [ ] Smoke: `bun apps/axctl/src/cli/index.ts skills weighted --limit=3` and `bun apps/axctl/src/cli/index.ts roles`.
- [ ] Commit: `refactor(cli): extract skills+roles command family into cli/commands/skills.ts` + trailer.

### Task 17: `commands/classifiers.ts`

**Files:**
- create `apps/axctl/src/cli/commands/classifiers.ts`
- edit `apps/axctl/src/cli/index.ts` (delete 1932–2515 and 5784–5791; re-export predicate)

Steps:

- [ ] Create the module per the inventory table. The five big registrations (`package-operations`, `graph`, `lifecycle`, `workflow-candidates`, `label-mining`) move **verbatim** - their handlers already build typed option objects for `runClassifiers*`/`LabelMiningService`. Only `cmdClassifiersExplain` gets the §3 typed conversion. Imports: `Effect, Option` from `effect`; `Argument, Command, Flag` from `effect/unstable/cli`; the whole `./classifiers-*` import cluster from index.ts lines 32–61 with `./` → `../` (eval, list, package-operations runners + workflow-candidates runner + its 8 types, explain formatters); `ClassifierPackageServiceLive` from `../../classifiers/package-service.ts`; `LabelMiningService, LabelMiningServiceLive, renderGraphProjectionText, renderSelfImproveText` from `../../classifiers/label-mining-service.ts`; `fetchClassifierExplain` from `../../dashboard/classifier-explain.ts`; `catchDbErrorAndExit` from `../output.ts`; `boolArg, stringArg, jsonFlag, optionValue, positiveLimit` from `./shared.ts`.
- [ ] Move `classifiersPackageOperationsNeedsDb` here, exported. In index.ts add `export { classifiersPackageOperationsNeedsDb } from "./commands/classifiers.ts";` **and** `import { classifiersCommand, classifiersRuntime, classifiersPackageOperationsNeedsDb } from "./commands/classifiers.ts";` (main() calls it).
- [ ] Exports: `classifiersCommand`, `classifiersRuntime: RuntimeManifest = { classifiers: "db" }`, `classifiersPackageOperationsNeedsDb`. main()'s classifiers branches (5832–5844) stay verbatim. LEGACY shrink.
- [ ] `bun run typecheck`; `bun test apps/axctl` (classifiers-label-mining.test.ts walks `rootCommand`; effect-cli.test.ts exercises the predicate - both keep passing via the re-export).
- [ ] Smoke: `bun apps/axctl/src/cli/index.ts classifiers list`.
- [ ] Commit: `refactor(cli): extract classifiers command family into cli/commands/classifiers.ts` + trailer.

### Task 18: `commands/ingest.ts` (`ingest`, `derive`, `derive-signals`, `derive-intents`)

The riskiest family: LaunchAgent plists invoke `derive-signals`/`derive-intents` by exact name, `main()` has an ingest pre-dispatch branch, and three exported symbols are test contracts.

**Files:**
- create `apps/axctl/src/cli/commands/ingest.ts`
- edit `apps/axctl/src/cli/index.ts` (delete 253–361, 363–423, 425–606, 1731–1741 (the family flags `verboseFlag`/`debugFlag`/`progressFlag`; `checkFlag` at 1730 stays for Task 19), 1743–1918; add imports + re-exports)

Steps:

- [ ] Create the module per the inventory table. `cmdIngest`/`cmdIngestHere` keep `args: string[]` with this comment above `cmdIngest`:

```ts
// EXCEPTION to the typed-options rule: runIngest({ args }) forwards raw CLI
// args into the stage pipeline (src/ingest/run.ts does its own --stages/
// --since/--reset parsing). Until runIngest grows a typed options contract,
// the ingest handlers stay on string args; the Command handlers below build
// them from typed flags exactly as before.
```

- [ ] Apply the §3 typed conversions to `cmdDeriveSignals` / `cmdIngestInsights` (delete `progressModeFor`; `handleDeriveSignals` now calls `cmdDeriveSignals({ sinceDays: optionValue(since), progress, verbose })`; the `ingestCommand` `--insights-only` branch calls `cmdIngestInsights({ progress, verbose })` - note today's string path also forwarded `--debug` to `cmdIngestInsights`, which never reads it; drop it). The `createProgressReporter({ mode: input.progress, ... })` call sites replace `progressModeFor(...)` results - `ProgressMode` type imports from `../progress.ts`.
- [ ] Imports: `Effect, Layer, Option, Path, References` from `effect`; `BunFileSystem, BunPath` from `@effect/platform-bun`; `Argument` not needed - `Command, Flag` from `effect/unstable/cli`; `SurrealClient, type SurrealClientShape` from `@ax/lib/db`; `AxConfig` from `@ax/lib/config`; `ProcessService` from `@ax/lib/process`; `prettyPrint` from `@ax/lib/json`; `DbError` type from `@ax/lib/errors`; `runIngest` from `../../ingest/run.ts`; `withIngestLock` from `../../ingest/ingest-lock.ts`; `StageRegistry, type StageRegistryShape` from `../../ingest/stage/registry.ts`; `selectByKeys, selectByTag` from `../../ingest/stage/select.ts`; `type BaseStageStats, type StageDef` from `../../ingest/stage/types.ts`; `resolvePwdRepository` from `../../pwd.ts`; `encodeClaudeProjectSlug` from `@ax/lib/transcript-locator`; `estimateIngest, formatDryRun` from `../../ingest/dry-run.ts`; `deriveSignals` from `../../ingest/derive-signals.ts`; `deriveTurnIntents` from `../../ingest/derive-intents.ts`; `ingestClaudeInsights` from `../../ingest/claude-insights.ts`; `createProgressReporter, type ProgressMode, type ProgressReporter` from `../progress.ts`; the five `buildIngest*Statement` + `makeIngestEvent, publishIngestEvent` from `../../dashboard/telemetry.ts`; `boolArg, intArg, stringArg, jsonFlag, optionalSince, optionValue, requireOptionalPositiveInt` from `./shared.ts`.
- [ ] Exports: `ingestCommand`, `deriveCommand`, `deriveSignalsCommand`, `deriveIntentsCommand`, `resolveIngestStages`, `detectRemovedIngestFlag`, `insightsOnlyConflicts`, `ingestRuntime: RuntimeManifest = { ingest: "ingest", derive: "db", "derive-signals": "db", "derive-intents": "db" }`.
- [ ] index.ts: import the four commands + the runtime + `detectRemovedIngestFlag` (main() uses it); add `export { resolveIngestStages, detectRemovedIngestFlag, insightsOnlyConflicts } from "./commands/ingest.ts";` so `effect-cli.test.ts` stays untouched. `withIngest`/`resolveProgressStages` stay in index.ts (they import `ALL_STAGES` + the trace transports - unchanged). LEGACY shrink (4 names).
- [ ] `bun run typecheck`; `bun test apps/axctl` (effect-cli.test.ts's `resolveIngestStages`/`detectRemovedIngestFlag`/`insightsOnlyConflicts` suites now run against the re-exports).
- [ ] Smoke: `bun apps/axctl/src/cli/index.ts ingest --dry-run` (estimate + exit, no full ingest), `bun apps/axctl/src/cli/index.ts ingest --skills-only` (must print the removed-flag error, exit 2), `bun apps/axctl/src/cli/index.ts derive-signals --help` (LaunchAgent name intact).
- [ ] Commit: `refactor(cli): extract ingest+derive command family into cli/commands/ingest.ts` + trailer.

### Task 19: `commands/lifecycle.ts` (`version`, `update`, `install`, `setup`, `daemon`, `doctor`, `uninstall`)

**Files:**
- create `apps/axctl/src/cli/commands/lifecycle.ts`
- edit `apps/axctl/src/cli/index.ts` (delete 1730, 5472–5580)

Steps:

- [ ] Create the module per the inventory table - all pure moves with string bridges (`printVersion`/`updateAxctl`/`cmdDaemon`/`cmdDoctor` take string arrays in `../version.ts` / `../install.ts`; `cmdInstall`/`cmdSetup`/`cmdUninstall` are already typed). `checkFlag` and `bannerFlag` move here. Imports: `Effect` from `effect`; `Command, Flag` from `effect/unstable/cli`; `cmdDaemon, cmdDoctor, cmdInstall, cmdSetup, cmdUninstall` from `../install.ts`; `liveVersionDeps, printVersion, updateAxctl` from `../version.ts` (`AX_VERSION` stays imported by index.ts for `runCli`/banner); `boolArg, jsonFlag` from `./shared.ts`.
- [ ] Exports: `versionCommand`, `updateCommand`, `installCommand`, `setupCommand`, `daemonCommand`, `doctorCommand`, `uninstallCommand`, `lifecycleRuntime: RuntimeManifest = { version: "none", update: "none", install: "none", setup: "none", daemon: "none", doctor: "none", uninstall: "none" }`.
- [ ] index.ts edits + manifest spread. `LEGACY_RUNTIME` should now contain only `{ agents: "db" }`.
- [ ] `bun run typecheck`; `bun test apps/axctl` (install*.test.ts and version.test.ts target `../install.ts`/`../version.ts` directly - unaffected).
- [ ] Smoke: `bun apps/axctl/src/cli/index.ts version --json` and `bun apps/axctl/src/cli/index.ts doctor --json | head -5`.
- [ ] Commit: `refactor(cli): extract lifecycle command family into cli/commands/lifecycle.ts` + trailer.

### Task 20: Final cleanup + anti-drift guard

**Files:**
- edit `apps/axctl/src/cli/index.ts`
- edit `apps/axctl/src/agents/cli.ts`
- edit `apps/axctl/src/cli/effect-cli.test.ts`

Steps:

- [ ] `apps/axctl/src/agents/cli.ts`: add at the bottom:

```ts
import type { RuntimeManifest } from "../cli/commands/manifest.ts";

/** Routing declaration consumed by cli/index.ts (Phase 2 command-family split). */
export const agentsRuntime: RuntimeManifest = { agents: "db" };
```

(Top-of-file import goes with the existing imports; shown together here for clarity.)
- [ ] index.ts: delete `LEGACY_RUNTIME` entirely; `RUNTIME_BY_COMMAND` becomes the spread of exactly the 18 family manifests + `agentsRuntime`. Export `RUNTIME_BY_COMMAND`.
- [ ] index.ts: delete the now-dead string helpers `flag` (186–190), `parsePositiveIntFlag` (191–219), `parseOptionalPositiveIntFlag` (221–240) - every consumer was converted or moved. If `bun run typecheck` flags any other dead import/helper left behind by Tasks 2–19, delete it now.
- [ ] `effect-cli.test.ts`: add the exhaustiveness test from §2 (import `RUNTIME_BY_COMMAND` alongside the existing index.ts imports).
- [ ] Sanity-check the shrink: `wc -l apps/axctl/src/cli/index.ts` - expected ≈300–450 lines (shebang, imports, `devOnlyCommands`, `rootCommand` assembly with visibility policy, `runCli`, `withDb`/`withIngest`/`withoutDb` + `resolveProgressStages`, manifest spread + `DB_COMMANDS`, `main()`, `import.meta.main`).
- [ ] Full gate: `bun run typecheck` green; `bun test apps/axctl` green; `bun test` (repo-wide) green.
- [ ] Final smoke sweep: `bun apps/axctl/src/cli/index.ts --help` (visible set unchanged: ingest, sessions, improve, retro, recall, skills, signals, roles, hooks, serve, mcp, tui, share, install, setup), `bun apps/axctl/src/cli/index.ts nonexistent-cmd` (fast failure, no DB timeout), `bun apps/axctl/src/cli/index.ts sessions here --days=3 --limit=2 --no-stale-check`.
- [ ] Commit:

```
refactor(cli): finish command-family split - derive all routing from family manifests

index.ts is now imports + rootCommand assembly + runtime triage. DB_COMMANDS
is derived from per-family RuntimeManifest declarations and guarded by an
exhaustiveness test against rootCommand.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## 5. Risks & merge-conflict hotspots

- **Phase 1 overlap (`cmdStats`, `cmdUnused`):** Phase 1 moves their inline SQL into `apps/axctl/src/queries/`. This plan moves the functions *as they stand*. If Phase 1 lands first: bodies are smaller, line numbers shift - locate by name (Task 16 step 1 warning). If this plan lands first: Phase 1's extraction targets `commands/skills.ts` instead of `index.ts` - flag this to whoever rebases Phase 1.
- **Source-text tests:** `recommend.test.ts` and `lint.test.ts` grep index.ts source. Handled in Task 14; any *other* new test that greps `cli/index.ts` source added between plan time and execution must be re-pointed the same way (search `rg -l 'cli/index.ts' apps/axctl/src` before Task 14).
- **`AX_DEV` re-import test:** `effect-cli.test.ts` re-imports `./index.ts?ax_dev=...` to rebuild `rootCommand` - works as long as the `process.env.AX_DEV` check stays at index.ts module scope (it does; Task 9).
- **Stale DB during smokes:** the local watcher daemon (`ax-watch`) can wedge SurrealDB mid-ingest. If a DB smoke hangs, do not retry-loop - check `ax daemon status`, fall back to the `--help` smoke, and note it in the task report.
- **Effect CLI typing of moved registrations:** moving a `Command.make(...)` const does not change its inferred type, but the handler `R` (services) must still unify within each `Command.withSubcommands` group. All handlers in a family already unified inside index.ts today; moving whole families preserves the same unification sets. The one delicate spot is `ingestCommand`'s `as ReturnType<typeof cmdIngest>` cast on the dry-run branch (index.ts:1815) - keep it verbatim.

## 6. Execution order recap

1. shared + manifest scaffold → 2. **pilot: report** (+ DB_COMMANDS derivation) → 3. signals → 4. evidence → 5. context → 6. project → 7. serve → 8. share → 9. dogfood → 10. costs → 11. recall → 12. hooks → 13. retro → 14. improve → 15. sessions → 16. skills+roles → 17. classifiers → 18. ingest+derive → 19. lifecycle → 20. cleanup + guard test.
