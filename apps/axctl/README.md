# ax

`ax` is a local taste and telemetry graph for AI coding agents. It ingests
transcripts from Claude Code, Codex, Pi, OpenCode, and Cursor, plus installed
skills and git history, into a local SurrealDB graph. The CLI then shows what
skills and tools you actually use, where agents get stuck, what sessions cost,
and which work could be routed to a cheaper model.

Everything runs locally on `127.0.0.1`; normal ingest does not upload your
transcripts or code.

## Install

```bash
curl -fsSL ax.necmttn.com/install | sh
PATH="$HOME/.local/bin:$PATH"
```

The installer downloads the latest release. On macOS it also runs `ax install`,
which sets up the local database, daemon, watcher, CLI symlinks, and agent
integrations. Run it yourself if that step was skipped, or whenever you need to
repair or refresh the setup:

```bash
ax install
```

## Quickstart

Preview the first backfill, ingest your history, and verify the installation:

```bash
ax ingest --dry-run
ax ingest
ax doctor
```

Open the local Studio dashboard:

```bash
ax serve
```

Then visit [http://127.0.0.1:1738](http://127.0.0.1:1738).

## Key commands

```bash
ax recall "auth bug"             # search past turns, commits, and skills
ax sessions here --days=30       # sessions for the current git repository
ax skills weighted               # rank skills by usage and role
ax insights tools --limit=5      # tools with the most recorded failures
ax cost sessions                 # highest-cost recent sessions
ax dispatches --candidates       # expensive subagent work that could route down
```

See the [full CLI reference](https://github.com/Necmttn/ax/blob/main/docs/cli.md)
for session inspection, cost analysis, routing, retros, improvements, hooks,
profiles, MCP tools, and more.

## Requirements

- Bun 1.3 or newer
- SurrealDB 3.0 or newer
- macOS or Linux; background reactivity is currently macOS-first

Source, issues, and development documentation live in the
[ax GitHub repository](https://github.com/Necmttn/ax).

---

_Generated with [ax](https://github.com/Necmttn/ax)._
