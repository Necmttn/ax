# Self-Improve Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn agentctl evidence into inspectable, reversible guidance recommendations with provenance and outcome tracking.

**Architecture:** Derive signals from existing `tool_call`, `friction_event`, `diagnostic_event`, `plan`, and graph health data. Store recommendations as `guidance` plus `guidance_version`, connect them to evidence through `derived_from`, and expose conservative JSON commands before changing durable agent instruction files.

**Tech Stack:** Bun, TypeScript, Effect beta v4, SurrealDB relations, existing CLI, `bun test`, `bun run typecheck`. Before editing Effect code, run `effect-solutions list` and `effect-solutions show services-and-layers error-handling testing`.

---

## File Structure

- Create `src/self-improve/signals.ts`: pure signal derivation from rows.
- Create `src/self-improve/signals.test.ts`: tests for repeated failures, missing verification, abandoned plans.
- Create `src/self-improve/guidance.ts`: guidance record builders and SQL write statements.
- Create `src/self-improve/guidance.test.ts`: guidance SQL and provenance tests.
- Create `src/self-improve/commands.ts`: CLI command handlers for `guidance next --json`, `session summary --json`, `self-improve weekly --json`.
- Create `src/self-improve/commands.test.ts`: JSON shape and argument tests.
- Modify `schema/schema.surql`: extend `guidance_version`, add fields/indexes for status, scope, metrics, and provenance.
- Modify `src/cli/index.ts`: add command routes.
- Modify `src/dashboard/server.ts` and static app only after realtime dashboard plan exists, adding `/api/self-improve`.

## Task 1: Signal Data Model

**Files:**
- Create: `src/self-improve/signals.ts`
- Create: `src/self-improve/signals.test.ts`

- [ ] **Step 1: Write failing signal tests**

Create `src/self-improve/signals.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
    deriveRepeatedCommandFailureSignals,
    deriveVerificationGapSignals,
    type SignalInput,
} from "./signals.ts";

const base: SignalInput = {
    sessions: [{ id: "session:one", project: "agentctl", startedAt: "2026-05-10T00:00:00.000Z" }],
    toolCalls: [],
    planSnapshots: [],
};

describe("self-improve signals", () => {
    test("deriveRepeatedCommandFailureSignals groups repeated failing commands", () => {
        const signals = deriveRepeatedCommandFailureSignals({
            ...base,
            toolCalls: [
                { sessionId: "session:one", commandNorm: "bun test", hasError: true, ts: "2026-05-10T00:00:00.000Z" },
                { sessionId: "session:one", commandNorm: "bun test", hasError: true, ts: "2026-05-10T00:01:00.000Z" },
                { sessionId: "session:one", commandNorm: "bun test", hasError: true, ts: "2026-05-10T00:02:00.000Z" },
            ],
        }, 3);
        expect(signals).toHaveLength(1);
        expect(signals[0].kind).toBe("repeated_command_failure");
        expect(signals[0].metrics.failureCount).toBe(3);
    });

    test("deriveVerificationGapSignals flags sessions with edits and no verification command", () => {
        const signals = deriveVerificationGapSignals({
            ...base,
            toolCalls: [
                { sessionId: "session:one", commandNorm: "apply_patch", hasError: false, ts: "2026-05-10T00:00:00.000Z" },
            ],
        });
        expect(signals[0].kind).toBe("missing_verification");
    });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```sh
bun test src/self-improve/signals.test.ts
```

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement signal derivation**

Create `src/self-improve/signals.ts`:

```ts
export interface SignalInput {
    readonly sessions: readonly { readonly id: string; readonly project: string | null; readonly startedAt: string | null }[];
    readonly toolCalls: readonly {
        readonly sessionId: string;
        readonly commandNorm: string | null;
        readonly hasError: boolean;
        readonly ts: string;
    }[];
    readonly planSnapshots: readonly { readonly sessionId: string; readonly status?: string | null; readonly ts: string }[];
}

export interface DerivedSignal {
    readonly key: string;
    readonly kind: string;
    readonly subjectType: string;
    readonly subjectId: string;
    readonly text: string;
    readonly metrics: Record<string, number>;
    readonly evidenceIds: readonly string[];
    readonly ts: string;
}

function hashKey(value: string): string {
    return Bun.hash(value).toString(16).padStart(16, "0");
}

