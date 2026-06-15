# Self-Telemetry + Utilization View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture ax's own CLI invocations (redacted) into an `ax_invocation` table and surface "what you actually run" via `ax usage --json` and an `ax serve` Utilization route.

**Architecture:** Capture is split from graph by a local append-only log. The CLI entrypoint appends one redacted JSONL line per invocation to `~/.ax/usage-log.jsonl` (cheap, no DB, fail-silent). A `derive`-tagged ingest stage parses the log into `ax_invocation` rows on the next ingest and truncates consumed lines (failure-isolated). Pure rollup functions feed both the CLI and the dashboard.

**Tech Stack:** Bun, TypeScript (strict), Effect v4 (`effect@beta`), Effect Schema, SurrealDB via `@ax/lib/db`, `effect/unstable/cli`. Tests: `bun:test`.

**Spec:** `docs/superpowers/specs/2026-06-15-usage-telemetry-design.md`

**Reference (already on main):** the push-value digest feature is the template for this whole shape - `apps/axctl/src/digest/` (model/stage/snapshot atomic-write), `apps/axctl/src/digest/digest-stage.ts` (derive-stage + `Effect.catchCause` isolation), `apps/axctl/src/cli/commands/digest.ts` (CLI command pattern). Read these first.

---

## File Structure

```
packages/schema/src/schema.surql                  - ax_invocation table DDL (modify)
apps/axctl/src/queries/insights.ts                - SCHEMA_TABLES += ax_invocation (modify)
apps/axctl/src/usage/
  model.ts        - UsageRecord schema + parseUsageLine + encodeUsageLine
  record.ts       - redactInvocation (pure) + appendUsageRecord (fail-silent IO)
  usage-stage.ts  - derive-tagged StageDef: parse log → rows, truncate, isolated
  query.ts        - pure rollups over decoded rows (+ injected command list)
apps/axctl/src/cli/index.ts                        - wrap runMain to record on exit (modify)
apps/axctl/src/cli/commands/usage.ts               - `ax usage [--json] [--days=N]`
apps/axctl/src/cli/index.ts                        - register usageCommand + usageRuntime (modify)
apps/axctl/src/ingest/stage/registry.ts            - register usageStage (modify)
apps/axctl/src/cli/effect-cli.test.ts              - stage count + derive set (modify)
README.md / docs/cli.md / apps/site/public/llms.txt - document ax usage (modify)
apps/site/app/routes/docs/-cli-reference.data.ts   - ax usage card (modify)
apps/axctl/src/dashboard/...                       - /api/usage route (functional-minimal)
```

Reuse: atomic-write + JSONL patterns from `apps/axctl/src/digest/` and `apps/axctl/src/quota/cache.ts`; StageDef from `apps/axctl/src/digest/digest-stage.ts`; CLI command from `apps/axctl/src/cli/commands/digest.ts`; schema DDL from the `hook_command_invocation` block in `schema.surql`.

---

## Task 1: `ax_invocation` schema + registration

**Files:**
- Modify: `packages/schema/src/schema.surql` (add the table DDL near `hook_command_invocation`, ~line 1525)
- Modify: `apps/axctl/src/queries/insights.ts` (add to `SCHEMA_TABLES`, ~line 45)
- Test: there is an existing test that asserts every `schema.surql` table is in `SCHEMA_TABLES` - find it with `rg -l "SCHEMA_TABLES" apps/axctl/src --glob '*.test.ts'` and run it.

- [ ] **Step 1: Add the table DDL** to `packages/schema/src/schema.surql` (after the `hook_command_invocation` indexes block):

```surql
DEFINE TABLE ax_invocation SCHEMAFULL;
DEFINE FIELD ts          ON ax_invocation TYPE datetime;
DEFINE FIELD command     ON ax_invocation TYPE string;           -- "sessions churn" | "digest" | "ingest"
DEFINE FIELD flags       ON ax_invocation TYPE string;           -- JSON-encoded string[] of flag NAMES
DEFINE FIELD exit_code   ON ax_invocation TYPE int;
DEFINE FIELD duration_ms ON ax_invocation TYPE int;
DEFINE FIELD origin      ON ax_invocation TYPE string;           -- tty | agent
DEFINE FIELD repo_key    ON ax_invocation TYPE option<string>;   -- basename(git toplevel), lowercased
DEFINE FIELD ax_version  ON ax_invocation TYPE string;
DEFINE INDEX IF NOT EXISTS ax_invocation_by_ts      ON ax_invocation FIELDS ts;
DEFINE INDEX IF NOT EXISTS ax_invocation_by_command ON ax_invocation FIELDS command, ts;
```

- [ ] **Step 2: Register in `SCHEMA_TABLES`** (`apps/axctl/src/queries/insights.ts`, add one entry to the array):

```typescript
    { table: "ax_invocation", stage: "active", note: "ax's own CLI invocations (redacted) for self-telemetry / utilization." },
```

- [ ] **Step 3: Run the schema-tables mirror test**

Run: `bun test $(rg -l "SCHEMA_TABLES" apps/axctl/src --glob '*.test.ts' | head -1)`
Expected: PASS (the table is now mirrored). If the test enumerates `DEFINE TABLE` from schema.surql, it now finds `ax_invocation` in `SCHEMA_TABLES`.

- [ ] **Step 4: Apply schema to the local DB + verify**

Run: `bun run apps/axctl/src/cli/index.ts ingest --stages=skills 2>&1 | tail -3` (any ingest applies schema first) OR the repo's schema-apply script (`rg -n "apply-schema" scripts/`). Then verify the table exists:
Run: `printf 'INFO FOR TABLE ax_invocation;\n' | surreal sql --endpoint http://127.0.0.1:8521 --username root --password root --namespace ax --database main 2>&1 | tail -2`
Expected: shows the field definitions (proves DDL applied, no orphan-field crash).

