# `axctl` hooks for agent harnesses

`axctl hook file-context` decides, on every file-touching tool call, whether to inject prior session memory into the agent's context. Every call is logged to the `hook_fire` table for later analysis (`axctl hook log`).

## Claude Code (PreToolUse)

Add this block to `~/.claude/settings.json` (merge with any existing `hooks` config):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|Read|Grep|Glob",
        "hooks": [
          { "type": "command", "command": "axctl hook file-context --format claude" }
        ]
      }
    ]
  }
}
```

What this does on every Claude Code tool call:

1. Claude Code spawns `axctl hook file-context --format claude` and pipes the PreToolUse JSON payload to stdin.
2. `axctl` parses the payload, derives `event` from `tool_name` (`Edit|Write|MultiEdit → pre-edit`, `Read → read`, `Grep|Glob → search`).
3. Decides whether to inject memory based on suppression rules + prior session signal.
4. Prints a compact `<ax_file_memory>` block to stdout (which Claude Code injects as additional context for that tool call) - or nothing if the decision is to skip.
5. Writes a `hook_fire` telemetry row regardless of inject decision.

The hook adds < ~50 ms in the warm path (cold connection is slower; the daemon keeps the SurrealDB connection warm if installed). If the DB is unreachable the hook still emits stdout normally and writes an error to stderr.

## Inspecting hook activity

```bash
axctl hook log --tail 20                       # last 20 fires, TSV
axctl hook log --tail 50 --reason suppressed_path
axctl hook log --file src/cli/index.ts --inject true
axctl hook log --since 1                       # last 1 hour
axctl hook log --harness codex --json
```

Columns:

| column | meaning |
| ------ | ------- |
| `ts` | ISO timestamp of the fire |
| `harness` | `claude` (real-time), `codex` (replay), `unknown` (other CLI use) |
| `event` | `pre-edit`, `read`, `write`, `search`, `unknown` |
| `file` | raw `file_path` from the tool input |
| `inject` | `true` if memory was emitted, `false` otherwise |
| `reason` | `high_signal` / `suppressed_path` / `no_prior_sessions` / `low_signal_only` / `no_files` |
| `latency_ms` | wall time of the decision (excludes stdin read and stdout write) |

## Invocation modes

| mode | example | when to use |
| --- | --- | --- |
| Claude PreToolUse (stdin) | `axctl hook file-context --format claude` | the Claude Code config above |
| explicit flags | `axctl hook file-context --event pre-edit --task "..." --file ...` | shell scripts, ad-hoc inspection |
| generic JSON (stdin) | `echo '{"event":"pre-edit","file":"…"}' \| axctl hook file-context --stdin` | other harnesses, fixtures |
| JSON output | add `--json` | tooling that wants the full decision envelope |

When stdin and flags both provide a value, flags win for each field.

## Suppression rules (current)

The hook never injects when:

- the file is a lockfile (`bun.lock`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`, `poetry.lock`, `Pipfile.lock`, `uv.lock`, `composer.lock`, `go.sum`);
- the path contains `/node_modules/`, `/dist/`, `/build/`, `/.next/`, `/.turbo/`, `/.nuxt/`, `/coverage/`, `/.output/`;
- the path ends with `.map`, `.min.js`, `.min.css`, `routeTree.gen.ts`, `.generated.ts`, `.g.ts`, `.gen.ts`;
- no prior session has touched the file;
- the only prior sessions are low-signal (no corrections, no commits, weight < 3, not merged, no review pain).

These rules will move from hardcoded to data-driven as the `hook_fire` log accumulates.

---

# Session-end retros (Stop hook)

`ax retro emit` writes a structured reflection - **tried · worked · failed · next** - to the `retro` table for one session. Wiring it to a Stop hook turns every session-end into a row that downstream `derive-proposals` clusters into actionable proposals.

Two recipes, increasing in signal sharpness:

## Recipe A - heuristic-only (zero agent involvement)

The Stop hook just calls `ax retro emit` with no args. ax computes the retro from session telemetry (turn counts, tool calls, errors, edits, commits, friction kinds). No LLM call, free, runs in milliseconds.

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "ax retro emit --session $CLAUDE_SESSION_ID" }
        ]
      }
    ]
  }
}
```

When this is enough:
- High volume - you don't want to budget LLM cost per session.
- Heuristics are sharp enough - friction kinds + tool-failure counts catch the obvious recurring patterns.
- Onboarding - start here, upgrade later.

## Recipe B - agent-driven (sharper signal, opt-in)

The Stop hook asks the agent for a structured retro first, then ingests it. The agent reflects on its own session before exiting; the JSON it produces overrides the heuristic.

Two files: the agent prompt and the hook wrapper.

`~/.claude/ax-retro-prompt.md`:

```
Before stopping, emit your session retro as JSON to
/tmp/ax-retro-$CLAUDE_SESSION_ID.json with shape:

{
  "tried":  "<1-2 sentence summary of what you attempted>",
  "worked": "<what landed, or null>",
  "failed": "<what didn't, or null>",
  "next":   "<the next experiment to run, or null>"
}

Be specific about which tools failed, which files you got stuck on,
which approaches you abandoned. Skip pleasantries.
```

`~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "if [ -f /tmp/ax-retro-$CLAUDE_SESSION_ID.json ]; then ax retro emit --session $CLAUDE_SESSION_ID --from-file /tmp/ax-retro-$CLAUDE_SESSION_ID.json --source claude_stop_hook; rm /tmp/ax-retro-$CLAUDE_SESSION_ID.json; else ax retro emit --session $CLAUDE_SESSION_ID; fi" }
        ]
      }
    ]
  }
}
```

If the agent wrote the file → ingest agent JSON. If it didn't → fall back to heuristics. Idempotent: the `retro` table is UNIQUE on session; re-emitting overwrites.

## Inspect

```bash
ax retro list                    # 20 most recent
ax retro list --since=7 --json   # last 7 days, machine-readable
```

## How retros feed the loop

`derive-proposals` (when wired to retros, on roadmap) groups retros by repo + week, clusters `failed` strings (n-gram + file overlap), and emits a `proposal` when N retros mention the same failure. This replaces the path-categorization heuristic - proposals become evidence-backed rather than file-pattern guesses.

Until that's wired, `ax retro list` is a manual surface: skim recent retros, see what's repeating, propose work yourself.

