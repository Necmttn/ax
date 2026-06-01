---
name: release-announcement
description: Draft or revise ax release announcements and website changelog pages. Triggers when the user says "write release notes", "draft release announcement", "prepare changelog", "release page", "version page", "what changed in vX.Y.Z", "generate announcement for vX.Y.Z", or asks for a release narrative. Uses Release Please range evidence, git changed files/commits, and ax sessions/recall to explain how the release got there. Do NOT trigger for ordinary commit messages or unrelated docs.
role: framing
---

# ax:release-announcement

Write release announcements that are grounded in the actual release range and
the agent sessions that produced it. This skill owns the curated layer under
`docs/releases/`; Release Please still owns `CHANGELOG.md`.

Assumes `ax` is on PATH and the local ax database is reachable. If `ax` fails
with a DB connection error, tell the user to start the repo DB and continue
from git evidence only if they ask.

## When to fire

Use this skill for:

- "write release notes" / "draft release announcement"
- "prepare changelog" / "update the website changelog"
- "release page" / "version page" / "SEO release page"
- "what changed in vX.Y.Z"
- "generate announcement for vX.Y.Z"
- "explain how we got to this release"

Do not use this for a single commit message, generic README edits, or a
non-release feature doc.

## Workflow

### 1. Resolve the version and range

If the version is known:

```bash
bun run release:announcement -- X.Y.Z
```

This drafts `docs/releases/vX.Y.Z.md` and, when the Release Please compare
heading is present, embeds:

- previous release tag (`BASE_REF`)
- release tag or `HEAD` (`HEAD_REF`)
- `git diff --name-status "$BASE_REF..$HEAD_REF"`
- `git log --reverse --format='%h %cs %s' "$BASE_REF..$HEAD_REF"`

If you need to inspect manually:

```bash
BASE_REF=<previous-release-tag>
HEAD_REF=<release-head-or-tag>
git diff --name-status "$BASE_REF..$HEAD_REF"
git log --reverse --format='%h %cs %s' "$BASE_REF..$HEAD_REF"
```

### 2. Map commits and files to agent sessions

Use the file list to identify touched subsystems. Use the commit list to pick
important SHAs. Then query ax:

```bash
ax ingest here --since=30d
ax sessions here --days=30
ax sessions near <important-sha>
ax recall "<subsystem or decision>" --sources=turn,commit --scope=here
```

For large releases, inspect at least:

- one SHA per major topic
- one SHA near each major schema/API/CLI change
- any SHA tied to a surprising bug fix or reversal
- session windows around the merge/release PR if available

### 3. Write the announcement

Replace the generated draft with a topical narrative. Keep it concise, but
make it useful:

- **How we got here** - the problem, decision tree, tradeoffs, and why the
  final shape won. Cite session/commit evidence in prose.
- **What changed** - grouped by topic, not one flat commit list.
- **Example** - a CLI command, config snippet, output sample, schema fragment,
  or before/after workflow when the release changes behavior.
- **Visual evidence** - screenshot, diagram, or output capture when a UI, CLI,
  dashboard, TUI, or workflow is easier to understand visually.
- **Why it matters** - the practical day-to-day impact.

Do not invent motivation. If ax session evidence is missing, say what the
commits and changed files prove and keep the story narrower.

### 4. Assets and rendering

Put website-visible release images here:

```text
apps/site/public/releases/assets/
```

Reference them from release markdown:

```md
![Focused release screenshot](/releases/assets/vX.Y.Z-topic.png)
```

The website release renderer supports headings, lists, links, bold scopes,
fenced code blocks, and images. Use those instead of hand-written HTML.

### 5. Verify

Run:

```bash
bun run typecheck
cd site && bun run build
```

If the page changed, preview and smoke the specific version page:

```bash
cd site
bun run preview -- --host 127.0.0.1 --port 4175
```

Check `/changelog` and `/changelog/vX.Y.Z`.
