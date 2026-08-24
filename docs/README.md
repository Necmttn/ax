# Document guide

Use this directory for product guidance, decisions, tests, and historical records.

`catalog.json` gives each file one lifecycle state.

- `current` files describe the supported product.
- `decision` files record accepted design decisions.
- `historical` files preserve old plans and designs.
- `experiment` files test a question and are not product guidance.
- `evidence` files record research or test results.
- `release` files describe shipped versions.
- `generated` files come from a build or tool.
- `asset` files support documents or the site.

Start with `../README.md`, `cli.md`, `development.md`, and `how-ax-sees-your-work.mdx`.

Run `bun run check:doc-catalog` after you add, move, or remove a document.