export function deriveRepeatedCommandFailureSignals(input: SignalInput, threshold = 3): DerivedSignal[] {
    const groups = new Map<string, typeof input.toolCalls>();
    for (const call of input.toolCalls) {
        if (!call.hasError || !call.commandNorm) continue;
        const key = `${call.sessionId}|${call.commandNorm}`;
        groups.set(key, [...(groups.get(key) ?? []), call]);
    }
    return [...groups.entries()]
        .filter(([, calls]) => calls.length >= threshold)
        .map(([key, calls]) => {
            const [sessionId, commandNorm] = key.split("|");
            return {
                key: `signal__${hashKey(key)}`,
                kind: "repeated_command_failure",
                subjectType: "command",
                subjectId: commandNorm,
                text: `Command ${commandNorm} failed ${calls.length} times in ${sessionId}.`,
                metrics: { failureCount: calls.length },
                evidenceIds: calls.map((call) => `${call.sessionId}:${call.ts}`),
                ts: calls.at(-1)?.ts ?? new Date(0).toISOString(),
            };
        });
}

export function deriveVerificationGapSignals(input: SignalInput): DerivedSignal[] {
    const verifyPattern = /\\b(test|typecheck|lint|verify|check)\\b/i;
    return input.sessions.flatMap((session) => {
        const calls = input.toolCalls.filter((call) => call.sessionId === session.id);
        const hadEdit = calls.some((call) => call.commandNorm === "apply_patch" || call.commandNorm?.includes("git add"));
        const hadVerify = calls.some((call) => call.commandNorm !== null && verifyPattern.test(call.commandNorm));
        if (!hadEdit || hadVerify) return [];
        return [{
            key: `signal__${hashKey(`${session.id}|missing_verification`)}`,
            kind: "missing_verification",
            subjectType: "session",
            subjectId: session.id,
            text: `Session ${session.id} changed files without a detected verification command.`,
            metrics: { editCommandCount: calls.length },
            evidenceIds: calls.map((call) => `${call.sessionId}:${call.ts}`),
            ts: calls.at(-1)?.ts ?? session.startedAt ?? new Date(0).toISOString(),
        }];
    });
}

export function deriveSignalsForSelfImprove(input: SignalInput): DerivedSignal[] {
    return [
        ...deriveRepeatedCommandFailureSignals(input),
        ...deriveVerificationGapSignals(input),
    ];
}
```

- [ ] **Step 4: Run tests**

Run:

```sh
bun test src/self-improve/signals.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add src/self-improve/signals.ts src/self-improve/signals.test.ts
git commit -m "feat: derive self-improve signals"
```

## Task 2: Guidance Records and Provenance

**Files:**
- Modify: `schema/schema.surql`
- Create: `src/self-improve/guidance.ts`
- Create: `src/self-improve/guidance.test.ts`

- [ ] **Step 1: Write failing guidance tests**

Create `src/self-improve/guidance.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildGuidanceWriteStatements, guidanceFromSignal } from "./guidance.ts";

