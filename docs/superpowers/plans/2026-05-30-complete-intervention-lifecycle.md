# Complete Intervention Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the manual-safe Intervention Lifecycle so `guidance`, `skill`, `subagent`, `hook`, and `automation` proposals can move from candidate queue to accepted Intervention task briefs, reconcile through `ax improve lint`, and expose their safety state in CLI/dashboard surfaces.

**Architecture:** Keep lifecycle decisions pure in `src/improve/lifecycle.ts`; keep SurrealDB and filesystem effects in `src/improve/actions.ts`, `src/improve/lint.ts`, and CLI/dashboard adapters. Hook and automation acceptance remains manual-only: `ax improve accept` emits a task brief and experiment row, but never edits settings, hooks, LaunchAgents, cron, or shell scripts directly.

**Tech Stack:** Bun, TypeScript, Effect, SurrealDB schema, React dashboard.

---

## File Structure

- `src/improve/lifecycle.ts`: pure transition and safety contract rules.
- `src/improve/lifecycle.test.ts`: safety-contract and form-acceptance unit tests.
- `src/cli/retro-plan.ts`: CLI argument parsing and SurrealQL builder for externally drafted plans.
- `src/cli/retro-plan.test.ts`: SQL-shape and parser tests for safety contract fields.
- `src/improve/task-template.ts`: task brief renderers for all proposal forms.
- `src/improve/task-template.test.ts`: task template tests for subagent, hook, and automation forms.
- `src/improve/actions.ts`: proposal fetch, task input construction, and accept/reject/verdict effects.
- `src/improve/agent-accept.test.ts`: fake-DB accept tests for newly accepted forms.
- `src/improve/markers.ts`: marker parsing for frontmatter, inline guidance, hook commands, and automation files.
- `src/improve/markers.test.ts`: parser tests for hook and automation markers.
- `src/improve/lint.ts`: discovery and reconcile logic for grounded agent files.
- `src/improve/lint.test.ts`: lint discovery/reconcile tests for settings hooks and automation files.
- `schema/schema.surql`: safety fields already exist; verify no further schema changes are needed.
- `schema/schema.test.ts`: schema contract tests.
- `src/dashboard/server.ts`: `/api/improve` payload fields for safety contract data.
- `src/lib/shared/dashboard-types.ts`: DTO types for safety fields.
- `src/dashboard/web/src/routes/improve.tsx`: render hook and automation payloads plus safety contract fields.
- `CONTEXT.md`: update Acceptable Intervention Form if hook/automation become manually acceptable with complete safety gates.

---

### Task 1: Retro Plan Safety Contract Flags

**Files:**
- Modify: `src/cli/retro-plan.ts`
- Modify: `src/cli/retro-plan.test.ts`
- Modify: `src/improve/lifecycle.ts`
- Modify: `src/improve/lifecycle.test.ts`

- [ ] **Step 1: Write parser and builder tests**

Add tests showing `parseRetroPlanArgs` accepts:

```ts
"--recovery-path=Move generated hook out of ~/.claude/settings.json",
"--smoke-test-command=bun test src/improve/lifecycle.test.ts",
"--disable-command=mv hook.sh hook.sh.disabled",
"--failure-mode=fail_open",
```

Expected assertions:

```ts
expect(parsed.safety.recoveryPath).toBe("Move generated hook out of ~/.claude/settings.json");
expect(parsed.safety.smokeTestCommand).toBe("bun test src/improve/lifecycle.test.ts");
expect(parsed.safety.disableCommand).toBe("mv hook.sh hook.sh.disabled");
expect(parsed.safety.failureMode).toBe("fail_open");
```

Add builder assertions that `hook_proposal` and `automation_proposal` SQL include the four concrete values instead of `NONE`.

- [ ] **Step 2: Run focused tests and confirm they fail**

Run:

```bash
bun test src/cli/retro-plan.test.ts src/improve/lifecycle.test.ts
```

Expected: tests fail because `RetroPlanArgs` has no `safety` field and parser flags are ignored.

- [ ] **Step 3: Implement safety parsing**

