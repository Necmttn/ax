# Proposed fleet change: tasks control execution

This proposal adds to the permission and fleet study. It does not replace those corrections.

## Source checks

The installed 20x repository is `/Users/necmttn/Projects/20x`.
Its origin is https://github.com/peakflo/20x.
The inspected commit is `d7e9ce9533248fea017b898b63bd1ce6f4d9de7a`.
The supplied recording now provides the author discussion. The recording evidence section adds times and speaker attribution.

20x stores task state separately from session state.
Its main scheduler reads SQLite again every 60 seconds. This permits another check after a missed event.
See [task lifecycle](/Users/necmttn/Projects/20x/docs/task-lifecycle.md).
The lifecycle document describes ordered subtasks. This path does not establish general dependency scheduling.
The document also describes automatic completion, but the inspected local method returns false.
See [completion method](/Users/necmttn/Projects/20x/src/main/agent-manager.ts:3798).
Use checked source behavior when documentation differs.

Fleet already has stable chunk IDs, dependencies, conflicts, needs, acceptance conditions, and human holds.
See [chunk schema](/Users/necmttn/.dotfiles/codex/.codex/skills/fleet-ship/scripts/src/graph/Graph.ts:10).
Its `fleet next` and `fleet status` commands already report readiness and attempts.
See [commands](/Users/necmttn/.dotfiles/codex/.codex/skills/fleet-ship/scripts/fleet.ts:193).
The change extends that foundation. It does not require a new task system.

## Proposed operating contract

The task is the durable unit of work. An agent session is one execution attempt.
The task retains its identity when a model, account, machine, pane, or session changes.
The owner controls task priority, decisions, and acceptance. The scheduler controls assignment and recovery.

Each task records:

- Objective, acceptance conditions, dependencies, conflicts, and priority.
- Branch, worktree, retained artifacts, and the current commit.
- Required access, recorded authorization, routing decisions, and human holds.
- Current stage, blocker reason, responsible owner, and the next permitted action.
- Attempts, check results, review results, and retained resources.

Each attempt records its session, model, machine, access checks, start time, heartbeat, end reason, and evidence.
A running attempt holds an exclusive task claim. A replacement invalidates the previous claim before it starts writing.
An old attempt cannot publish a task result after its claim expires.
Recovery preserves the task and its files. It changes only the execution attempt.

## Scheduler sequence

1. Read the task graph, event ledger, active claims, and machine capacity.
2. Compare durable task state with live attempts and Git state.
3. Select tasks with satisfied dependencies and available required resources.
4. Verify effective access and required executables before assignment.
5. Claim the task and record its attempt before the agent starts.
6. Validate the agent result against the current commit and acceptance conditions.
7. Record completion, a specific blocker, or a bounded retry.
8. Recheck stored state after events and on each scheduler wake.

A missed event delays the next check. It must not remove the task.
An idle pane does not prove completion. A failed attempt does not remove its task.
Permission failures receive a specific blocker. Repeated attempts with the same missing access do not start.
Human holds remain visible without repeated completion-hook rejection.

## Owner view

Show tasks first. Show sessions when the owner opens a task.
Each row answers: what work remains, what blocks it, who owns the next action, and what evidence exists.

| Task | Stage | Blocker | Next action |
| --- | --- | --- | --- |
| Correct optional-null decoding | Checking | Network access absent | Restore recorded access; reuse retained work |
| Review current PR commit | Review | New commit lacks review | Assign a reviewer to the new commit |
| Verify native behavior | Waiting | Native test slot occupied | Start after the slot becomes available |

These rows illustrate the proposed view. They are not current task status claims.

## First implementation and acceptance

Use one small fleet as the first test. Keep the existing graph, ledger, fleetboard, and herdr interfaces.
Add task-to-attempt records, verified recovery, exclusive assignment, and a task status view.
Require these checks before wider use:

- A stopped agent leaves its task, worktree, evidence, and next action available.
- A replacement continues the same task without a second active writer.
- A permission change blocks assignment before useful work starts.
- An expired attempt cannot mark its task complete.
- A missed completion event is recovered from stored evidence.
- A changed commit requires a new review.
- A human hold creates one request and preserves unfinished task state.
- Task completion closes only resources owned by that task.

Fleet owns execution state. Herdr owns terminal sessions. Fleetboard owns shared claims and capacity.
Ax records session evidence and task-linked outcomes. Ax does not require an always-running execution service.
Do not create a second writable copy of task status inside the rebuildable ax cache.


## Recording evidence: triage and subtasks

Source: [AI mastermind recording](/Users/necmttn/Downloads/Hacka_%20AI%20harness%20mastermind%20-%202026_10_01%2015_00%20WITA%20-%20Recording.mp4).
Duration: 58 minutes, 29 seconds.
Embedded captions supply speaker names and four-second time ranges. Names and technical terms can contain transcription errors.
This study examines the captions and selected demonstration frames. It does not verify every spoken claim by executing the application.
Dmitry Vedenyapin presents 20x. The following times are positions within the recording.

