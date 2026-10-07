---
name: env-retro
description: Retrospective on one coding session that proposes changes to the agent's environment (hooks, checks, steering files, tool access) and files each as an ax proposal. Reads the raw session log through a bundled ledger script, with ax as the second source and the ledger. Triggers when the user says "environment retro", "env retro", "what should I change in my setup after this session", "retro this session's tooling", or invokes /ax:env-retro. Use /ax:retro to triage the proposals it files.
---

# ax:env-retro - what to change in the environment after one session

The user has asked for an **environment retro**. You read what one session actually did, name the changes to the agent's **environment** (hooks, checks, steering files, tools, access) that would make the next run cheaper or safer, and file every candidate in ax so it is triageable later. The session log is the primary source; ax is the ledger.

## Steps

1. Call the Skill tool with `writing-for-agents` for the writing style.

2. **Locate the session.** Default is the current one: the id is `$CLAUDE_CODE_SESSION_ID` and the log is `~/.claude/projects/<cwd-slug>/<id>.jsonl`. If the user names another session, take its key. Done when you hold a path that exists.

3. **Make it reviewable in ax, scoped.** Run `ax ingest here` in the background (the bare `ax ingest` walks every transcript on the machine). Watch its RSS; stop it at 4 GB and record that as a Tool economy finding against ax itself. Continue on the raw log while it runs.

4. **Build the ledger.** Run `python3 -I scripts/turns.py <log>` (add `--full` to see each command). It prints one line per tool call with `ERR`, `DENY`, `RETRY`, `AGENT`, `BIG` flags and a summary of calls, flags and tokens. When ax has the session, add `ax sessions show session:<id> --turns --json` for timings. Done when every flagged line has a cause you can state.

5. **Hunt candidates** in these categories, each with evidence from the ledger (turn, tool calls spent, bytes or tokens wasted) and a fix that names a file.

   - **Navigation**: the agent took long to find a file or fact. _Fix_: a pointer in auto-memory or the repo's `CLAUDE.md`, never a paragraph.
   - **Automated checks**: a mistake a linter, type check, test or filesystem check would have caught. Read the repo's own check command first (`package.json` scripts, CI workflow); an existing check that is unwired or broken is the finding. A repo with no pre-commit hook and no CI check is itself a finding.
   - **Coding standards**: classify the violation first. A **mechanical** one (banned API, import shape, file-location rule, a command shape) gets a deterministic check: a lint rule, a pre-commit hook, a PreToolUse hook that **rewrites and allows** rather than denies. Reserve prose rules for **judgement calls** no check can substitute for, and give them to the reviewer agent, which has the least context pressure.
   - **Global AGENTS.md / CLAUDE.md**: always-loaded lines that did not bear on this session. Candidates for a pointer and a doc, or deletion.
   - **Tool economy**: expensive calls. A `BIG` result, an alias or pager writing ANSI to a pipe, a denial that forced a verbatim resend, a search over the wrong tree. _Fix_: a rewrite hook, a tty guard, a scoped command.
   - **No-ops**: steering lines the model already obeys by default. Delete the sentence, not words from it.
   - **Information access**: a fact the agent needed and could not reach (a session id, a dev-server log, a third-party dashboard). _Fix_: an env var, a tee, read-only access.

   Done when each candidate has category, evidence, fix, and the file the fix lands in.

6. **Present** the candidates to the user in order of severity: cost in this session first, then likelihood of recurrence. One paragraph each. End with which ones are mechanical (a check) and which need judgement (a rule).

7. **File in ax.** Read [`PROPOSALS.md`](PROPOSALS.md) for the payload shapes. Then:

   ```bash
   ax retro brief --session=session:<id>          # writes .ax/tasks/retro/<id>.md
   ax retro emit --session=session:<id> --source=manual --from-file=<json>
   ```

   The JSON holds `tried`, `worked`, `failed`, `next`, and one `proposals[]` entry per candidate, shaped by its form. Set the brief's frontmatter `status: completed`. Done when `ax improve list` shows the new proposals.

8. **Apply only when asked.** If the user says fix them, apply in severity order, one commit per repo, and re-run the ledger on the next session to confirm the flag class is gone.

## Reference

### Implementation vs review

Work goes through two stages. The implementation agent explores, writes and debugs under the most context pressure. The review agent receives a diff and has the least. Standards belong to the reviewer; the implementer gets checks and pointers.

### Files

- `CLAUDE.md` / `AGENTS.md`: loaded every turn in that repo. Navigation pointers only.
- `CODING_STANDARDS.md`: read at review time. Judgement rules.
- `~/.claude/hooks/*.sh`: PreToolUse guards. Prefer `permissionDecision: allow` with `updatedInput` over `deny`.
- `~/.claude/projects/<slug>/memory/`: auto-memory. Pointers and machine-local facts.
- Skills: docs whose description is a context pointer, or user-invoked commands.
