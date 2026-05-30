---
name: diagnose
description: Disciplined diagnosis loop for hard bugs.
---
# Diagnose

Use when: debugging a failing ingest parser or performance regression.

## Workflow

1. Reproduce the failure.
2. Minimize the fixture.
3. Patch the parser.

Read `references/parser-contract.md` before changing shared parser behavior.
