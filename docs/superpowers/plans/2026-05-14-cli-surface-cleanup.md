# CLI Surface Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shrink `axctl` top-level surface from 27 commands to 13 by grouping skill queries, collapsing evidence wrappers, folding onboarding into doctor, demoting `ingest-insights` to a flag, and hiding `dogfood` behind `AX_DEV=1`. Hard break - no deprecation aliases.

**Architecture:** All cuts are mounting changes in `src/cli/index.ts`. Underlying handlers (`cmdSearch`, `cmdStats`, `cmdIngestInsights`, `jsonSelfImprove`, `buildOnboardingReport`, `cmdDogfoodTerminal`) stay intact; only their CLI command wrappers + the root `withSubcommands` list move. `effect-cli.test.ts` locks the new shape. Non-CLI call-sites (dogfood wterm scenarios, bench script, README) get string updates.

**Tech Stack:** TypeScript strict, bun ≥ 1.3, `effect@beta` v4 CLI module (`effect/unstable/cli`), `bun:test`. SurrealDB unchanged.

**Final top-level surface (13):**
```
ingest, derive-signals, insights, interventions, dashboard,
recall, skills, project, evidence,
version, update, tui,
install, daemon, doctor, uninstall
```
(`dogfood` only when `AX_DEV=1`.)

---

## File Structure

**Modified files:**
- `src/cli/index.ts` - restructure `rootCommand` subcommands; add `skillsCommand`, `evidenceCommand`; remove `onboardingCommand`, `ingestInsightsCommand`, `dogfoodCommand` from default mount; extend `ingestCommand` with `--insights` flag; update `noDbCommands` set.
- `src/cli/install.ts` - extend `collectDoctorReport()` to include onboarding checks; `formatDoctorReport` renders them.
- `src/cli/onboarding.test.ts` - drop `axctl onboarding --json` string assertion (the helper module stays; only the top-level command goes away).
- `src/cli/effect-cli.test.ts` - lock new top-level names; assert removed commands are gone.
- `src/dogfood/wterm.ts` - scenario commands updated from `axctl onboarding --json` to `axctl doctor --json`.
- `src/dogfood/wterm.test.ts` - assertions updated.
- `src/self-improve/commands.test.ts` - test names + parser expectations reflect `axctl evidence <sub>` shape.
- `scripts/bench-empty-db.sh` - `ingest-insights` → `ingest --insights-only`.
- `README.md` - all command references updated to new surface.

**Untouched (still exists, still imported):** `src/cli/onboarding.ts` helpers (`buildOnboardingReport`, `formatOnboardingReport`, `formatInstallOnboardingGuidance`) - consumed by `install.ts` and new doctor path. `src/dogfood/wterm.ts` - only string content changes.

---

## Task 1: Lock new top-level surface in test (red)

**Files:**
- Modify: `src/cli/effect-cli.test.ts`

- [ ] **Step 1: Rewrite the surface test**

Replace the entire file with:

```ts
import { describe, expect, test } from "bun:test";
import { rootCommand } from "./index.ts";

const topLevelNames = (): string[] =>
    rootCommand.subcommands.flatMap((group) =>
        group.commands.map((command) => command.name),
    );

describe("effect cli", () => {
    test("root command exposes the canonical public subcommands", () => {
        const names = topLevelNames();

        expect(names).toEqual(expect.arrayContaining([
            "ingest",
            "derive-signals",
            "insights",
            "interventions",
            "dashboard",
            "recall",
            "skills",
            "project",
            "evidence",
            "version",
            "update",
            "tui",
            "install",
            "daemon",
            "doctor",
            "uninstall",
        ]));
    });

    test("retired top-level commands are gone", () => {
        const names = topLevelNames();

        for (const removed of ["onboarding", "ingest-insights", "search", "stats", "recent", "unused", "taste", "pairs", "recovery", "guidance", "session", "self-improve"]) {
            expect(names).not.toContain(removed);
        }
    });

    test("dogfood is hidden by default", () => {
        const names = topLevelNames();
        expect(names).not.toContain("dogfood");
    });

    test("skills group exposes the moved query subcommands", () => {
        const skills = rootCommand.subcommands
            .flatMap((g) => g.commands)
            .find((c) => c.name === "skills");
        expect(skills).toBeDefined();
        const subNames = skills!.subcommands.flatMap((g) => g.commands.map((c) => c.name));
        expect(subNames).toEqual(expect.arrayContaining([
            "search", "stats", "recent", "unused", "taste", "pairs", "recovery",
        ]));
    });

    test("evidence group exposes guidance/session/weekly", () => {
        const evidence = rootCommand.subcommands
            .flatMap((g) => g.commands)
            .find((c) => c.name === "evidence");
        expect(evidence).toBeDefined();
        const subNames = evidence!.subcommands.flatMap((g) => g.commands.map((c) => c.name));
        expect(subNames).toEqual(expect.arrayContaining([
            "guidance-next", "session-summary", "weekly",
        ]));
    });
});
```

