# Filing retro proposals in ax

`ax retro emit --from-file=<json>` takes one object. Top level:

```json
{ "tried": "…", "worked": "…", "failed": "…", "next": "…", "proposals": [ … ] }
```

Each proposal has the common keys plus a `payload` whose shape depends on `form`. The schema lives in `apps/axctl/src/improve/propose.ts` in the ax repo; this is a copy of it as of ax 0.43.

Common keys: `form`, `title`, `hypothesis`, `confidence` (`high` | `medium` | `low`). Optional: `frequency` (int), `evidence`.

| form | required payload keys | optional |
|---|---|---|
| `skill` | `trigger_pattern`, `suspected_gap`, `proposed_behavior` | `expected_impact` |
| `subagent` | `bounded_role`, `delegation_trigger` | `example_task_patterns[]` |
| `hook` | `event_name`, `hook_command` | `target_tool`, safety keys |
| `guidance` | `file_target`, `suggested_text` | `section` |
| `automation` | `trigger_signal`, `action` | `schedule`, safety keys |

Safety keys (hook, automation): `recovery_path`, `smoke_test_command`, `disable_command`, `failure_mode` (`fail_open` | `fail_closed`).

`file_target` is a real path. Verify it exists before filing.

Category to form:

| retro category | form |
|---|---|
| Automated checks, mechanical Coding standards | `hook` (PreToolUse) or `automation` (pre-commit, CI) |
| Judgement Coding standards, Navigation, No-ops, Global AGENTS.md | `guidance` with the exact text to add or delete |
| Tool economy | `hook` when a rewrite fixes it, else `guidance` |
| Information access | `automation` or `hook` on SessionStart |
| Repeated delegation shape | `subagent` |

Same `title` on a later emit bumps `frequency` instead of duplicating; reuse titles for recurring findings.

Example, one `hook` proposal:

```json
{
  "form": "hook",
  "title": "Rewrite cd <dir> && git to git -C",
  "hypothesis": "Denying the shape costs a verbatim resend; rewriting costs nothing",
  "confidence": "high",
  "evidence": "2 denials, ~700 tokens resent each, session 5f31c861",
  "payload": {
    "event_name": "PreToolUse",
    "target_tool": "Bash",
    "hook_command": "~/.claude/hooks/pre-bash-guard.sh",
    "failure_mode": "fail_open",
    "disable_command": "remove the hook entry from ~/.claude/settings.json"
  }
}
```
