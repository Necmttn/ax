# Repository cleanup plans

**Audit baseline:** `5f06ce46`  
**Created:** 2026-08-24

These plans remove false product guidance and reduce default product surfaces. They preserve historical evidence and supported advanced features.

## Execution order

| Order | Plan | Priority | Effort | Risk | Dependency |
|---|---|---|---|---|---|
| 1 | [Make active documents describe the current product](001-current-product-contract.md) | P1 | M | LOW | None |
| 2 | [Remove retired commands from active interfaces](002-remove-retired-active-commands.md) | P1 | S | LOW | Plan 001 |
| 3 | [Give document collections a clear lifecycle state](003-document-lifecycle-catalog.md) | P1 | M | LOW | Plans 001 and 002 |
| 4 | [Isolate the session classifier experiment](004-isolate-session-classifier-experiment.md) | P2 | M | MED | Plan 003 |
| 5 | [Simplify the default CLI and Studio surfaces](005-simplify-public-surfaces.md) | P2 | M | MED | Plans 002 and 003 |

## Shared rules

- Recheck each plan against the baseline before implementation.
- Claim one issue and worktree for each plan.
- Keep historical documents and evidence unless a plan says otherwise.
- Run focused checks before full repository checks.
- Stop when a plan finds a changed product contract or an unknown external dependency.

## Deferred findings

The audit also found large generated modules, prototype routes, and stale harness checks. These items need separate plans after this work.
