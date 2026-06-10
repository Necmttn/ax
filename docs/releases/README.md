# Release Announcements

Release Please owns the generated `CHANGELOG.md`. This directory owns the
curated announcement layer shown on the website.

Agents should use the `ax:release-announcement` skill when drafting or revising
these files. The skill turns the release range into changed-file, commit, and
session evidence before writing the announcement.

For each released version, keep one file:

```text
docs/releases/vX.Y.Z.md
```

Required frontmatter:

```yaml
---
version: "X.Y.Z"
date: "YYYY-MM-DD"
title: "Short announcement title"
summary: "One sentence written for humans, not commit logs."
---
```

## Automated flow (default)

When a Release Please release PR merges, the `release-announcement` job in
`.github/workflows/release-please.yml` runs automatically:

1. `scripts/create-release-announcement.ts` generates the evidence draft for
   the new version.
2. `openai/codex-action` (Codex CLI, API-key billing via the `OPENAI_API_KEY`
   secret) rewrites the draft into the final announcement following the
   authoring rules below. CI has no ax session graph, so the narrative is
   grounded in the embedded commit/diff evidence only.
3. The job opens `release-announcement/vX.Y.Z` as a PR and (with
   `AUTO_MERGE: "true"`, the default) squash-merges it immediately.
4. The merge to main triggers `.github/workflows/deploy-site.yml`, which
   builds the site and deploys it to Cloudflare Pages, publishing the
   announcement at `/changelog/X.Y.Z`.

Set `AUTO_MERGE: "false"` in the workflow to hold the PR for human review
before publishing. The manual flow below still works and produces richer,
session-grounded announcements.

## Manual flow

1. Let Release Please open or update the release PR.
2. Trigger `ax:release-announcement` or run
   `bun run release:announcement -- X.Y.Z`.
3. Refresh local evidence before writing:

```bash
BASE_REF=<previous-release-tag>
HEAD_REF=<release-head-or-tag>
git diff --name-status "$BASE_REF..$HEAD_REF"
git log --reverse --format='%h %cs %s' "$BASE_REF..$HEAD_REF"
ax ingest here --since=14d
ax sessions here --days=14
ax sessions near <important-sha-from-range>
ax recall "<release theme>" --sources=turn,commit --scope=here
```

4. Ask an LLM or maintainer to rewrite the generated draft into a topical
   announcement grounded in commits, issues, docs, and ax session evidence.
5. Commit the announcement file into the same release PR when possible.

The generated changelog answers "what commits landed?" The announcement answers
"why should a user care?"

## Authoring Rules

Release announcements should not be a prose copy of `CHANGELOG.md`. They should
read like a compact product note with evidence.

Each announcement should include:

* **How we got here** - the problem, decision tree, tradeoff, or sequence of
  decisions that led to the release shape. Prefer evidence from `ax sessions`,
  `ax sessions near <sha>`, and `ax recall`.
* **Release range evidence** - identify the previous release tag and release
  head/tag, then inspect every changed file and commit with
  `git diff --name-status "$BASE_REF..$HEAD_REF"` and
  `git log --reverse --format='%h %cs %s' "$BASE_REF..$HEAD_REF"`.
  Use that file and commit map to choose which agent sessions to inspect.
* **What changed** - topical groups that connect user-visible behavior to
  concrete commits, issues, docs, commands, screens, or schema changes.
* **Example** - a CLI command, config snippet, output sample, schema fragment, or
  before/after usage whenever the release changes a command, API, workflow, or
  data model.
* **Visual evidence** - a focused screenshot, diagram, or output capture when
  the release changes the website, dashboard, TUI, CLI presentation, or any
  workflow that is easier to understand visually.
* **Why it matters** - practical impact for someone using ax day to day.

Do not invent a release narrative. If the session graph is incomplete, say what
the commits and issues prove, then keep the announcement narrower.

Store website-visible release images in:

```text
apps/site/public/releases/assets/
```

Reference them from the release markdown with normal image syntax:

```md
![Provider parity release page showing referenced changes](/releases/assets/v0.3.0-provider-parity.png)
```