Add a `safety` field to `RetroPlanArgs` using `InterventionSafetyContract`:

```ts
readonly safety: InterventionSafetyContract;
```

Parse flags:

```ts
const safety = {
    recoveryPath: flagValue(args, "recovery-path") ?? null,
    smokeTestCommand: flagValue(args, "smoke-test-command") ?? null,
    disableCommand: flagValue(args, "disable-command") ?? null,
    failureMode: flagValue(args, "failure-mode") ?? null,
};
```

Reject invalid `--failure-mode` values with:

```ts
fail("--failure-mode must be one of: fail_open, fail_closed");
```

- [ ] **Step 4: Thread safety through registration and payload SQL**

Call:

```ts
const registration = planRetroPlanRegistration({
    form: args.form,
    leaveOpen: args.leaveOpen,
    safetyContract: args.safety,
});
```

Write hook/automation payload fields using:

```ts
["recovery_path", surrealOptionString(args.safety.recoveryPath ?? null)],
["smoke_test_command", surrealOptionString(args.safety.smokeTestCommand ?? null)],
["disable_command", surrealOptionString(args.safety.disableCommand ?? null)],
["failure_mode", surrealOptionString(args.safety.failureMode ?? null)],
```

- [ ] **Step 5: Verify and commit**

Run:

```bash
bun test src/cli/retro-plan.test.ts src/improve/lifecycle.test.ts
bun run typecheck
```

Commit:

```bash
git add src/cli/retro-plan.ts src/cli/retro-plan.test.ts src/improve/lifecycle.ts src/improve/lifecycle.test.ts
git commit -m "thread safety contract through retro plan"
```

### Task 2: Accept All Manual-Safe Intervention Forms

**Files:**
- Modify: `CONTEXT.md`
- Modify: `src/improve/lifecycle.ts`
- Modify: `src/improve/lifecycle.test.ts`
- Modify: `src/improve/actions.ts`
- Modify: `src/improve/agent-accept.test.ts`
- Modify: `src/improve/task-template.ts`
- Create: `src/improve/task-template.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Add tests:

```ts
expect(planAcceptCandidate({
    form: "hook",
    proposalStatus: "open",
    autoScaffold: false,
    safetyContract: {
        recoveryPath: "remove settings hook",
        smokeTestCommand: "bun test",
        disableCommand: "mv hook.sh hook.sh.disabled",
        failureMode: "fail_open",
    },
})).toEqual({ status: "ok", experimentStatus: "task_emitted" });