- [ ] **Step 5: Commit**

```bash
git add packages/schema/src/schema.surql apps/axctl/src/queries/insights.ts
git commit -m "feat(usage): ax_invocation table + SCHEMA_TABLES registration"
```

---

## Task 2: `model.ts` - UsageRecord schema + JSONL

**Files:**
- Create: `apps/axctl/src/usage/model.ts`
- Test: `apps/axctl/src/usage/model.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/axctl/src/usage/model.test.ts
import { describe, expect, it } from "bun:test";
import { UsageRecord, parseUsageLine, encodeUsageLine } from "./model.ts";

const rec = () => UsageRecord.make({
  ts: new Date("2026-06-15T12:00:00Z"),
  command: "sessions churn",
  flags: ["--here", "--json"],
  exit_code: 0,
  duration_ms: 1200,
  origin: "agent",
  repo_key: "ax",
  ax_version: "0.29.0",
});

describe("usage model", () => {
  it("encodeUsageLine -> parseUsageLine round-trips", () => {
    const line = encodeUsageLine(rec());
    expect(line.endsWith("\n")).toBe(false); // caller adds the newline
    const back = parseUsageLine(line);
    expect(back?.command).toBe("sessions churn");
    expect(back?.flags).toEqual(["--here", "--json"]);
    expect(back?.origin).toBe("agent");
  });
  it("parseUsageLine returns null on malformed / non-JSON / bad-shape lines", () => {
    expect(parseUsageLine("not json")).toBeNull();
    expect(parseUsageLine(JSON.stringify({ nope: 1 }))).toBeNull();
    expect(parseUsageLine("")).toBeNull();
  });
  it("repo_key is optional (null outside a repo)", () => {
    const r = UsageRecord.make({ ...rec(), repo_key: null });
    const back = parseUsageLine(encodeUsageLine(r));
    expect(back?.repo_key).toBeNull();
  });
});
```

- [ ] **Step 2: Run it, verify FAIL** (`bun test apps/axctl/src/usage/model.test.ts`).

- [ ] **Step 3: Implement** `apps/axctl/src/usage/model.ts`. NOTE on effect@beta Schema (confirmed from the digest feature on main): multi-arg `Schema.Literal(...)` collapses - use `Schema.Literals([...])` for the origin union; `Schema.Date` does not JSON round-trip - use the validating ISO codec pattern from `apps/axctl/src/digest/model.ts` (read it; it exports an `IsoDate` built as `Schema.DateFromString.check(Schema.isDateValid())`). Reuse that exact pattern here.

```typescript
import { Schema } from "effect";

// Same validating ISO codec the digest model uses (decodes ISO string -> Date,
// rejects garbage, encodes Date -> ISO string for JSONL persistence).
const IsoDate = Schema.DateFromString.check(Schema.isDateValid());

export const UsageOrigin = Schema.Literals(["tty", "agent"]);
export type UsageOrigin = typeof UsageOrigin.Type;

export class UsageRecord extends Schema.Class<UsageRecord>("UsageRecord")({
  ts: IsoDate,
  command: Schema.String,
  flags: Schema.Array(Schema.String),
  exit_code: Schema.Number,
  duration_ms: Schema.Number,
  origin: UsageOrigin,
  repo_key: Schema.NullOr(Schema.String),
  ax_version: Schema.String,
}) {}

/** Encode a record to a single JSONL line (no trailing newline). */
export const encodeUsageLine = (rec: UsageRecord): string =>
  JSON.stringify(Schema.encodeSync(UsageRecord)(rec));

/** Parse one JSONL line; null on any parse/decode failure (caller skips it). */
export const parseUsageLine = (line: string): UsageRecord | null => {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return Schema.decodeUnknownSync(UsageRecord)(JSON.parse(trimmed));
  } catch {
    return null;
  }
};
```