- [ ] **Step 2: Run test, confirm RED**

Run: `bun test src/cli/effect-cli.test.ts`
Expected: FAIL - `skills`, `evidence`, `derive-signals`, `interventions`, `recall`, `tui` not present in arrayContaining (some present, some missing); retired-command assertions fail because `onboarding`, `search`, etc. still exist.

- [ ] **Step 3: Commit failing test**

```bash
git add src/cli/effect-cli.test.ts
git commit -m "test(cli): lock new top-level surface (red)"
```

---

## Task 2: Build `skills` subcommand group

**Files:**
- Modify: `src/cli/index.ts:1557-1626` (existing standalone `searchCommand`..`recoveryCommand`), `1772-1803` (root `withSubcommands`)

- [ ] **Step 1: Convert standalone commands into `skills` subcommands**

In `src/cli/index.ts`, replace the seven standalone `Command.make("search"|"stats"|"recent"|"unused"|"taste"|"pairs"|"recovery"...)` blocks (lines ~1557–1626) with the same `Command.make` definitions but with `Command.withSubcommands` mounting them under a new parent. Concretely:

After `recoveryCommand` definition, add:

```ts
const skillsCommand = Command.make("skills").pipe(
    Command.withDescription("Skill-graph queries: search, stats, usage, pairs, recovery"),
    Command.withSubcommands([
        searchCommand,
        statsCommand,
        recentCommand,
        unusedCommand,
        tasteCommand,
        pairsCommand,
        recoveryCommand,
    ]),
);
```

Leave the seven inner command definitions untouched - they are now reachable only through `skillsCommand`.

- [ ] **Step 2: Drop the seven names from root, add `skillsCommand`**

In `rootCommand`'s `withSubcommands` array (lines ~1774–1802), delete `searchCommand`, `recentCommand`, `statsCommand`, `unusedCommand`, `tasteCommand`, `pairsCommand`, `recoveryCommand`. Insert `skillsCommand` in their place (keep `recallCommand` at top level - it's BM25 over turns, not a skill query).

- [ ] **Step 3: Run the surface test, expect partial progress**

Run: `bun test src/cli/effect-cli.test.ts -t "skills group"`
Expected: PASS for the "skills group" test. The other tests still fail (evidence/doctor/etc. unchanged).

- [ ] **Step 4: Commit**

```bash
git add src/cli/index.ts
git commit -m "refactor(cli): group skill queries under axctl skills"
```

---

## Task 3: Build `evidence` subcommand group

**Files:**
- Modify: `src/cli/index.ts:1651-1694` (existing `guidanceCommand`/`sessionCommand`/`selfImproveCommand`), root `withSubcommands` list

- [ ] **Step 1: Replace three groups with one `evidence` group**

In `src/cli/index.ts`, delete the existing `guidanceNextCommand`, `guidanceCommand`, `sessionSummaryCommand`, `sessionCommand`, `selfImproveWeeklyCommand`, `selfImproveCommand` definitions (lines ~1663–1694) and replace with:

```ts
const evidenceGuidanceNextCommand = Command.make(
    "guidance-next",
    { json: jsonFlag },
    ({ json }) => jsonSelfImprove("guidance", ["next", ...boolArg("json", json)]),
).pipe(Command.withDescription("Return the next self-improvement guidance"));

const evidenceSessionSummaryCommand = Command.make(
    "session-summary",
    { json: jsonFlag },
    ({ json }) => jsonSelfImprove("session", ["summary", ...boolArg("json", json)]),
).pipe(Command.withDescription("Summarize recent session evidence"));

const evidenceWeeklyCommand = Command.make(
    "weekly",
    { json: jsonFlag },
    ({ json }) => jsonSelfImprove("self-improve", ["weekly", ...boolArg("json", json)]),
).pipe(Command.withDescription("Run weekly self-improvement evidence query"));

const evidenceCommand = Command.make("evidence").pipe(
    Command.withDescription("Self-improvement evidence queries (guidance, session, weekly)"),
    Command.withSubcommands([
        evidenceGuidanceNextCommand,
        evidenceSessionSummaryCommand,
        evidenceWeeklyCommand,
    ]),
);
```

- [ ] **Step 2: Update root subcommand list**

In `rootCommand`'s `withSubcommands` array, remove `guidanceCommand`, `sessionCommand`, `selfImproveCommand`. Add `evidenceCommand`.

- [ ] **Step 3: Update `parseSelfImproveArgs` consumer test names**

Open `src/self-improve/commands.test.ts`. Rename test bodies/strings that refer to the old shape so the human-readable `describe` labels mention `evidence guidance-next`, `evidence session-summary`, `evidence weekly`. The argv parser itself unchanged (still receives the same `["next", "--json"]` array from `jsonSelfImprove`), so assertions on `parsed.command` keep their existing values.

Show the diff for that test file before/after:

Before (top of `commands.test.ts`):
```ts
test("guidance next requires json flag for machine output", () => {
```
After:
```ts
test("evidence guidance-next requires json flag for machine output", () => {
```

Apply analogous renames to the `session summary` and `self-improve weekly` test names.

- [ ] **Step 4: Run tests**

Run: `bun test src/cli/effect-cli.test.ts src/self-improve/commands.test.ts`
Expected: "evidence group" test PASS; other surface tests still fail; self-improve commands tests PASS with new descriptions.

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts src/self-improve/commands.test.ts
git commit -m "refactor(cli): collapse guidance/session/self-improve into axctl evidence"
```

---

## Task 4: Fold `onboarding` into `doctor`

**Files:**
- Modify: `src/cli/install.ts:474-535` (`collectDoctorReport`, `formatDoctorReport`)
- Modify: `src/cli/index.ts` - remove `onboardingCommand`, drop `"onboarding"` from `noDbCommands` set
- Modify: `src/cli/onboarding.test.ts` - drop `axctl onboarding --json` string assertion
- Modify: `src/dogfood/wterm.ts:200,218` - replace `axctl onboarding --json` with `axctl doctor --json`
- Modify: `src/dogfood/wterm.test.ts:75` - replace assertion string

- [ ] **Step 1: Write a doctor test that checks onboarding is folded in**

Create `src/cli/install.doctor-onboarding.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { collectDoctorReport, formatDoctorReport } from "./install.ts";