describe("guidance", () => {
    test("guidanceFromSignal creates inspectable recommendation", () => {
        const guidance = guidanceFromSignal({
            key: "signal__1",
            kind: "missing_verification",
            subjectType: "session",
            subjectId: "session:one",
            text: "Session changed files without verification.",
            metrics: { editCommandCount: 2 },
            evidenceIds: ["session:one:time"],
            ts: "2026-05-10T00:00:00.000Z",
        });
        expect(guidance.status).toBe("proposed");
        expect(guidance.scope).toBe("project");
    });

    test("buildGuidanceWriteStatements writes derived_from relation", () => {
        const statements = buildGuidanceWriteStatements(guidanceFromSignal({
            key: "signal__1",
            kind: "missing_verification",
            subjectType: "session",
            subjectId: "session:one",
            text: "Session changed files without verification.",
            metrics: { editCommandCount: 2 },
            evidenceIds: ["session:one:time"],
            ts: "2026-05-10T00:00:00.000Z",
        }));
        expect(statements.join("\\n")).toContain("guidance_version");
        expect(statements.join("\\n")).toContain("derived_from");
    });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```sh
bun test src/self-improve/guidance.test.ts
```

Expected: FAIL because module does not exist.

- [ ] **Step 3: Extend schema**

In `schema/schema.surql`, extend `guidance_version`:

```surql
DEFINE FIELD status         ON guidance_version TYPE string DEFAULT 'proposed';
DEFINE FIELD scope          ON guidance_version TYPE option<string>;
DEFINE FIELD risk           ON guidance_version TYPE option<string>;
DEFINE FIELD evidence       ON guidance_version TYPE option<string>;
DEFINE FIELD metrics_before ON guidance_version TYPE option<string>;
DEFINE FIELD metrics_after  ON guidance_version TYPE option<string>;
DEFINE INDEX guidance_version_status ON guidance_version FIELDS status, created_at;
```

- [ ] **Step 4: Implement guidance module**

Create `src/self-improve/guidance.ts`:

```ts
import type { DerivedSignal } from "./signals.ts";

export interface GuidanceDraft {
    readonly key: string;
    readonly versionKey: string;
    readonly slug: string;
    readonly title: string;
    readonly text: string;
    readonly status: "proposed";
    readonly scope: "project" | "repository" | "checkout" | "global";
    readonly risk: "low" | "medium" | "high";
    readonly evidenceIds: readonly string[];
    readonly metrics: Record<string, number>;
    readonly createdAt: string;
}

const sqlString = (value: string): string => JSON.stringify(value);
const sqlJson = (value: unknown): string => JSON.stringify(JSON.stringify(value));

function hashKey(value: string): string {
    return Bun.hash(value).toString(16).padStart(16, "0");
}

export function guidanceFromSignal(signal: DerivedSignal): GuidanceDraft {
    const slug = `${signal.kind}__${hashKey(signal.subjectId).slice(0, 12)}`;
    const title = signal.kind === "missing_verification"
        ? "Require verification after edits"
        : "Reduce repeated command failures";
    const text = signal.kind === "missing_verification"
        ? "After changing files, run the narrowest relevant verification command before reporting completion."
        : `When ${signal.subjectId} fails repeatedly, inspect the first failure before retrying.`;
    return {
        key: slug,
        versionKey: `${slug}__v1`,
        slug,
        title,
        text,
        status: "proposed",
        scope: "project",
        risk: "low",
        evidenceIds: signal.evidenceIds,
        metrics: signal.metrics,
        createdAt: signal.ts,
    };
}

export function buildGuidanceWriteStatements(guidance: GuidanceDraft): string[] {
    return [
        `UPSERT guidance:\`${guidance.key}\` MERGE { slug: ${sqlString(guidance.slug)}, title: ${sqlString(guidance.title)}, status: "proposed", updated_at: time::now() };`,
        `UPSERT guidance_version:\`${guidance.versionKey}\` CONTENT { guidance: guidance:\`${guidance.key}\`, version: "v1", text: ${sqlString(guidance.text)}, status: ${sqlString(guidance.status)}, scope: ${sqlString(guidance.scope)}, risk: ${sqlString(guidance.risk)}, evidence: ${sqlJson(guidance.evidenceIds)}, metrics_before: ${sqlJson(guidance.metrics)}, metrics_after: NONE, raw: ${sqlJson(guidance)}, created_at: d${sqlString(guidance.createdAt)} };`,
        ...guidance.evidenceIds.map((evidenceId) => {
            const edgeKey = hashKey(`${guidance.versionKey}|${evidenceId}`);
            return `RELATE guidance_version:\`${guidance.versionKey}\`->derived_from:\`${edgeKey}\`->artifact:\`${hashKey(evidenceId)}\` SET kind = "signal_evidence", labels = ${sqlJson({ evidenceId })};`;
        }),
    ];
}
```

- [ ] **Step 5: Run tests**

Run:

```sh
bun test src/self-improve/guidance.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add schema/schema.surql src/self-improve/guidance.ts src/self-improve/guidance.test.ts
git commit -m "feat: persist self-improve guidance"
```

## Task 3: Agent-Facing CLI Commands

**Files:**
- Create: `src/self-improve/commands.ts`
- Create: `src/self-improve/commands.test.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Write failing command parser tests**

Create `src/self-improve/commands.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseSelfImproveArgs } from "./commands.ts";

describe("self improve command args", () => {
    test("guidance next requires json flag for machine output", () => {
        expect(parseSelfImproveArgs("guidance", ["next", "--json"])).toEqual({ command: "guidance-next", json: true });
    });

    test("session summary accepts json flag", () => {
        expect(parseSelfImproveArgs("session", ["summary", "--json"])).toEqual({ command: "session-summary", json: true });
    });

    test("self-improve weekly accepts json flag", () => {
        expect(parseSelfImproveArgs("self-improve", ["weekly", "--json"])).toEqual({ command: "weekly", json: true });
    });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```sh
bun test src/self-improve/commands.test.ts
```

Expected: FAIL because command module does not exist.

- [ ] **Step 3: Implement command module**

Create `src/self-improve/commands.ts`:

```ts
import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";

