# Release Announcements

Release Please owns the generated `CHANGELOG.md`. This directory owns the
curated announcement layer shown on the website.

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

Recommended release flow:

1. Let Release Please open or update the release PR.
2. Run `bun run release:announcement -- X.Y.Z`.
3. Ask an LLM or maintainer to rewrite the generated draft into a short
   announcement.
4. Commit the announcement file into the same release PR when possible.

The generated changelog answers "what commits landed?" The announcement answers
"why should a user care?"
