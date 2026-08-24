# Experiments

This directory contains research code that does not run in the default product.

Each experiment must state its owner, question, run command, and exit rule.
Product packages must not import experiment code or test data.

## Session sections

`session-sections/` tests model-assisted event classification and section assembly.

- Owner: ax maintainers
- Question: Can a local model improve session section boundaries without unsafe graph writes?
- List operations: `bun scripts/classifier-package-operations.ts --manifest=experiments/session-sections/ax.classifier.json`
- Run Python tests: `uv run --project experiments/session-sections python -m unittest discover -s experiments/session-sections -p '*_test.py'`
- Exit rule: Move stable logic into product code, or remove the experiment when the result does not support promotion.

The experiment is not part of default ingest. Its commands write review data under `.ax/experiments/`.