expect(planAcceptCandidate({
    form: "automation",
    proposalStatus: "open",
    autoScaffold: false,
    safetyContract: null,
})).toEqual({
    status: "unsupported_form",
    message: "automation proposals stay open until safety gates are modeled: Recovery Path, smoke test, disable switch, failure mode",
});
```

- [ ] **Step 2: Write failing template tests**

Create `src/improve/task-template.test.ts` with assertions:

```ts
expect(renderTaskFile(hookInput)).toContain("form=hook");
expect(renderTaskFile(hookInput)).toContain("echo 'ax:hook_sig'");
expect(renderTaskFile(hookInput)).toContain("Recovery Path");
expect(renderTaskFile(automationInput)).toContain("form=automation");
expect(renderTaskFile(automationInput)).toContain("<!-- ax:automation_sig experiment:experiment:auto -->");
expect(renderTaskFile(subagentInput)).toContain("form=subagent");
expect(renderTaskFile(subagentInput)).toContain("ax_experiment: experiment:subagent");
```

- [ ] **Step 3: Run tests and confirm failure**

Run:

```bash
bun test src/improve/lifecycle.test.ts src/improve/task-template.test.ts src/improve/agent-accept.test.ts
```

Expected: failures because templates throw and hook/automation are not acceptable.

- [ ] **Step 4: Extend lifecycle acceptance**

Change `planAcceptCandidate` to accept:

```ts
readonly safetyContract?: InterventionSafetyContract | null;
```

Rules:

- `guidance`, `skill`, and `subagent` accept when status is `open`.
- `hook` and `automation` accept only when `missingInterventionSafetyGates` returns `[]`.
- `autoScaffold` is still allowed only for `skill`; other forms emit task briefs.

- [ ] **Step 5: Fetch payloads and build task inputs**

Update `fetchFullProposal` to select:

```sql
(SELECT * FROM subagent_proposal WHERE proposal = $parent.id LIMIT 1)[0] AS subagent_payload,
(SELECT * FROM hook_proposal WHERE proposal = $parent.id LIMIT 1)[0] AS hook_payload,
(SELECT * FROM automation_proposal WHERE proposal = $parent.id LIMIT 1)[0] AS automation_payload
```

Extend `buildTaskInput` for:

- `subagent`: target `~/.claude/agents/<dedupe_sig>.md`.
- `hook`: target `~/.claude/settings.json`; include command with `echo 'ax:<id>' && ...`.
- `automation`: target `.ax/interventions/<dedupe_sig>/AUTOMATION.md`; include plist and cron marker examples.

- [ ] **Step 6: Render task templates**

Implement non-throwing template branches for `subagent`, `hook`, and `automation`.

Hook template must include:

```json
{ "command": "echo 'ax:<id>' && <hook_command>" }
```

Automation template must include both marker examples:

```xml
<!-- ax:<id> experiment:<experimentId> -->
```

```cron
# ax:<id> experiment:<experimentId>
```

- [ ] **Step 7: Accept tests for forms**

Add fake DB tests proving:

- `subagent` emits a task and marks accepted.
- safety-complete `hook` emits a task.
- safety-incomplete `hook` returns `unsupported_form`.
- safety-complete `automation` emits a task.

- [ ] **Step 8: Update domain language**

Update `CONTEXT.md` so **Acceptable Intervention Form** says hook and automation are acceptable only as manual task briefs when the Intervention Safety Contract is complete; direct auto-apply remains unavailable.

- [ ] **Step 9: Verify and commit**

Run:

```bash
bun test src/improve/lifecycle.test.ts src/improve/task-template.test.ts src/improve/agent-accept.test.ts
bun run typecheck
```

Commit:

```bash
git add CONTEXT.md src/improve/lifecycle.ts src/improve/lifecycle.test.ts src/improve/actions.ts src/improve/agent-accept.test.ts src/improve/task-template.ts src/improve/task-template.test.ts
git commit -m "accept manual intervention task forms"
```

### Task 3: Lint Markers for Subagent, Hook, and Automation

**Files:**
- Modify: `src/improve/markers.ts`
- Create/modify: `src/improve/markers.test.ts`
- Modify: `src/improve/lint.ts`
- Modify: `src/improve/lint.test.ts`

- [ ] **Step 1: Write marker parser tests**

Add tests for:

```ts
parseHookCommandMarkers("echo 'ax:hook_sig' && bash hook.sh")
parseAutomationMarkers("<!-- ax:auto_sig experiment:experiment:auto -->")
parseAutomationMarkers("# ax:auto_sig experiment:experiment:auto")
```

Expected IDs:

```ts
{ id: "hook_sig" }
{ id: "auto_sig", experiment: "experiment:auto" }
```

- [ ] **Step 2: Write lint discovery tests**

Create fixtures:

- `<root>/settings.json` with a hook command containing `echo 'ax:hook_sig'`.
- `<root>/LaunchAgents/com.ax.test.plist` with XML marker.
- `<root>/cron/ax-test.cron` with `# ax:auto_sig experiment:experiment:auto`.

Assert `discoverFiles({ roots: [root] })` tags them as `hook` and `automation`.

- [ ] **Step 3: Run tests and confirm failure**

Run:

```bash
bun test src/improve/markers.test.ts src/improve/lint.test.ts
```

Expected: missing parser/discovery failures.

- [ ] **Step 4: Implement parsers**

Add:

```ts
export interface ExternalMarker {
    readonly id: string;
    readonly experiment?: string;
}

export const parseHookCommandMarkers = (source: string): ExternalMarker[] => ...
export const parseAutomationMarkers = (source: string): ExternalMarker[] => ...
```

Use regex:

```ts
/\bax:([a-z0-9_-]+)\b/g
/\bexperiment:(experiment:[a-z0-9_:-]+)\b/
```

