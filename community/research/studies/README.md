# Community studies

This directory stores one JSON file for each reviewed Dojo spar comparison.

The pilot supports only `verification-churn` protocol version 1.
It compares cost, turns, duration, repair lines, verification episodes, and landing status.

The JSON uses closed fields.
It excludes task text, intervention text, repository paths, and session identifiers.
It includes hashes that bind the public record to the local brief and score.

Each record has `evidence_class: "self_reported"`.
Each record describes one comparison.
Agents must not use one record as a general recommendation.

Run this command after `ax dojo spar-score`:

```text
ax contribute study <spar-id>
```

The command shows the exact public JSON before it asks for consent.
Use `--preview` to stop after the preview.