describe("doctor includes onboarding harness-tracking checks", () => {
    test("report contains a check whose name starts with 'onboarding:'", () => {
        const report = collectDoctorReport();
        const names = report.checks.map((c) => c.name);
        expect(names.some((n) => n.startsWith("onboarding:"))).toBe(true);
    });

    test("text format lists harness-tracking lines", () => {
        const text = formatDoctorReport(collectDoctorReport(), false);
        expect(text).toContain("onboarding:");
    });
});
```

Note: `collectDoctorReport` is currently `function` (not exported). Promote it to `export function collectDoctorReport()` as part of Step 2 so the test can import it.

- [ ] **Step 2: Run test, confirm RED**

Run: `bun test src/cli/install.doctor-onboarding.test.ts`
Expected: FAIL - `collectDoctorReport is not a function` (not exported) or, if you exported it first, no `onboarding:` check name yet.

- [ ] **Step 3: Extend `collectDoctorReport` to include onboarding checks**

In `src/cli/install.ts`, add to the top:

```ts
import { buildOnboardingReport } from "./onboarding.ts";
```

Change `function collectDoctorReport` → `export function collectDoctorReport`.

Inside `collectDoctorReport`, after the existing `daemon.agents.map(...)` spread (around line 523), append onboarding checks built from `buildOnboardingReport()`:

```ts
const onboarding = buildOnboardingReport();
const onboardingChecks: DoctorCheck[] = onboarding.checks.map((c) => ({
    name: `onboarding:${c.id}`,
    ok: c.status === "ok",
    detail: c.recommendation,
}));
```

Then change the final `return` so `checks: [...checks, ...onboardingChecks]`.

- [ ] **Step 4: Run doctor test, confirm GREEN**

Run: `bun test src/cli/install.doctor-onboarding.test.ts`
Expected: PASS.

- [ ] **Step 5: Remove `onboardingCommand` and update routing**

In `src/cli/index.ts`:
1. Delete the `onboardingCommand` definition block (~lines 1489–1493).
2. Remove `onboardingCommand` from `rootCommand`'s `withSubcommands` array.
3. In `noDbCommands` set (~line 1822), remove `"onboarding"`.

- [ ] **Step 6: Update onboarding test to drop the gone string**

In `src/cli/onboarding.test.ts`, change the assertion on line 53:
```ts
expect(text).toContain("axctl onboarding --json");
```
to:
```ts
expect(text).toContain("axctl doctor");
```

Update `src/cli/onboarding.ts` line 83 and 88 to match: replace `axctl onboarding --json` with `axctl doctor --json` in the `formatInstallOnboardingGuidance` strings.

- [ ] **Step 7: Update dogfood wterm scenarios**

In `src/dogfood/wterm.ts`, lines 200 and 218 replace:
```ts
"printf '\\r\\n$ HOME=<scratch> axctl onboarding --json\\r\\n'",
```
with:
```ts
"printf '\\r\\n$ HOME=<scratch> axctl doctor --json\\r\\n'",
```

Then around line 406, update the demo-summary string from:
```ts
: "scenario demonstrated axctl onboarding from a scratch HOME",
```
to:
```ts
: "scenario demonstrated axctl doctor from a scratch HOME",
```

In `src/dogfood/wterm.test.ts:75` replace the assertion:
```ts
expect(script.command).toContain("axctl onboarding --json");
```
with:
```ts
expect(script.command).toContain("axctl doctor --json");
```

- [ ] **Step 8: Run all touched tests**

Run: `bun test src/cli/effect-cli.test.ts src/cli/install.doctor-onboarding.test.ts src/cli/onboarding.test.ts src/dogfood/wterm.test.ts`
Expected: all PASS for these specific names. The other surface assertions still fail (ingest-insights / dogfood-hidden cuts remain).

- [ ] **Step 9: Commit**

```bash
git add src/cli/install.ts src/cli/index.ts src/cli/onboarding.ts src/cli/onboarding.test.ts src/cli/install.doctor-onboarding.test.ts src/dogfood/wterm.ts src/dogfood/wterm.test.ts
git commit -m "refactor(cli): fold onboarding checks into doctor"
```

---

## Task 5: Demote `ingest-insights` to `ingest --insights-only`

**Files:**
- Modify: `src/cli/index.ts:1440-1469` (`ingestCommand`, `ingestInsightsCommand`), root list
- Modify: `scripts/bench-empty-db.sh:61`

- [ ] **Step 1: Add `--insights-only` flag to `ingestCommand`**

In `src/cli/index.ts`, find the `ingestCommand` definition (~line 1440). Add `insightsOnly` to its flags and to the dispatch logic:

```ts
const ingestCommand = Command.make(
    "ingest",
    {
        skillsOnly: Flag.boolean("skills-only").pipe(Flag.withDefault(false)),
        transcriptsOnly: Flag.boolean("transcripts-only").pipe(Flag.withDefault(false)),
        codexOnly: Flag.boolean("codex-only").pipe(Flag.withDefault(false)),
        gitOnly: Flag.boolean("git-only").pipe(Flag.withDefault(false)),
        claudeOnly: Flag.boolean("claude-only").pipe(Flag.withDefault(false)),
        insightsOnly: Flag.boolean("insights-only").pipe(Flag.withDefault(false)),
        since: optionalSince,
        progress: progressFlag,
        verbose: verboseFlag,
    },
    ({ skillsOnly, transcriptsOnly, codexOnly, gitOnly, claudeOnly, insightsOnly, since, progress, verbose }) => {
        if (insightsOnly) {
            return cmdIngestInsights([
                `--progress=${progress}`,
                ...boolArg("verbose", verbose),
            ]);
        }
        return cmdIngest([
            ...boolArg("skills-only", skillsOnly),
            ...boolArg("transcripts-only", transcriptsOnly),
            ...boolArg("codex-only", codexOnly),
            ...boolArg("git-only", gitOnly),
            ...boolArg("claude-only", claudeOnly),
            ...intArg("since", optionValue(since)),
            `--progress=${progress}`,
            ...boolArg("verbose", verbose),
        ]);
    },
).pipe(Command.withDescription("Ingest skills, transcripts, Codex sessions, git history, and insight artifacts"));
```

- [ ] **Step 2: Remove standalone `ingestInsightsCommand`**

Delete the `ingestInsightsCommand` definition block. Remove `ingestInsightsCommand` from `rootCommand`'s `withSubcommands` array. Leave `cmdIngestInsights` function intact (still called from the new `--insights-only` branch).

- [ ] **Step 3: Update bench script**

In `scripts/bench-empty-db.sh` line 61, replace:
```sh
run_step "ingest-insights" bun "$ROOT/src/cli/index.ts" ingest-insights
```
with:
```sh
run_step "ingest-insights" bun "$ROOT/src/cli/index.ts" ingest --insights-only
```

- [ ] **Step 4: Run surface test for the cut**

Run: `bun test src/cli/effect-cli.test.ts -t "retired top-level commands"`
Expected: PASS for `ingest-insights`. (Other retired-name assertions already pass from earlier tasks; `dogfood` assertion still fails.)

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts scripts/bench-empty-db.sh
git commit -m "refactor(cli): fold ingest-insights into ingest --insights-only"
```