export type SelfImproveCommand =
    | { readonly command: "guidance-next"; readonly json: boolean }
    | { readonly command: "session-summary"; readonly json: boolean }
    | { readonly command: "weekly"; readonly json: boolean };

export function parseSelfImproveArgs(root: string, args: string[]): SelfImproveCommand {
    const json = args.includes("--json");
    if (root === "guidance" && args[0] === "next") return { command: "guidance-next", json };
    if (root === "session" && args[0] === "summary") return { command: "session-summary", json };
    if (root === "self-improve" && args[0] === "weekly") return { command: "weekly", json };
    throw new Error(`unknown self-improve command: ${root} ${args.join(" ")}`);
}

export const guidanceNext = (): Effect.Effect<unknown, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const result = yield* db.query(`
SELECT id, guidance, version, text, status, scope, risk, evidence, metrics_before
FROM guidance_version
WHERE status = "proposed"
ORDER BY created_at DESC
LIMIT 5;`);
        return result?.[0] ?? [];
    });

export const sessionSummary = (): Effect.Effect<unknown, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const result = yield* db.query(`
SELECT id, project, cwd, started_at, ended_at,
    array::len((SELECT id FROM tool_call WHERE session = $parent.id)) AS tool_calls,
    array::len((SELECT id FROM tool_call WHERE session = $parent.id AND has_error = true)) AS failures
FROM session
ORDER BY (ended_at ?? started_at) DESC
LIMIT 5;`);
        return result?.[0] ?? [];
    });

export const selfImproveWeekly = (): Effect.Effect<unknown, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const result = yield* db.query(`
SELECT kind, count() AS count, time::max(ts) AS last_seen
FROM friction_event
WHERE ts > time::now() - 7d
GROUP BY kind
ORDER BY count DESC;`);
        return result?.[0] ?? [];
    });
```

- [ ] **Step 4: Wire CLI**

In `src/cli/index.ts`, import command helpers:

```ts
import { guidanceNext, parseSelfImproveArgs, selfImproveWeekly, sessionSummary } from "../self-improve/commands.ts";
```

Update help:

```txt
agentctl guidance next --json
agentctl session summary --json
agentctl self-improve weekly --json
```

In dispatch, run the selected Effect and print JSON:

```ts
if (cmd === "guidance" || cmd === "session" || cmd === "self-improve") {
    const parsed = parseSelfImproveArgs(cmd, rest);
    const effect =
        parsed.command === "guidance-next" ? guidanceNext() :
        parsed.command === "session-summary" ? sessionSummary() :
        selfImproveWeekly();
    const result = await Effect.runPromise(effect.pipe(Effect.provide(AppLayer), Effect.scoped) as Effect.Effect<unknown>);
    console.log(JSON.stringify(result, null, 2));
    return;
}
```

- [ ] **Step 5: Run tests**

Run:

```sh
bun test src/self-improve/commands.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add src/self-improve/commands.ts src/self-improve/commands.test.ts src/cli/index.ts
git commit -m "feat: add self-improve json commands"
```

## Task 4: Weekly Derivation Command

**Files:**
- Modify: `src/self-improve/commands.ts`
- Modify: `src/self-improve/commands.test.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Write failing SQL builder tests**

Add to `src/self-improve/commands.test.ts`:

```ts
import { weeklyEvidenceSql } from "./commands.ts";

test("weeklyEvidenceSql loads sessions and tool calls", () => {
    const sql = weeklyEvidenceSql(7);
    expect(sql).toContain("FROM session");
    expect(sql).toContain("FROM tool_call");
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```sh
bun test src/self-improve/commands.test.ts
```

Expected: FAIL because `weeklyEvidenceSql` does not exist.

- [ ] **Step 3: Add weekly evidence SQL and derivation**

In `src/self-improve/commands.ts`, add:

```ts
import { buildGuidanceWriteStatements, guidanceFromSignal } from "./guidance.ts";
import { deriveSignalsForSelfImprove, type SignalInput } from "./signals.ts";

export function weeklyEvidenceSql(days: number): string {
    return `
SELECT id, project, started_at AS startedAt FROM session WHERE started_at > time::now() - ${days}d;
SELECT session AS sessionId, command_norm AS commandNorm, has_error AS hasError, ts FROM tool_call WHERE ts > time::now() - ${days}d;
SELECT session AS sessionId, status, ts FROM plan_snapshot WHERE ts > time::now() - ${days}d;`;
}