| Time | Presenter action or explanation | Proposed fleet use |
| --- | --- | --- |
| 08:48–09:08 | Tasks define expected output fields, including a PR URL | Define required deliverables before assignment |
| 10:32–12:24 | Each task has periodic checks for reviews, comments, and other changes | Schedule checks for task progress; distinguish them from process health |
| 13:12–14:48 | Triage selects an agent, repositories, and skills using similar tasks | Add bounded triage before execution |
| 15:00–16:08 | Presenter describes feedback and skill changes; he cancels the completion action | Record feedback against task outcomes; test proposed skill changes |
| 17:04–18:36 | A parent creates focused subtasks and receives child results | Keep a parent coordinator responsible for the combined result |
| 26:48–27:16 | Parent and children remain visible together | Show task relationships and results in one view |
| 28:44–29:16 | Task operations are available through MCP | Give agents task operations with checked state transitions |
| 30:24–31:28 | Presenter describes incomplete protection against early termination | Measure failures; preserve explicit blocked outcomes |
| 31:40–32:20 | Child results cause the parent to resume review and request corrections | Resume the parent when evidence needs a decision |
| 33:00–33:24 | Another participant suggests acceptance criteria per item | Treat this as a participant suggestion, not a demonstrated 20x feature |

The frame at 13:48 shows the task during triage.
The frame at 17:45 shows child tasks inside the parent task view.
The spoken child count is unclear. This proposal does not use that count as a verified metric.
The learning cycle is described, but it does not run to completion in this demonstration.
The presenter describes to-do enforcement for OpenCode. He says Pi testing is incomplete.
This recording does not establish equivalent Codex enforcement.

### Triage is a separate stage

A new request enters the task queue before an agent starts implementation.
Triage reads the request, similar tasks, repository instructions, available skills, and machine capabilities.
It records these results:

- Task type, objective, priority, and selected repositories.
- Required outputs and verifiable acceptance conditions.
- Routing choice, applicable user decisions, required access, and human holds.
- Dependencies, conflicts, resource needs, and whether subtasks are necessary.
- Missing information and the reason for any blocked assignment.

Triage does not implement the work. Limit its attempts and required reads.
A simple task remains one task. Split only work with separate outcomes or execution constraints.
The installed 20x triage prompt also permits subtask creation and defines structured outputs.
See [triage prompt](/Users/necmttn/Projects/20x/src/main/agent-manager.ts:4977).

### The parent owns the combined result

Each subtask has one scope, expected output, acceptance conditions, dependencies, and a responsible execution attempt.
Use parent-child relationships for ownership. Use dependency edges for execution order.
A tree alone cannot express all dependencies between sibling tasks.
Child agents receive relevant parent context and sibling outputs when required.
They do not need the full parent transcript for every small task.

The parent coordinator reads child evidence, resolves conflicts, checks integration, and requests specific corrections.
It does not remain active only to wait for children.
A stored child result or a due task check makes it eligible to resume.
Repeated delivery of the same result must not start another parent attempt.
A child that reports ready for review has submitted work. It has not established acceptance.
The parent completes only after required child results and its own integration conditions pass.
A human hold remains a valid waiting state.

The inspected 20x source resumes an idle parent when no child remains actively working.
It can start another queued child or consolidate submitted results.
This is broader than the recording's description of waiting until all children are ready.
See [parent notification](/Users/necmttn/Projects/20x/src/main/agent-manager.ts:3359).

### Task checks need explicit actions

A task check asks whether an external result changes the next permitted action.
Examples include new PR feedback, a completed check, a released machine slot, or a human answer.
A process heartbeat only establishes recent process activity. Keep these concepts separate.
Use events first and a bounded periodic check when an event can be missed.
Record the last checked result and next check time. Do not repeatedly ask a model to inspect unchanged state.
Permission failures require restored access. Another reminder cannot remove the restriction.

### First trial

Parent task: preserve Codex access during session recovery.

1. Reproduce one recorded permission change and capture the effective profile.
2. Trace the recovery request and determine which component changes that profile.
3. Correct that component within the recorded authorization.
4. Test recovery, required access, duplicate assignment, and retained files.
5. Obtain independent review of the current commit.
6. Record the combined result and complete owned resource cleanup.

Steps 2 and 3 depend on the reproduction result.
Step 4 depends on the correction. Step 5 depends on the tested commit.
The parent checks integration and acceptance across all six subtasks.
This trial adds to the earlier permission, capacity, routing, review, and cleanup corrections.

Acceptance checks for the task system:

- A new request receives a bounded triage result without source edits.
- A complex request produces focused subtasks with outputs and dependencies.
- An idle parent resumes once when a child result requires review.
- A rejected child result records specific missing evidence and a bounded correction attempt.
- An unfinished child prevents parent acceptance.
- Recovery preserves task identity and verifies required access before execution.
- Owner feedback produces a proposed improvement with evidence and a comparison check.

---

_Generated with [ax](https://github.com/Necmttn/ax)._
