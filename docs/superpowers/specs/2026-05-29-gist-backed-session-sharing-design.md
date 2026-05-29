# Gist-Backed Session Sharing Design

Date: 2026-05-29
Status: approved design

## Summary

`ax` should support public session sharing without becoming a hosted storage
service. The first version publishes a sanitized session artifact to GitHub Gist
and renders that artifact at `ax.necmttn.com`.

The core flow is:

```text
axctl share <session-id>
  -> read the local session graph from SurrealDB
  -> produce a versioned share artifact JSON
  -> run a redaction and preview step
  -> create a GitHub Gist
  -> print https://ax.necmttn.com/s/<owner>/<gist-id>
```

GitHub Gist is the durable storage layer. `ax.necmttn.com` is only a renderer.

## Goals

- Make AI coding sessions easy to share as readable, inspectable artifacts.
- Preserve the local-first shape of `ax`.
- Avoid hosted accounts, hosted databases, and server-side session storage.
- Show more than a raw transcript: summary, timeline, graph, files, tools,
  skills, and derived evidence.
- Keep the artifact schema separate from the internal SurrealDB schema so shared
  links remain stable as the product evolves.
- Default to a secret Gist, not a public indexed Gist.

## Non-Goals

- No hosted `ax` session database.
- No user accounts or auth layer on `ax.necmttn.com`.
- No comments, likes, or social features.
- No live remote replay.
- No automatic publishing before the user can inspect what will be shared.
- No raw full transcript in V1 unless the user explicitly opts in later.

## User Experience

### CLI

Recommended commands:

```bash
axctl share <session-id>
axctl share <session-id> --public
axctl share <session-id> --dry-run > session-share.json
axctl share <session-id> --open
```

The default command creates a secret Gist. Secret Gists are accessible by URL and
can be deleted or updated from GitHub, which is the right expectation for a share
link.

The command should fail closed if it detects obviously sensitive fields that were
not redacted. It should show a concise preview before publishing:

- session provider, model, project, started/ended time
- number of turns, tools, files, skills, failures
- files that will be named
- redaction rules applied
- whether raw messages are included

### Public URL

The canonical URL shape is:

```text
https://ax.necmttn.com/s/<owner>/<gist-id>
```

The owner is included because fetching a Gist raw file reliably needs either the
owner in the raw URL or a GitHub API lookup. The explicit route is simpler to
cache, debug, and share.

### Renderer

The share page should make the session useful within the first viewport:

- title and summary
- source/provider/model badges
- repo/project identity
- high-level stats
- link to raw artifact
- visible provenance that the data came from GitHub Gist

Below that, V1 should render:

- timeline of important events
- tool and skill usage
- changed files
- derived working-style summary
- decisions and outcome notes when present
- graph preview of event -> actor -> artifact relationships
- call graph snippets when the session artifact includes them

## Artifact Schema

The shared artifact is intentionally not the internal DB schema. It is a compact,
versioned DTO for public rendering.

```ts
type AxSessionShare = {
  schema_version: 1
  exported_at: string
  ax_version: string
  session: {
    id: string
    source: "claude" | "codex" | "pi" | "opencode" | "cursor"
    model?: string
    project?: string
    repository?: string
    started_at?: string
    ended_at?: string
    summary?: string
  }
  stats: {
    turns: number
    tool_calls: number
    files_changed: number
    skills_used: number
    failures: number
  }
  timeline: ShareEvent[]
  files: ShareFile[]
  graph: ShareGraph
  derived: {
    working_style?: string[]
    decisions?: string[]
    call_graphs?: Array<{ label: string; body: string }>
    outcome?: string
  }
  redactions: {
    applied: boolean
    rules: string[]
  }
}
```

Candidate supporting shapes:

```ts
type ShareEvent = {
  id: string
  ts?: string
  kind:
    | "message"
    | "tool_call"
    | "file_edit"
    | "skill_invocation"
    | "decision"
    | "checkpoint"
    | "failure"
    | "outcome"
  actor?: string
  title: string
  summary?: string
  refs?: Array<{ type: "file" | "tool" | "skill" | "turn"; id: string }>
}

type ShareFile = {
  path: string
  lang?: string
  role?: "read" | "edited" | "touched"
  additions?: number
  deletions?: number
}

type ShareGraph = {
  nodes: Array<{
    id: string
    kind: "session" | "actor" | "tool" | "skill" | "file" | "decision" | "artifact"
    label: string
  }>
  edges: Array<{
    from: string
    to: string
    label: string
  }>
}
```

## Data Flow

1. CLI validates the session ID and loads the local session detail.
2. Exporter builds a share DTO from existing query surfaces rather than exposing
   database rows directly.
3. Redactor removes sensitive values and records the rules that were applied.
4. CLI shows a preview and asks for confirmation.
5. CLI uses `gh gist create` when available, or GitHub's API if a token is
   configured and `gh` is unavailable.
6. Gist contains `ax-session.json`.
7. CLI prints the canonical renderer URL.
8. `ax.necmttn.com/s/<owner>/<gist-id>` fetches the Gist and renders the page.

## Privacy And Redaction

V1 should bias toward safe sharing:

- Include summaries and derived events by default, not raw full messages.
- Include repository-relative file paths when possible.
- Avoid absolute local paths unless explicitly allowed.
- Redact common secret patterns in command text, tool output, environment-like
  strings, URLs, and headers.
- Show which redaction rules ran.
- Require explicit opt-in for raw transcript text in a later version.

Secret Gists are not private. The UI and CLI copy should say "secret Gist" or
"unlisted link", not "private share".

## Components

- `share` CLI command: validates input, previews, publishes, prints URL.
- session share exporter: maps local session graph into `AxSessionShare`.
- redaction module: applies deterministic rules and reports them.
- Gist publisher: wraps `gh gist create` and future API fallback.
- site route `/s/$owner/$gistId`: fetches and renders the artifact.
- share renderer components: summary header, timeline, file list, tool/skill
  panels, graph preview, raw artifact link.

## Error Handling

- Missing session: print a clear error and suggest `axctl sessions`.
- No GitHub auth: print the dry-run export command and explain how to publish
  after `gh auth login`.
- Redaction warning: fail closed unless the user passes a future explicit
  override flag.
- Gist fetch failure on site: show a renderer error with the owner/gist ID and a
  link to the Gist.
- Unsupported schema version: show a compatibility message instead of rendering
  partial data incorrectly.

## Testing

Exporter tests:

- maps a minimal session into schema version 1
- omits raw messages by default
- keeps repository-relative paths
- includes stats, timeline, files, graph, and redaction metadata

Redaction tests:

- removes common secret patterns
- redacts absolute home paths
- reports applied rules
- leaves safe file paths and public package names intact

CLI tests:

- `--dry-run` writes valid JSON
- missing session fails clearly
- publish path calls the Gist publisher with `ax-session.json`
- generated URL uses `/s/<owner>/<gist-id>`

Site tests:

- renders a fixture artifact
- handles fetch failure
- handles unsupported `schema_version`
- links to the raw Gist artifact

## Open Decisions

1. Whether V1 should include a text-only "working style summary" generated by
   `ax` derivation, or only render summaries that already exist in the graph.
2. Whether the first graph view should be static SVG/HTML or a small interactive
   force graph.
3. Whether `axctl share` should support updating an existing Gist in V1 or only
   creating new Gists.

The implementation should pick conservative defaults: derived summaries only
when available, static graph first, and create-only Gists in V1.