- [ ] **Step 5: Extend discovery and collectIds**

In `lint.ts`:

- Add `hook` and `automation` to `LintForm`.
- Discover `settings.json` and `.claude/settings.json` as hook targets.
- Discover `LaunchAgents/*.plist`, `cron/*`, and `automations/*` as automation targets.
- For `hook`, parse JSON and scan command strings with `parseHookCommandMarkers`.
- For `automation`, scan file text with `parseAutomationMarkers`.

- [ ] **Step 6: Verify and commit**

Run:

```bash
bun test src/improve/markers.test.ts src/improve/lint.test.ts
bun run typecheck
```

Commit:

```bash
git add src/improve/markers.ts src/improve/markers.test.ts src/improve/lint.ts src/improve/lint.test.ts
git commit -m "lint intervention markers for all forms"
```

### Task 4: Surface Safety State in Show, API, and Dashboard

**Files:**
- Modify: `src/improve/show.ts`
- Create/modify: `src/improve/show.test.ts`
- Modify: `src/dashboard/server.ts`
- Modify: `src/lib/shared/dashboard-types.ts`
- Modify: `src/dashboard/web/src/routes/improve.tsx`

- [ ] **Step 1: Write show formatter tests**

Add tests that a hook proposal with missing safety fields prints:

```text
Safety gates missing: Recovery Path, smoke test, disable switch, failure mode
```

and a complete safety contract prints all four values.

- [ ] **Step 2: Update show query and formatter**

Fetch `hook_payload` and `automation_payload` with safety fields. Add a `safety` section to `formatShow`.

- [ ] **Step 3: Update dashboard DTO and server query**

Add safety fields to `HookProposalPayload` and `AutomationProposalPayload`, then select those fields in `/api/improve`.

- [ ] **Step 4: Render hook and automation payloads**

Extend `PayloadView` to show:

- hook event/tool/command
- automation trigger/schedule/action
- safety gates and failure mode

- [ ] **Step 5: Verify and commit**

Run:

```bash
bun test src/improve/show.test.ts src/dashboard/web/src/routes/sessions.test.ts src/dashboard/web/src/routes/inspector-filters.test.ts
bun run typecheck
```

Commit:

```bash
git add src/improve/show.ts src/improve/show.test.ts src/dashboard/server.ts src/lib/shared/dashboard-types.ts src/dashboard/web/src/routes/improve.tsx
git commit -m "surface intervention safety state"
```

### Task 5: End-to-End Dogfood and Final Verification

**Files:**
- Modify only if dogfood exposes a defect in files from Tasks 1-4.

- [ ] **Step 1: No-DB semantic dogfood**

Run a Bun one-liner that builds `retro plan` statements for all forms and prints `{ form, status, experiment, safetyMessage }`.

- [ ] **Step 2: Fake-DB accept/lint dogfood**

Run:

```bash
bun test src/improve/agent-accept.test.ts src/improve/lint.test.ts
```

- [ ] **Step 3: Full verification**

Run:

```bash
bun run typecheck
bun run dashboard:build
bun test
```

- [ ] **Step 4: Final commit if dogfood fixes were needed**

If any fixes were made:

```bash
git add <changed-files>
git commit -m "fix intervention lifecycle dogfood issues"
```

If no fixes were needed, do not create an empty commit.

---

## Self-Review

Spec coverage:

- Candidate queue to accepted Intervention task brief: Tasks 1-2.
- Safety-gated hook/automation acceptance: Tasks 1-2.
- Marker reconciliation after manual application: Task 3.
- CLI/dashboard visibility: Task 4.
- Dogfood and smoke test: Task 5.

Placeholder scan:

- No `TBD`, `TODO`, or "similar to" instructions remain.
- Every phase has explicit files, commands, and expected behavior.

Type consistency:

- `InterventionSafetyContract` uses `recoveryPath`, `smokeTestCommand`, `disableCommand`, and `failureMode`.
- Schema/SurrealQL fields use `recovery_path`, `smoke_test_command`, `disable_command`, and `failure_mode`.