export const deriveWeeklyGuidance = (days = 7): Effect.Effect<unknown, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const result = yield* db.query(weeklyEvidenceSql(days));
        const input: SignalInput = {
            sessions: (result?.[0] ?? []) as SignalInput["sessions"],
            toolCalls: (result?.[1] ?? []) as SignalInput["toolCalls"],
            planSnapshots: (result?.[2] ?? []) as SignalInput["planSnapshots"],
        };
        const guidance = deriveSignalsForSelfImprove(input).map(guidanceFromSignal);
        for (const draft of guidance) {
            yield* db.query(buildGuidanceWriteStatements(draft).join("\\n"));
        }
        return { guidanceCount: guidance.length, guidance };
    });
```

Update `selfImproveWeekly` to call `deriveWeeklyGuidance(7)`.

- [ ] **Step 4: Run tests**

Run:

```sh
bun test src/self-improve/commands.test.ts src/self-improve/signals.test.ts src/self-improve/guidance.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add src/self-improve/commands.ts src/self-improve/commands.test.ts
git commit -m "feat: derive weekly guidance"
```

## Task 5: Dashboard Self-Improve API

**Files:**
- Modify: `src/dashboard/server.ts`
- Modify: `src/dashboard/static/app.js`
- Modify: `src/dashboard/static/index.html`
- Modify: `src/dashboard/server.test.ts`

- [ ] **Step 1: Add route test**

In `src/dashboard/server.test.ts`, add:

```ts
import { dashboardApiKind } from "./server.ts";

test("dashboardApiKind recognizes self improve route", () => {
    expect(dashboardApiKind("/api/self-improve")).toBe("self-improve");
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```sh
bun test src/dashboard/server.test.ts
```

Expected: FAIL until `dashboardApiKind` recognizes this route.

- [ ] **Step 3: Add API route**

In `src/dashboard/server.ts`, add:

```ts
export function dashboardApiKind(pathname: string): "graph-health" | "worktrees" | "self-improve" | "unknown" {
    if (pathname === "/api/graph-health") return "graph-health";
    if (pathname === "/api/worktrees") return "worktrees";
    if (pathname === "/api/self-improve") return "self-improve";
    return "unknown";
}
```

In `queryApi`, handle:

```ts
if (pathname === "/api/self-improve") {
    return yield* db.query(`
SELECT id, guidance, version, text, status, scope, risk, evidence, metrics_before, metrics_after, created_at
FROM guidance_version
ORDER BY created_at DESC
LIMIT 50;`);
}
```

- [ ] **Step 4: Add UI tab**

In `src/dashboard/static/index.html`, add:

```html
<button data-view="self-improve">Self-Improve</button>
```

In `src/dashboard/static/app.js`, add:

```js
async function showSelfImprove() {
  view.innerHTML = "<h2>Self-Improve</h2><p>Loading...</p>";
  view.innerHTML = `<h2>Self-Improve</h2>${table(await fetchJson("/api/self-improve"))}`;
}
```

In the click handler:

```js
if (selected === "self-improve") await showSelfImprove();
```

- [ ] **Step 5: Run tests**

Run:

```sh
bun test src/dashboard/server.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add src/dashboard/server.ts src/dashboard/server.test.ts src/dashboard/static/index.html src/dashboard/static/app.js
git commit -m "feat: show self-improve guidance in dashboard"
```

## Task 6: Verification

**Files:**
- No new source files.

- [ ] **Step 1: Run focused tests**

Run:

```sh
bun test src/self-improve/signals.test.ts src/self-improve/guidance.test.ts src/self-improve/commands.test.ts src/dashboard/server.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full tests**

Run:

```sh
bun test
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```sh
bun run typecheck
```

Expected: exit 0.

- [ ] **Step 4: Smoke test JSON commands**

Run:

```sh
bun src/cli/index.ts guidance next --json
bun src/cli/index.ts session summary --json
bun src/cli/index.ts self-improve weekly --json
```

Expected: each command prints valid JSON and exits 0.

- [ ] **Step 5: Smoke test dashboard view**

Run:

```sh
bun src/cli/index.ts dashboard serve --port=1738
```

Open:

```txt
http://localhost:1738
```

Expected: Self-Improve tab loads guidance rows or an empty state without console or API errors.

- [ ] **Step 6: Commit verification fixes**

If fixes are needed:

```sh
git add src/self-improve src/dashboard src/cli/index.ts schema/schema.surql
git commit -m "fix: stabilize self-improve loop"
```

If no fixes are needed, do not create an empty commit.