---

## Task 6: Hide `dogfood` behind `AX_DEV=1`

**Files:**
- Modify: `src/cli/index.ts` (around `dogfoodCommand` definition and root `withSubcommands`)

- [ ] **Step 1: Conditionally mount `dogfoodCommand`**

In `src/cli/index.ts`, leave `dogfoodTerminalCommand` and `dogfoodCommand` definitions untouched. At the bottom of the file, replace the root `withSubcommands(...)` call with a computed array:

```ts
const devOnlyCommands = process.env.AX_DEV === "1" ? [dogfoodCommand] : [];

export const rootCommand = Command.make("axctl").pipe(
    Command.withDescription("ax local memory and telemetry for coding agents"),
    Command.withSubcommands([
        ingestCommand,
        deriveSignalsCommand,
        insightsCommand,
        interventionsCommand,
        dashboardCommand,
        recallCommand,
        skillsCommand,
        projectCommand,
        evidenceCommand,
        versionCommand,
        updateCommand,
        tuiCommand,
        installCommand,
        daemonCommand,
        doctorCommand,
        uninstallCommand,
        ...devOnlyCommands,
    ]),
);
```

- [ ] **Step 2: Add a dev-mode visibility test**

Append to `src/cli/effect-cli.test.ts`:

```ts
describe("AX_DEV flag", () => {
    test("AX_DEV=1 exposes dogfood at top level", async () => {
        process.env.AX_DEV = "1";
        try {
            // re-import to rebuild rootCommand with env applied
            const mod = await import(`./index.ts?ax_dev=${Date.now()}`);
            const names = mod.rootCommand.subcommands.flatMap((g: any) => g.commands.map((c: any) => c.name));
            expect(names).toContain("dogfood");
        } finally {
            delete process.env.AX_DEV;
        }
    });
});
```

If module caching prevents the re-import trick under Bun, fall back to asserting only the default-hidden case (the existing "dogfood is hidden by default" test) and skip this with `test.skip` plus a comment that documents how to verify manually (`AX_DEV=1 bun src/cli/index.ts --help | rg dogfood`).

- [ ] **Step 3: Run surface tests**

Run: `bun test src/cli/effect-cli.test.ts`
Expected: all PASS.

- [ ] **Step 4: Manual verification**

Run: `bun src/cli/index.ts --help | rg -i dogfood`
Expected: no match.

