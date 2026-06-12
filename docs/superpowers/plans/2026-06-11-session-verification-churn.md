# Session Verification Churn Insight Implementation Plan

> Required execution mode: `superpowers:subagent-driven-development`. Implement task-by-task, with a worker per implementation slice and reviewer passes after each slice.

## Goal

Ship a first aggregate signal for "agent wrote code, verification complained, agent repaired it" using data ax already ingests.

User-facing command:

```bash
ax sessions churn --here --since=30
ax sessions churn --source=claude --since=7
ax sessions churn --json
```

The command reports:

- aggregate rows by provider source;
- a bounded "hot sessions" list ranked by verification failures and repair churn;
- separate landed LOC, edit churn LOC, and repair churn LOC so attempted edits are not mislabeled as git-landed diff.

## Non-Goals

- No schema migration in v1.
- No tokei language/comment classification in v1.
- No dashboard UI in v1.
- No per-file repair attribution in v1.

## Existing Data Sources

- `session_metrics.lines_added` / `session_metrics.lines_removed`: edit-class tool-call churn already derived by ingest.
- `produced -> touched`: landed git diff line counts (`touched.additions`, `touched.deletions`) by session.
- `command_outcome`: derived shell command outcomes. Failed test/typecheck/lint/build/check commands are `kind = "expected_feedback"` with `status = "error"`; successful commands are `kind = "success"` with `status = "ok"`.
- `hook_command_invocation`: provider hook commands. Blocked/nonzero invocations are verification failures; successful/nonblocking invocations can close an episode.
- `tool_call`: edit events with timestamps and input JSON. Use the existing edit-tool classification helpers and `applyPatchDelta`/`editDelta` logic.

## Files

Create:

- `apps/axctl/src/metrics/session-churn.ts`
- `apps/axctl/src/metrics/session-churn.test.ts`

Modify:

- `apps/axctl/src/cli/commands/sessions.ts`
- `apps/axctl/src/cli/effect-cli.test.ts`

## Semantics

### Check Family Normalization

`normalizeCheckFamily(raw: string | null): string | null`

Rules:

- `oxlint`, `oxc`, hook names/commands containing `oxlint` -> `oxlint`
- `eslint` -> `eslint`
- `tsc`, `typecheck`, `tsgo` -> `typecheck`
- `bun test`, `vitest`, `jest`, `playwright`, `test` -> `test`
- `build` -> `build`
- `check` -> `check`
- otherwise `null`

Use the command text first when available, then command norm/tool/hook name.

### Event Model

Use a pure event stream before any aggregation:

```ts
export interface ChurnEvent {
    readonly session: string;
    readonly source: string | null;
    readonly tsMs: number;
    readonly kind: "edit" | "verification_fail" | "verification_pass";
    readonly check: string | null;
    readonly linesAdded: number;
    readonly linesRemoved: number;
}
```

Edit events carry line deltas and `check = null`.

Verification events carry `check != null` and zero line deltas.

### Episode Rules

`computeSessionChurn(events, landedBySession, healthBySession)`

- Sort events by `(session, tsMs)`.
- A repair episode starts at a verification failure only if the same session has at least one prior edit event.
- Subsequent edit events count as repair churn until:
  - a verification pass for the same check family closes the episode; or
  - the session ends.
- A later pass marks the episode `passed = true`; no later pass keeps the episode and `passed = false`.
- Repeated failures of the same check while an episode is open increment failure count but do not double-count already-counted edits.
- Multiple open check families may exist; one edit after failures can count toward each open episode only if the checks are distinct. The session-level `repairLinesAdded/Removed` must dedupe edit event ids or timestamps so one edit is not counted twice in the headline totals.

### Output Rows

Session row:

```ts
export interface SessionChurnRow {
    readonly session: string;
    readonly source: string | null;
    readonly taskLabel: string | null;
    readonly landedLinesAdded: number;
    readonly landedLinesRemoved: number;
    readonly editLinesAdded: number;
    readonly editLinesRemoved: number;
    readonly repairLinesAdded: number;
    readonly repairLinesRemoved: number;
    readonly editEvents: number;
    readonly verificationFailures: number;
    readonly verificationPasses: number;
    readonly episodes: number;
    readonly passedEpisodes: number;
    readonly topCheck: string | null;
}
```

Aggregate row:

```ts
export interface SourceChurnAggregate {
    readonly source: string;
    readonly sessions: number;
    readonly sessionsWithFailures: number;
    readonly landedLinesAdded: number;
    readonly landedLinesRemoved: number;
    readonly editLinesAdded: number;
    readonly editLinesRemoved: number;
    readonly repairLinesAdded: number;
    readonly repairLinesRemoved: number;
    readonly verificationFailures: number;
    readonly episodes: number;
    readonly passedEpisodes: number;
    readonly topCheck: string | null;
}
```

Payload:

```ts
export interface SessionChurnSummary {
    readonly generatedAt: string;
    readonly filters: {
        readonly since: string | null;
        readonly project: string | null;
        readonly source: string | null;
        readonly limit: number;
    };
    readonly aggregates: SourceChurnAggregate[];
    readonly hotSessions: SessionChurnRow[];
}
```

### Formatting

Plain output:

```text
verification churn by source
source  sess  fail-sess  fails  episodes  pass  landed    edits      repair    top
codex     32         11     44        18    12  +120/-8  +980/-210  +310/-90  typecheck

hot sessions
session               source  fails  episodes  pass  landed   edits      repair    top        task
abc123...             codex      12         4     3  +10/-2  +220/-80  +90/-40   oxlint     ...
```

Empty output should say:

