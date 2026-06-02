# ax mcp server

> **Status: v0 shipped (Tasks 1-4).** `ax mcp` exposes 10 read-only graph
> query tools over stdio. `sessions_here` / `sessions_near`, mutating ops, and
> compiled-binary support are deferred.

## What

`ax mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io)
server over stdio, exposing ax's read-only graph queries as MCP tools so a
coding agent (Claude Code, Codex) can query the ax graph in-context without
shelling out. Built on `@modelcontextprotocol/sdk`.

## Tools (10)

Each maps to the matching `ax` CLI command:

- `recall` - full-text recall across turns / commits / skills.
- `sessions_around` - sessions in a date window.
- `session_show` - one session's detail (+ optional subagent expansion, by-role).
- `skills_weighted` - usage x role-weight skill ranking.
- `skills_by_role` - skills tagged with a given role.
- `skills_roles` - roles for a given skill.
- `roles` - the full role vocabulary.
- `improve_recommend` - top improvement proposals, ranked.
- `improve_show` - one proposal's evidence trail.
- `improve_list` - proposals filtered by status / form.

## Constraints

- **Read-only.** Mutating ops (`improve accept/reject/verdict`, `skills
  tag/lint`, `ingest`) stay on the CLI - they write task files / edges a human
  reviews.
- **Run from source** (the `bin/axctl` shim). Unlike live ingest, the server
  pulls in no native deps (JS MCP SDK + SurrealDB client), so the compiled
  standalone binary should serve it too - untested in v0.

## Deferred

- `sessions_here` / `sessions_near` - need a git/cwd-resolved repository key,
  which the cwd+git resolver `process.exit`s on and is unfit for a long-lived
  server.
- Mutating tools.
- Verifying / wiring compiled-binary support (should work; untested).

## Implementation

- Server: `apps/axctl/src/mcp/server.ts`
- Tool registry: `apps/axctl/src/mcp/tools.ts`

## Install

Claude Code:

```bash
claude mcp add ax -- ax mcp        # --scope user to make it global
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.ax]
command = "ax"
args = ["mcp"]
```