- [ ] **Step 4: Run test, verify PASS** (`bun test apps/axctl/src/usage/model.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/usage/model.ts apps/axctl/src/usage/model.test.ts
git commit -m "feat(usage): UsageRecord schema + JSONL parse/encode"
```

---

## Task 3: `record.ts` - redaction + fail-silent append

**Files:**
- Create: `apps/axctl/src/usage/record.ts`
- Test: `apps/axctl/src/usage/record.test.ts`

- [ ] **Step 1: Write the failing test** (redaction is the safety-critical part - test it hard):

```typescript
// apps/axctl/src/usage/record.test.ts
import { describe, expect, it } from "bun:test";
import { redactInvocation } from "./record.ts";

describe("redactInvocation", () => {
  const base = { now: new Date("2026-06-15T12:00:00Z"), exitCode: 0, durationMs: 5, isTty: false, repoTopdir: "/Users/me/Projects/ax", version: "0.29.0" };

  it("keeps the subcommand path, drops positional args", () => {
    const r = redactInvocation(["sessions", "show", "abc-123-uuid"], base);
    expect(r.command).toBe("sessions show");
    expect(r.flags).toEqual([]);
  });
  it("keeps flag NAMES, strips flag values", () => {
    const r = redactInvocation(["recall", "secret query text", "--days=30", "--project=/Users/me/x", "--json"], base);
    expect(r.command).toBe("recall");
    expect(r.flags).toEqual(["--days", "--json", "--project"]); // sorted, names only, no values
  });
  it("repo_key is the lowercased basename, never the full path", () => {
    expect(redactInvocation(["digest"], base).repo_key).toBe("ax");
    expect(redactInvocation(["digest"], { ...base, repoTopdir: null }).repo_key).toBeNull();
  });
  it("origin from isTty", () => {
    expect(redactInvocation(["digest"], { ...base, isTty: true }).origin).toBe("tty");
    expect(redactInvocation(["digest"], { ...base, isTty: false }).origin).toBe("agent");
  });
  it("no positional value ever survives in command or flags", () => {
    const r = redactInvocation(["sessions", "show", "/Users/me/secret", "--here"], base);
    const blob = JSON.stringify(r);
    expect(blob).not.toContain("secret");
    expect(blob).not.toContain("/Users/me");
  });
});
```

- [ ] **Step 2: Run it, verify FAIL.**

- [ ] **Step 3: Implement** `apps/axctl/src/usage/record.ts`:

```typescript
import { UsageRecord, encodeUsageLine } from "./model.ts";

export const defaultUsageLogPath = (): string => `${process.env.HOME}/.ax/usage-log.jsonl`;
/** Skip appending above this size if ingest never ran (bounds runaway growth). */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

export interface RecordInputs {
  readonly now: Date;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly isTty: boolean;
  readonly repoTopdir: string | null; // absolute git toplevel, or null
  readonly version: string;
}

const KNOWN_SUBCOMMAND_FIRST = new Set([
  // first tokens that take a SECOND word as part of the command path. Keep this
  // conservative: only multi-word command groups. Everything else = 1-word cmd.
  "sessions", "skills", "cost", "routing", "profile", "hooks", "dojo", "agents",
  "classifiers", "insights", "signals", "evidence", "project", "costs", "wrapped",
  "daemon", "improve", "retro",
]);

/** Pure redaction: argv -> a privacy-safe UsageRecord. Positional values and
 *  flag values never survive; repo_key is basename-only. */
export const redactInvocation = (argv: ReadonlyArray<string>, inp: RecordInputs): UsageRecord => {
  const positionals = argv.filter((a) => !a.startsWith("-"));
  const head = positionals[0] ?? "(root)";
  // command path = head, plus the second positional ONLY when head is a known
  // command group (so "sessions show <id>" -> "sessions show", but "recall <q>" -> "recall").
  const command = KNOWN_SUBCOMMAND_FIRST.has(head) && positionals[1]
    ? `${head} ${positionals[1]}`
    : head;
  const flags = [...new Set(
    argv.filter((a) => a.startsWith("-")).map((a) => a.split("=")[0]!), // strip =value
  )].sort();
  const repo_key = inp.repoTopdir ? inp.repoTopdir.split("/").filter(Boolean).pop()!.toLowerCase() : null;
  return UsageRecord.make({
    ts: inp.now,
    command,
    flags,
    exit_code: inp.exitCode,
    duration_ms: inp.durationMs,
    origin: inp.isTty ? "tty" : "agent",
    repo_key,
    ax_version: inp.version,
  });
};

/** Fail-silent append of one record. ANY fault is swallowed - telemetry must
 *  never break or slow a command. Skips if the log is already huge. */
export async function appendUsageRecord(path: string, rec: UsageRecord): Promise<void> {
  try {
    const file = Bun.file(path);
    if (await file.exists() && file.size > MAX_LOG_BYTES) return;
    const prev = (await file.exists()) ? await file.text() : "";
    await Bun.write(path, `${prev}${encodeUsageLine(rec)}\n`, { createPath: true });
  } catch { /* never throw on the hot path */ }
}
```

> Implementer note: `appendUsageRecord` re-reads + rewrites the file for simplicity (telemetry volume is low). If you prefer a true append, use a Bun `FileSink` (`Bun.file(path).writer({ createPath: true })` then `.write()`/`.flush()`), still wrapped in the same try/catch. Either is acceptable; keep it fail-silent. The `KNOWN_SUBCOMMAND_FIRST` set should mirror the real command groups - cross-check against `ax help` SUBCOMMANDS and the command registry; a stale entry only mislabels the command string, never leaks data.

- [ ] **Step 4: Run test, verify PASS.**

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/usage/record.ts apps/axctl/src/usage/record.test.ts
git commit -m "feat(usage): redact invocation + fail-silent append"
```

---

## Task 4: Entrypoint wiring - record on every invocation

**Files:**
- Modify: `apps/axctl/src/cli/index.ts` (the `if (import.meta.main)` / `BunRuntime.runMain` block)

- [ ] **Step 1: Read the entrypoint** `apps/axctl/src/cli/index.ts` around `BunRuntime.runMain(dispatch(args)...)`. The recorder must: stamp a start time, run the program, and on completion (success OR failure) append a record with the duration + a best-effort exit code, WITHOUT changing the program's own exit behavior.

- [ ] **Step 2: Add the recorder wiring.** Add an `Effect.onExit` to the piped program that fires the append. Compute the git toplevel once (best-effort `git rev-parse --show-toplevel`). Exit code: 0 on Success, 1 on Failure (matching runMain's teardown). Implementation:

```typescript
// near the other imports at the top of apps/axctl/src/cli/index.ts
import { appendUsageRecord, defaultUsageLogPath, redactInvocation } from "../usage/record.ts";
import { Exit } from "effect";

// helper, define above `if (import.meta.main)`:
const recordInvocation = (args: ReadonlyArray<string>, t0: number, exitCode: number): Promise<void> => {
  let repoTopdir: string | null = null;
  try {
    const r = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "ignore" });
    if (r.exitCode === 0) repoTopdir = r.stdout.toString().trim() || null;
  } catch { /* no git / not a repo */ }
  const rec = redactInvocation(args, {
    now: new Date(),
    exitCode,
    durationMs: Math.max(0, Math.round(performance.now() - t0)),
    isTty: process.stderr.isTTY === true,
    repoTopdir,
    version: AX_VERSION,
  });
  return appendUsageRecord(defaultUsageLogPath(), rec);
};
```

Then wrap the program inside `if (import.meta.main)`:

```typescript
if (import.meta.main) {
    const args = process.argv.slice(2);
    const t0 = performance.now();
    BunRuntime.runMain(
        dispatch(args).pipe(
            Effect.tap(() => Effect.promise(() => maybePrintStarNudge(args))),
            Effect.tapCause(reportCliFailure),
            // record AFTER the program settles; onExit never alters the exit channel.
            Effect.onExit((exit) =>
                Effect.promise(() => recordInvocation(args, t0, Exit.isSuccess(exit) ? 0 : 1)),
            ),
        ),
        { disableErrorReporting: true },
    );
}
```

> Implementer note: confirm `AX_VERSION` is in scope at the entrypoint (it's passed to `Command.runWith`; grep it). Confirm `Effect.onExit` exists in effect@beta (if named differently, use `Effect.ensuring` with the exit captured via `Effect.exit` / `Effect.tapBoth` - the requirement is "run the append exactly once after the program settles, success or failure, without swallowing the program's failure or changing its exit code"). The append is fail-silent, so an `Effect.promise` (which dies on throw) is fine because `appendUsageRecord` never throws. Do NOT record for the long-lived `serve`/`mcp` commands' lifetime - `onExit` only fires when the fiber settles, which for `serve` is at shutdown; that's acceptable (one record at process exit). If `serve` never exits cleanly, no record is written - fine.

- [ ] **Step 3: Manual smoke test** (TDD-by-hand - this is wiring, verified by observing the side effect):

```bash
rm -f ~/.ax/usage-log.jsonl
bun run apps/axctl/src/cli/index.ts version >/dev/null 2>&1
bun run apps/axctl/src/cli/index.ts sessions here --days=1 >/dev/null 2>&1 || true
cat ~/.ax/usage-log.jsonl
```
Expected: two JSONL lines; the `version` line has `"command":"version"`, the sessions line has `"command":"sessions here"`, `"flags":["--days"]` (no `=1`), `"origin":"agent"` (piped) or `"tty"`, `"repo_key":"ax"`. No absolute paths, no positional values present.

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck 2>&1 | rg -c "error TS"` → expect 0 (in the touched file).

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/cli/index.ts
git commit -m "feat(usage): record every CLI invocation on exit (fail-silent)"
```

---

## Task 5: `usage-stage.ts` - log → rows, truncate, isolated + registry

**Files:**
- Create: `apps/axctl/src/usage/usage-stage.ts`
- Modify: `apps/axctl/src/ingest/stage/registry.ts`
- Modify: `apps/axctl/src/cli/effect-cli.test.ts`
- Test: `apps/axctl/src/usage/usage-stage.test.ts`

- [ ] **Step 1: Write the failing test** (parsing + idempotent id + isolation; reads the digest-stage test as a template for the failing-DB-layer pattern):

```typescript
// apps/axctl/src/usage/usage-stage.test.ts
import { describe, expect, it } from "bun:test";
import { invocationRowKey, parseUsageLog } from "./usage-stage.ts";
import { UsageRecord } from "./model.ts";