```text
no verification churn rows matched (run `ax ingest`, or loosen --since/--source/--here).
```

JSON output should be `prettyPrint(summary)`.

## Fetcher Shape

`fetchSessionChurnSummary(input)` in `session-churn.ts`.

Input:

```ts
export interface FetchSessionChurnInput {
    readonly since: Date | null;
    readonly project: string | null;
    readonly source: string | null;
    readonly limit: number;
}
```

Queries:

1. Base sessions from `session_metrics`, filtered by `session.started_at`, `session.project/cwd`, and `session.source`.

```sql
SELECT
  type::string(session) AS session,
  session.source AS source,
  session.project AS project,
  session.cwd AS cwd,
  lines_added, lines_removed
FROM session_metrics
WHERE ...
```

2. Health map with `fetchSessionHealthMap(sessionIds)` for task labels.

3. Landed diff:

```sql
SELECT type::string(in) AS session, type::string(out) AS commit
FROM produced
WHERE in IN [session:`...`];
```

Then:

```sql
SELECT type::string(in) AS commit, additions, deletions
FROM touched
WHERE in IN [commit:`...`];
```

Join in JS: session -> commit(s) -> touched rows.

4. Edit events:

```sql
SELECT type::string(session) AS session, type::string(ts) AS ts, name, command_norm, input_json
FROM tool_call
WHERE session IN [...] AND <editToolSqlFilter>
ORDER BY ts ASC;
```

Use `toolClassInputOf`, `isEditTool`, `isApplyPatchCall`, `canonicalEditToolName`, `applyPatchDelta`, and `editDelta`.

5. Command verification events:

```sql
SELECT type::string(session) AS session, type::string(ts) AS ts,
       command_norm, command_tool, kind, status, text
FROM command_outcome
WHERE session IN [...] AND (kind = "expected_feedback" OR status = "ok")
ORDER BY ts ASC;
```

Filter to known check families in JS. Failure when `kind = "expected_feedback"` or `status = "error"`; pass when `status = "ok"`.

6. Hook verification events:

```sql
SELECT type::string(session) AS session, type::string(ts) AS ts,
       hook_name, command, provider_status, effect, exit_code
FROM hook_command_invocation
WHERE session IN [...]
ORDER BY ts ASC;
```

Filter to known check families in JS. Failure when `provider_status = "blocking_error"` or `effect = "blocked"` or `exit_code != 0`; pass when `provider_status = "success"` and `effect != "blocked"` and `exit_code` is `0` or `NONE`.

Batch `IN` lists with existing `chunked`/`sessionRefList`. Do not use correlated edge derefs over `produced`, `touched`, or `tool_call`.

## Task 1: Pure Model and Formatting

Worker owns:

- `apps/axctl/src/metrics/session-churn.ts`
- `apps/axctl/src/metrics/session-churn.test.ts`

Steps:

1. Create the event/row/aggregate/payload interfaces.
2. Implement `normalizeCheckFamily`.
3. Implement `computeSessionChurn`.
4. Implement `formatSessionChurnSummary`.
5. Add tests for:
   - check normalization;
   - failure starts only after a prior edit;
   - repair churn after a failure and before a pass;
   - repeated failure does not double-count already-counted edits;
   - aggregate top check and pass ratio;
   - empty formatter hint.
6. Run:

```bash
bun test apps/axctl/src/metrics/session-churn.test.ts
```

Expected: pass.

## Task 2: Fetcher and CLI

Worker owns:

- `apps/axctl/src/metrics/session-churn.ts`
- `apps/axctl/src/metrics/session-churn.test.ts`
- `apps/axctl/src/cli/commands/sessions.ts`
- `apps/axctl/src/cli/effect-cli.test.ts`

Steps:

1. Add `fetchSessionChurnSummary`.
2. Add mocked-db tests proving:
   - base query filters `session.started_at`, `session.project/cwd`, and `session.source`;
   - empty base sessions skip secondary scans;
   - landed LOC joins `produced` to `touched` in JS;
   - edit tool rows become edit events with line deltas;
   - command and hook rows become verification fail/pass events.
3. Add `cmdSessionsChurn` in `apps/axctl/src/cli/commands/sessions.ts`.
4. Add `sessionsChurnCommand` with flags:

```ts
since: optionalSince,
project: Flag.string("project").pipe(Flag.optional),
here: Flag.boolean("here").pipe(Flag.withDefault(false)),
source: Flag.string("source").pipe(Flag.optional),
limit: positiveLimit(20),
json: jsonFlag,
```

5. Wire it into `sessionsCommand` subcommands and update the command description.
6. Update `effect-cli.test.ts` so the sessions subcommand exposure test includes `churn`.
7. Run:

```bash
bun test apps/axctl/src/metrics/session-churn.test.ts apps/axctl/src/cli/effect-cli.test.ts
```

Expected: pass.

## Verification

Final verification after both tasks:

```bash
bun test apps/axctl/src/metrics/session-churn.test.ts apps/axctl/src/cli/effect-cli.test.ts
bun run typecheck
apps/axctl/bin/axctl sessions churn --here --since=30 --limit=10
apps/axctl/bin/axctl sessions churn --here --since=30 --limit=3 --json
```

If full `bun run typecheck` fails from unrelated repository errors, capture the relevant filtered command:

```bash
bun run typecheck 2>&1 | rg "session-churn|cli/commands/sessions|effect-cli"
```

Expected: empty.

## Review Gates

After each implementation task:

1. Run a spec compliance review against this plan.
2. Run a code quality review focused on correctness, DB query shape, type safety, and test coverage.
3. Fix blocking findings before moving to the next task.

