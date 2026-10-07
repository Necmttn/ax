# Fleet implementation: 2026-10-02

The first implementation uses the existing fleet graph and ledger.
Fable reviews the plan before implementation. A separate Fable review checks the control code. The final review result is PASS.

## Changes

- `fleet tasks <epic-dir>` shows task parents, children, unfinished children, output keys, sessions, and access results.
- Graph validation rejects unknown parents and parent cycles.
- Verified mode requires attempt and session identity for task events.
- A shared filesystem lock protects event validation and append.
- Superseded attempts cannot report results. Their original events and attempt history remain available.
- Agent access probes test worktree writes, Git metadata writes, and selected socket or network access.
- Task work requires a passing probe. Access recovery requires a probe after the recorded failure.
- Task completion requires configured output keys.
- Gate and merge events require the reviewed commit. Human approval requires the same commit.
- A parent waits for all children. A queued child remains unfinished.
- Direct ledger-file writes cannot avoid verified checks.
- Routing instructions use the current routing file and user decisions.
- Pane closure follows the report archive. Worktree removal follows merge and result verification.

## Use

Read the installed `fleet-ship/references/task-control.md` before a new run.
Set `control` to `verified` in a new epic graph. Existing runs retain their current mode.
Run the access probe through the affected agent command tool. A host test cannot prove agent access.

## Review corrections

Fable finds that direct ledger-file writes can avoid the initial verified checks.
The correction refuses those writes for verified epics. Tests include existing files, new files, and file links.
The tests also cover simultaneous claims, stale reports, access failure, successful task start, and assignment reset.
An HTTP error proves transport access. It does not prove authentication or service operation.

## Verification

All 124 tests pass. The TypeScript check passes.
The tests cover simultaneous claims, file-write refusal, stale attempts, access failure, and successful task start.
They also cover parent completion, dependency completion, review commits, human approval, and temporary-file removal.

## Limits

The source of the Codex permission change remains unknown. The implementation detects failed access; it does not repair Codex.
A launch flag does not prove runtime policy. The caller checks the real Git commit before recording review evidence.
The lock protects one shared filesystem. Separate machine copies need fleetboard claims and one coordinator.
The task view does not start agents automatically. The orchestrator performs triage, assignment, and parent review.
Attempt identity protects against accidental stale results. It does not authenticate a writer with ledger access.
A crashed writer can leave a lock. Confirm that the writer stops before removing the lock.
A malformed ledger requires correction before verified writes can continue.

## Files

The implementation branch is `feat/fleet-task-control-20261002` in the skills repository.
The implementation commit is `8842049`.
Its worktree is `/Users/necmttn/Projects/.worktrees/fleet-task-control-20261002`.
The installed skill source is `/Users/necmttn/Projects/.worktrees/necmttn-skills-audit-personal/skills/engineering/fleet-ship`.
Installation preserves the owner's existing routing and invariant changes.

---

_Generated with [ax](https://github.com/Necmttn/ax)._