const rec = (over: Partial<ConstructorParameters<typeof UsageRecord>[0]> = {}) => UsageRecord.make({
  ts: new Date("2026-06-15T12:00:00Z"), command: "digest", flags: [], exit_code: 0,
  duration_ms: 5, origin: "agent", repo_key: "ax", ax_version: "0.29.0", ...over,
});

describe("parseUsageLog", () => {
  it("parses valid lines, skips malformed ones", () => {
    const text = [
      JSON.stringify({ ts: "2026-06-15T12:00:00.000Z", command: "digest", flags: [], exit_code: 0, duration_ms: 5, origin: "agent", repo_key: "ax", ax_version: "0.29.0" }),
      "GARBAGE",
      "",
    ].join("\n");
    const rows = parseUsageLog(text);
    expect(rows).toHaveLength(1);
    expect(rows[0].command).toBe("digest");
  });
});

describe("invocationRowKey", () => {
  it("is stable for the same (ts, command, repo_key, origin) - idempotent re-parse", () => {
    expect(invocationRowKey(rec())).toBe(invocationRowKey(rec()));
  });
  it("differs when ts or command differs", () => {
    expect(invocationRowKey(rec())).not.toBe(invocationRowKey(rec({ command: "ingest" })));
    expect(invocationRowKey(rec())).not.toBe(invocationRowKey(rec({ ts: new Date("2026-06-15T13:00:00Z") })));
  });
});
```

- [ ] **Step 2: Run it, verify FAIL.**

- [ ] **Step 3: Implement** `apps/axctl/src/usage/usage-stage.ts`. Mirror `apps/axctl/src/digest/digest-stage.ts` for the StageDef + `Effect.catchCause` isolation, and `apps/axctl/src/digest/snapshot.ts` for the atomic-write/truncate. Read both first.

```typescript
import { Cause, Effect, Schema } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { surrealDate, recordRef } from "@ax/lib/shared/surql";
import { executeStatementsWith } from "@ax/lib/shared/statement-exec";
import { BaseStageStats, IngestContext, StageMeta } from "../ingest/stage/types.ts";
import type { StageDef } from "../ingest/stage/registry.ts";
import { UsageRecord, parseUsageLine } from "./model.ts";
import { defaultUsageLogPath } from "./record.ts";

/** Stable, idempotent row id over the identifying fields. */
export const invocationRowKey = (r: UsageRecord): string =>
  Bun.hash(`${r.ts.getTime()}:${r.command}:${r.repo_key ?? ""}:${r.origin}`).toString(16);

export const parseUsageLog = (text: string): UsageRecord[] =>
  text.split("\n").map(parseUsageLine).filter((r): r is UsageRecord => r !== null);