Run: `AX_DEV=1 bun src/cli/index.ts --help | rg -i dogfood`
Expected: one line listing the `dogfood` subcommand.

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts src/cli/effect-cli.test.ts
git commit -m "refactor(cli): hide dogfood behind AX_DEV=1"
```

---

## Task 7: README sweep

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Diff old → new command strings**

In `README.md`, perform these literal substitutions (verify each with `rg -n "<old>" README.md` first, then edit):

| Old | New |
|-----|-----|
| `axctl ingest-insights` | `axctl ingest --insights-only` |
| `axctl onboarding --json` | `axctl doctor --json` |
| `axctl onboarding [--json]` | (delete line) |
| `axctl guidance next --json` | `axctl evidence guidance-next --json` |
| `axctl session summary --json` | `axctl evidence session-summary --json` |
| `axctl self-improve weekly --json` | `axctl evidence weekly --json` |
| `axctl search` | `axctl skills search` |
| `axctl stats` | `axctl skills stats` |
| `axctl recent` | `axctl skills recent` |
| `axctl unused` | `axctl skills unused` |
| `axctl taste` | `axctl skills taste` |
| `axctl pairs` | `axctl skills pairs` |
| `axctl recovery` | `axctl skills recovery` |
| `axctl dogfood terminal ...` line | move under a new `### Development (AX_DEV=1)` subsection or delete |

- [ ] **Step 2: Re-render top-level command list section**

In whatever section enumerates `axctl <subcommand>` (around README.md:50–150), replace the bulleted list with the new 13-command surface (see plan header). Add a single line at the bottom: `Set AX_DEV=1 to expose dogfood scenario commands during development.`

- [ ] **Step 3: Verify no stale references remain**

Run:
```bash
rg -n "axctl (onboarding|ingest-insights|guidance next|session summary|self-improve weekly|search |stats |recent |unused |taste |pairs |recovery |dogfood)" README.md
```
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(readme): update for new cli surface"
```

---

## Task 8: Final cross-cut verification

**Files:** none modified - verification only.

- [ ] **Step 1: Run the full test suite**

Run: `bun test`
Expected: all tests pass. If a test elsewhere references a retired command name (likely candidates: `docs/superpowers/specs/*` are docs only, won't run), it would have failed in earlier tasks; re-confirm zero failures.

- [ ] **Step 2: Run typecheck**

Run: `bun tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Smoke-test the help output**

Run: `bun src/cli/index.ts --help`
Expected: exactly 16 subcommands listed: `ingest, derive-signals, insights, interventions, dashboard, recall, skills, project, evidence, version, update, tui, install, daemon, doctor, uninstall`. No `dogfood`, `onboarding`, `ingest-insights`, `search`, `stats`, `recent`, `unused`, `taste`, `pairs`, `recovery`, `guidance`, `session`, `self-improve`.

- [ ] **Step 4: Smoke-test the moved groups**

```bash
bun src/cli/index.ts skills --help
bun src/cli/index.ts evidence --help
bun src/cli/index.ts ingest --insights-only --progress=plain
bun src/cli/index.ts doctor --json | rg onboarding:
AX_DEV=1 bun src/cli/index.ts dogfood --help
```

Expected:
- `skills --help` lists 7 subcommands.
- `evidence --help` lists 3 subcommands.
- `ingest --insights-only` runs the insight-artifact ingestion (same behaviour as old `ingest-insights`).
- `doctor --json` includes lines with `onboarding:claude-global`, `onboarding:codex-global`, `onboarding:agents-shared`.
- `dogfood --help` reachable.

- [ ] **Step 5: Final commit if anything trailing**

If steps 1–4 surfaced a missed reference, fix it and:

```bash
git add -p
git commit -m "fix(cli): clean up trailing references after surface cut"
```

If nothing trailing, skip.

---

## Self-Review Notes

- **Spec coverage:** All four chosen cuts have a dedicated task. README sweep + cross-cut verification close out cross-file consumers. No placeholder text in any step.
- **Type consistency:** `collectDoctorReport` becomes exported in Task 4. New commands (`skillsCommand`, `evidenceCommand`, `evidenceGuidanceNextCommand`, etc.) use the same `Command.make`/`Command.withSubcommands` pattern as existing code. The `--insights-only` flag uses the established `Flag.boolean(...).pipe(Flag.withDefault(false))` pattern.
- **Risk:** Module re-import for AX_DEV test (Task 6 Step 2) may not work under Bun's module cache; plan includes a `test.skip` fallback with manual-verification comment so the task does not block on harness limitations.
- **Hard-break policy honoured:** No alias commands, no deprecation warnings; old command names emit "command not found" after merge.