const buildStatements = (rows: ReadonlyArray<UsageRecord>): string[] =>
  rows.map((r) => {
    const id = invocationRowKey(r);
    const flagsJson = JSON.stringify([...r.flags]).replace(/'/g, "\\'");
    const repo = r.repo_key === null ? "NONE" : `'${r.repo_key.replace(/'/g, "\\'")}'`;
    return `UPDATE ${recordRef("ax_invocation", id)} CONTENT { ts: ${surrealDate(r.ts.toISOString())}, command: '${r.command.replace(/'/g, "\\'")}', flags: '${flagsJson}', exit_code: ${r.exit_code}, duration_ms: ${r.duration_ms}, origin: '${r.origin}', repo_key: ${repo}, ax_version: '${r.ax_version.replace(/'/g, "\\'")}' };`;
  });

/** Parse the log, UPSERT rows (idempotent), then truncate the consumed log. */
export const ingestUsageLog = (): Effect.Effect<number, never, SurrealClient> =>
  Effect.gen(function* () {
    const db = yield* SurrealClient;
    const path = defaultUsageLogPath();
    const text = yield* Effect.promise(async () => {
      const f = Bun.file(path);
      return (await f.exists()) ? await f.text() : "";
    });
    const rows = parseUsageLog(text);
    if (rows.length === 0) return 0;
    yield* executeStatementsWith(db, buildStatements(rows), { chunkSize: 500 });
    // truncate only AFTER a successful write
    yield* Effect.promise(() => Bun.write(path, ""));
    return rows.length;
  });

export const UsageKey = Schema.Literal("usage");
export type UsageKey = typeof UsageKey.Type;

export class UsageStats extends BaseStageStats.extend<UsageStats>("UsageStats")({
  invocations: Schema.Number,
}) {}

/** Derive-tagged: parses ~/.ax/usage-log.jsonl into ax_invocation. Self-isolated
 *  via catchCause so a parse/DB error never aborts the surrounding ingest. */
export const usageStage: StageDef<UsageStats, SurrealClient> = {
  meta: StageMeta.make({ key: "usage", deps: [], tags: ["derive"] }),
  run: (_ctx: IngestContext) =>
    Effect.gen(function* () {
      const t0 = Date.now();
      const n = yield* ingestUsageLog();
      return UsageStats.make({ durationMs: Date.now() - t0, summary: `ingested ${n} invocations`, invocations: n });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`usage stage skipped: ${Cause.pretty(cause)}`).pipe(
          Effect.as(UsageStats.make({ durationMs: 0, summary: "usage skipped (non-fatal)", invocations: 0 })),
        ),
      ),
    ),
};
```

> Implementer note: verify `surrealDate`, `recordRef`, `executeStatementsWith` signatures against `@ax/lib/shared/surql` + `@ax/lib/shared/statement-exec` (the digest + derive-opportunities stages use them - copy their exact usage). The SQL uses `UPDATE <id> CONTENT {...}` for idempotent upsert keyed by the stable id (re-parsing the same log twice produces the same rows). Confirm string-escaping is sufficient; prefer the project's existing `surrealLiteral`/`recordRef` helpers over hand-rolled quoting if available (grep `surrealLiteral` in `@ax/lib/json`). If a helper exists, use it instead of `.replace(/'/g, ...)`.

- [ ] **Step 4: Register the stage** in `apps/axctl/src/ingest/stage/registry.ts`:
  1. Import: `import { UsageKey, usageStage } from "../../usage/usage-stage.ts";`
  2. Add `UsageKey` to the `IngestStageKey` `Schema.Union([...])` list.
  3. Add `usageStage` to `ALL_STAGES`.

- [ ] **Step 5: Update `effect-cli.test.ts`** - the default-stage count and the derive set both grow by one. Find the `resolveIngestStages: default runs every stage` test (`.toHaveLength(N)`) and bump N by 1 (update the comment to mention `usageStage`). Find the `--derive-only` test's sorted array and insert `"usage"` in sorted position.

- [ ] **Step 6: Run tests + verify registration**

Run: `bun test apps/axctl/src/usage/usage-stage.test.ts apps/axctl/src/cli/effect-cli.test.ts` → PASS.
Run: `bun run typecheck 2>&1 | rg -c "error TS"` → 0.
Run (e2e): seed a log line then run the stage -
```bash
printf '%s\n' '{"ts":"2026-06-15T12:00:00.000Z","command":"digest","flags":["--json"],"exit_code":0,"duration_ms":5,"origin":"agent","repo_key":"ax","ax_version":"0.29.0"}' > ~/.ax/usage-log.jsonl
bun run apps/axctl/src/cli/index.ts ingest --stages=usage 2>&1 | tail -3
printf 'SELECT command, origin, flags FROM ax_invocation LIMIT 5;\n' | surreal sql --endpoint http://127.0.0.1:8521 --username root --password root --namespace ax --database main 2>&1 | tail -2
wc -l ~/.ax/usage-log.jsonl   # should be 0 (truncated)
```
Expected: one `ax_invocation` row (command digest), log truncated to empty.

- [ ] **Step 7: Commit**

```bash
git add apps/axctl/src/usage/usage-stage.ts apps/axctl/src/usage/usage-stage.test.ts apps/axctl/src/ingest/stage/registry.ts apps/axctl/src/cli/effect-cli.test.ts
git commit -m "feat(usage): ingest stage parses usage log into ax_invocation (isolated)"
```

---

## Task 6: `query.ts` - utilization rollups

**Files:**
- Create: `apps/axctl/src/usage/query.ts`
- Test: `apps/axctl/src/usage/query.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/axctl/src/usage/query.test.ts
import { describe, expect, it } from "bun:test";
import { rollup, type InvocationRow } from "./query.ts";

const row = (over: Partial<InvocationRow>): InvocationRow => ({
  ts: "2026-06-15T12:00:00.000Z", command: "digest", origin: "agent", exit_code: 0, ...over,
});

describe("rollup", () => {
  const visible = ["digest", "sessions", "recall", "quota", "thinking"];
  const rows: InvocationRow[] = [
    row({ command: "digest", ts: "2026-06-15T10:00:00.000Z" }),
    row({ command: "digest", ts: "2026-06-15T11:00:00.000Z", origin: "tty" }),
    row({ command: "sessions", ts: "2026-06-14T10:00:00.000Z" }),
    row({ command: "recall", ts: "2026-06-13T10:00:00.000Z", exit_code: 1 }),
  ];

  it("topCommands ranks by count desc with last_used", () => {
    const r = rollup(rows, visible);
    expect(r.topCommands[0]).toMatchObject({ command: "digest", count: 2 });
    expect(r.topCommands[0].last_used).toBe("2026-06-15T11:00:00.000Z");
  });
  it("activeDays counts distinct UTC days with >=1 run", () => {
    expect(rollup(rows, visible).activeDays).toBe(3); // 06-15, 06-14, 06-13
  });
  it("unusedSurface = visible commands never invoked", () => {
    expect(rollup(rows, visible).unusedSurface.sort()).toEqual(["quota", "thinking"]);
  });
  it("originSplit counts agent vs tty", () => {
    const r = rollup(rows, visible);
    expect(r.originSplit).toEqual({ agent: 3, tty: 1 });
  });
  it("reliability flags commands with a nonzero exit-rate", () => {
    const r = rollup(rows, visible);
    const recall = r.reliability.find((x) => x.command === "recall");
    expect(recall?.failureRate).toBeCloseTo(1, 5);
  });
  it("empty rows -> empty rollup, all visible commands unused", () => {
    const r = rollup([], visible);
    expect(r.topCommands).toEqual([]);
    expect(r.activeDays).toBe(0);
    expect(r.unusedSurface.sort()).toEqual([...visible].sort());
  });
});
```

- [ ] **Step 2: Run it, verify FAIL.**

- [ ] **Step 3: Implement** `apps/axctl/src/usage/query.ts`:

```typescript
import { Effect } from "effect";
import type { DbError } from "@ax/lib/errors";
import { SurrealClient } from "@ax/lib/db";

export interface InvocationRow {
  readonly ts: string;       // ISO
  readonly command: string;
  readonly origin: "tty" | "agent";
  readonly exit_code: number;
}

export interface UsageRollup {
  readonly windowDays: number;
  readonly total: number;
  readonly activeDays: number;
  readonly topCommands: ReadonlyArray<{ command: string; count: number; last_used: string }>;
  readonly unusedSurface: ReadonlyArray<string>;
  readonly originSplit: { agent: number; tty: number };
  readonly reliability: ReadonlyArray<{ command: string; runs: number; failures: number; failureRate: number }>;
}

const utcDay = (iso: string): string => iso.slice(0, 10);

/** Pure rollup over decoded rows + the visible-command list (for unusedSurface). */
export const rollup = (rows: ReadonlyArray<InvocationRow>, visibleCommands: ReadonlyArray<string>, windowDays = 30): UsageRollup => {
  const byCommand = new Map<string, { count: number; last: string; failures: number }>();
  const days = new Set<string>();
  let agent = 0, tty = 0;
  for (const r of rows) {
    days.add(utcDay(r.ts));
    if (r.origin === "tty") tty++; else agent++;
    const e = byCommand.get(r.command) ?? { count: 0, last: r.ts, failures: 0 };
    e.count++;
    if (r.ts > e.last) e.last = r.ts;
    if (r.exit_code !== 0) e.failures++;
    byCommand.set(r.command, e);
  }
  const topCommands = [...byCommand.entries()]
    .map(([command, e]) => ({ command, count: e.count, last_used: e.last }))
    .sort((a, b) => b.count - a.count || (a.command < b.command ? -1 : 1));
  const invoked = new Set(byCommand.keys());
  const unusedSurface = visibleCommands.filter((c) => !invoked.has(c));
  const reliability = [...byCommand.entries()]
    .map(([command, e]) => ({ command, runs: e.count, failures: e.failures, failureRate: e.failures / e.count }))
    .filter((x) => x.failures > 0)
    .sort((a, b) => b.failureRate - a.failureRate);
  return {
    windowDays, total: rows.length, activeDays: days.size,
    topCommands, unusedSurface, originSplit: { agent, tty }, reliability,
  };
};

/** Fetch invocation rows within the window from the DB. */
export const fetchInvocations = (windowDays: number): Effect.Effect<InvocationRow[], DbError, SurrealClient> =>
  Effect.gen(function* () {
    const db = yield* SurrealClient;
    const result = yield* db.query<[InvocationRow[]]>(
      `SELECT type::string(ts) AS ts, command, origin, exit_code FROM ax_invocation WHERE ts > time::now() - ${Math.max(1, Math.trunc(windowDays))}d;`,
    );
    return result?.[0] ?? [];
  });
```

> Implementer note: confirm the `db.query` shape + `type::string(ts)` idiom against an existing query (e.g. `apps/axctl/src/queries/thinking-analytics.ts`). `rollup` is pure and fully tested; `fetchInvocations` is the thin DB adapter. The caller supplies `visibleCommands` (Task 7 / the dashboard route) so `query.ts` needs no subprocess.

- [ ] **Step 4: Run test, verify PASS.**

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/usage/query.ts apps/axctl/src/usage/query.test.ts
git commit -m "feat(usage): utilization rollups (activity/top/unused/origin/reliability)"
```

---

## Task 7: `ax usage` CLI + docs + both cli-reference gates

**Files:**
- Create: `apps/axctl/src/cli/commands/usage.ts`
- Modify: `apps/axctl/src/cli/index.ts` (register command + runtime)
- Modify: `README.md` OR `docs/cli.md`; `apps/site/public/llms.txt`; `apps/site/app/routes/docs/-cli-reference.data.ts`
- Test: `apps/axctl/src/cli/commands/usage.test.ts`

- [ ] **Step 1: Write the failing test** (pure renderer):

```typescript
// apps/axctl/src/cli/commands/usage.test.ts
import { describe, expect, it } from "bun:test";
import { renderUsage } from "./usage.ts";
import type { UsageRollup } from "../../usage/query.ts";

const roll: UsageRollup = {
  windowDays: 30, total: 5, activeDays: 3,
  topCommands: [{ command: "digest", count: 3, last_used: "2026-06-15T11:00:00.000Z" }],
  unusedSurface: ["quota", "thinking"],
  originSplit: { agent: 4, tty: 1 },
  reliability: [],
};

describe("renderUsage", () => {
  it("summarizes active days, top command, and unused count", () => {
    const out = renderUsage(roll);
    expect(out).toContain("3 active days");
    expect(out).toContain("digest");
    expect(out).toContain("2 never used");
  });
  it("empty-state line when nothing recorded", () => {
    const empty: UsageRollup = { ...roll, total: 0, activeDays: 0, topCommands: [], originSplit: { agent: 0, tty: 0 } };
    expect(renderUsage(empty)).toContain("no usage recorded yet");
  });
});
```

- [ ] **Step 2: Run it, verify FAIL.**

- [ ] **Step 3: Implement** `apps/axctl/src/cli/commands/usage.ts`. Mirror `apps/axctl/src/cli/commands/digest.ts` (read it) for the `Command.make` + `RuntimeManifest` + `jsonFlag` pattern. The visible-command list for `unusedSurface` comes from the CLI's own registered subcommands - reuse the existing helper if importable, else derive from `rootCommand`. Simplest: import `visibleSubcommands` is a script (spawns a subprocess) - avoid. Instead read the command names from the same registry the CLI builds. Grep `rootCommand` in `apps/axctl/src/cli/index.ts`; if its subcommand names are exportable, use them; otherwise hardcode-free fallback: pass the `COMMAND_NAMES` from `apps/site/app/routes/docs/-cli-reference.data.ts` (already the curated visible set).

```typescript
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { prettyPrint } from "@ax/lib/json";
import { COMMAND_NAMES } from "../../../../site/app/routes/docs/-cli-reference.data.ts"; // implementer: verify this relative path resolves; if not, see note
import { fetchInvocations, rollup, type UsageRollup } from "../../usage/query.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { jsonFlag } from "./shared.ts";

export const renderUsage = (r: UsageRollup): string => {
  if (r.total === 0) return "[ax] no usage recorded yet - run some ax commands, then ingest.";
  const top = r.topCommands.slice(0, 8).map((c) => `  ${c.command.padEnd(22)} ${String(c.count).padStart(5)}`).join("\n");
  return [
    `[ax] usage (${r.windowDays}d): ${r.total} runs across ${r.activeDays} active days  (agent ${r.originSplit.agent} / tty ${r.originSplit.tty})`,
    "top commands:", top,
    `${r.unusedSurface.length} never used: ${r.unusedSurface.slice(0, 12).join(", ")}`,
  ].join("\n");
};

const cmdUsage = (input: { json: boolean; days: number }) =>
  Effect.gen(function* () {
    const rows = yield* fetchInvocations(input.days);
    const r = rollup(rows, COMMAND_NAMES, input.days);
    console.log(input.json ? prettyPrint(r) : renderUsage(r));
  });

export const usageCommand = Command.make(
  "usage",
  { json: jsonFlag, days: Flag.integer("days").pipe(Flag.withDefault(30)) },
  ({ json, days }) => cmdUsage({ json, days }),
).pipe(
  Command.withDescription(
    "Your ax utilization: commands/day, active days, top commands, agent-vs-tty split, and the never-used surface. --json  --days=N (default 30)",
  ),
);

export const usageRuntime: RuntimeManifest = { usage: { runtime: "db", hidden: false } };
```

> Implementer note: the cross-package import of `COMMAND_NAMES` from the site app may not resolve cleanly from axctl (different workspace). If it doesn't typecheck, the cleanest fix is to add a tiny exported `VISIBLE_COMMANDS` array in `apps/axctl/src/cli/` (or export the names the CLI already registers) and use that as the single source - then also have `-cli-reference.data.ts` / the freshness checks consume it if practical. Do NOT spawn `ax help` from inside a command. Keep `renderUsage` pure + tested regardless of where the command list comes from.

- [ ] **Step 4: Register** in `apps/axctl/src/cli/index.ts`: import `{ usageCommand, usageRuntime }`, add `...usageRuntime` to the runtime spread, add `usageCommand` to the subcommand list (mirror how `digestCommand` was added - grep `digestCommand` / `digestRuntime`).

- [ ] **Step 5: Document `ax usage` in BOTH cli-reference gates + the human docs** (this is the #414 lesson - there are TWO gates):
  1. `docs/cli.md` - add an `## Utilization` section describing `ax usage [--json] [--days=N]`.
  2. `apps/site/public/llms.txt` - add a `- \`ax usage\` - ...` line near the cost/analytics block.
  3. `apps/site/app/routes/docs/-cli-reference.data.ts` - add a `usage` card to a group (mirror the `digest` card that already exists there: `name`, `job`, `signature: "ax usage [--json] [--days=N]"`, `flags`, `receipt`, `detail`; no "axctl" in copy; no `/Users/` paths).

- [ ] **Step 6: Verify both gates + tests**

Run: `bun test apps/axctl/src/cli/commands/usage.test.ts` → PASS.
Run: `bun scripts/check-cli-reference.ts` → covers `ax usage`.
Run: `bun test scripts/check-site-cli-reference.test.ts` → PASS (usage card present).
Run: `bun run typecheck 2>&1 | rg -c "error TS"` → 0.
Run: `bun run apps/axctl/src/cli/index.ts usage --help` → shows the command.

- [ ] **Step 7: Commit**

```bash
git add apps/axctl/src/cli/commands/usage.ts apps/axctl/src/cli/commands/usage.test.ts apps/axctl/src/cli/index.ts docs/cli.md apps/site/public/llms.txt apps/site/app/routes/docs/-cli-reference.data.ts
git commit -m "feat(usage): ax usage CLI + docs + both cli-reference gates"
```

---

## Task 8: Dashboard `/api/usage` route (functional-minimal)

**Files:**
- Modify/Create: a route under `apps/axctl/src/dashboard/router/routes/` + contract under `apps/axctl/src/dashboard/contract/` (mirror an existing read route, e.g. `insights.ts` / `system.ts`)
- Test: alongside the route (mirror `*.test.ts` siblings)

> Scope per spec's Visual scope note: this task ships the BACKEND route returning the rollup JSON + a MINIMAL studio view. Do NOT invest in heavy visual design - correct data + restrained layout only; the visual pass is deferred for the user's review.

- [ ] **Step 1: Read an existing read-only route + its test** - `apps/axctl/src/dashboard/router/routes/system.ts` + `system.test.ts` and `apps/axctl/src/dashboard/contract/insights.ts` to learn the route/contract registration pattern (how a GET handler is declared, how it runs a query with the DB layer, how it's tested).

- [ ] **Step 2: Write the failing test** for the route handler - assert `GET /api/usage` returns the rollup shape (status 200, JSON has `activeDays`, `topCommands`, `unusedSurface`, `originSplit`). Mirror the exact test harness the sibling route tests use (they construct the handler and invoke it without a live server). Use a seeded/fake DB layer the same way the sibling tests do.

- [ ] **Step 3: Implement the handler** - a GET that runs `fetchInvocations` + `rollup` (reuse Task 6; supply the visible-command list the same way Task 7 did) and returns the `UsageRollup` as JSON. Register it in the route table next to the other `/api/*` reads. Keep it read-only.

- [ ] **Step 4: Minimal studio view** - if the studio SPA (`apps/studio` per CLAUDE.md / the stage-studio build) has a simple pattern for adding a tab/route that fetches a JSON endpoint and renders tiles, add a "Utilization" view that fetches `/api/usage` and renders: active-days + total, a top-commands list, and the never-used chips. Restrained layout, no bespoke visuals. If wiring a new studio route is non-trivial or risks the build, STOP and report DONE_WITH_CONCERNS - the backend route + `ax usage` already expose the data, and the visual is explicitly deferred for review.

- [ ] **Step 5: Verify**

Run: `bun test <the new route test>` → PASS.
Run: `bun run typecheck 2>&1 | rg -c "error TS"` → 0.
Run (if studio touched): `bunx turbo run build --filter=@ax/site 2>&1 | tail -5` OR the stage-studio script - confirm the build still succeeds.

- [ ] **Step 6: Commit**

```bash
git add apps/axctl/src/dashboard/ apps/studio/ 2>/dev/null
git commit -m "feat(usage): /api/usage dashboard route + minimal utilization view"
```

---

## Task 9: Full verification + spec checklist

- [ ] **Step 1: e2e** - real invocation → ingest → query:
```bash
rm -f ~/.ax/usage-log.jsonl
bun run apps/axctl/src/cli/index.ts version >/dev/null 2>&1
bun run apps/axctl/src/cli/index.ts digest --json >/dev/null 2>&1 || true
bun run apps/axctl/src/cli/index.ts ingest --stages=usage 2>&1 | tail -2
bun run apps/axctl/src/cli/index.ts usage --days=1
```
Expected: `ax usage` prints a board with the just-run commands, an active-day, and a never-used list. Paste the output.

- [ ] **Step 2: Full gates**
```bash
bun test 2>&1 | tail -6
bun run typecheck 2>&1 | rg -c "error TS"
bun scripts/check-cli-reference.ts 2>&1 | tail -1
```
Expected: tests pass (only pre-existing DB-dependent failures, if any - confirm none are usage-related); 0 typecheck errors; cli-reference covers `ax usage`.

- [ ] **Step 3: Tick the spec checklist** in `docs/superpowers/specs/2026-06-15-usage-telemetry-design.md` (`[ ]` → `[x]`), commit.

```bash
git add docs/superpowers/specs/2026-06-15-usage-telemetry-design.md
git commit -m "chore(usage): e2e verification + tick spec checklist"
```

---

## Self-Review Notes

- **Spec coverage:** schema (T1), model/JSONL (T2), redaction+capture (T3+T4), stage+truncate+isolation (T5), rollups (T6), CLI+docs+gates (T7), dashboard route+minimal view (T8), e2e (T9). All spec sections mapped.
- **Privacy:** redaction is pure + heavily tested in T3 (no positional values, flag names only, basename-only repo_key). The "no /Users path, no positional value survives" assertion is the safety net.
- **Isolation:** the usage stage mirrors the digest stage's `Effect.catchCause` so a telemetry fault never aborts ingest (T5).
- **CI gotchas carried from #414:** BOTH cli-reference gates + the `effect-cli.test.ts` stage count are updated in-plan (T5 + T7) - the exact things that failed #414's CI.
- **Known implementer judgment calls (flagged, not placeholders):** the visible-command source for `unusedSurface` (T7 note - prefer a single exported list over a cross-package import or subprocess); the studio view depth (T8 - explicitly minimal, may report DONE_WITH_CONCERNS); `Effect.onExit` exact API (T4 note - fallback given).
