# Ax Memory Context Prototype

Question: using real local transcript data read-only, do inferred memories and
evidence-backed context blocks feel useful enough to productize?

Run:

```sh
bun run prototype:memory-context
```

Generate an HTML preview of exactly what the AI would see:

```sh
printf 'test against real transcripts\n' | \
  bun run prototype:memory-context --html scripts/prototypes/ax-memory-context-preview.html
```

This prototype does not write memory records. It scans recent `turn` rows with
`message_kind = "task"`, classifies evidence intent, classifies the current task
topic, decides which hard-coded memories would be injected or rejected, and
previews the context block an agent could receive.

Delete this directory or absorb the useful logic once the product decision is
clear.

## File Context Prototype

Question: when a bug mentions a file/error, can ax retrieve useful prior
sessions/messages/commits through the file graph and show what the AI sees?

Run:

```sh
bun run prototype:file-context -- \
  --q "Working memory not initialized from update_working_memory" \
  --file apps/nokta/app/tools/update-working-memory.ts \
  --file apps/nokta/app/processors/working-memory.ts \
  --html scripts/prototypes/ax-file-context-preview.html
```

The output is graph-first: matched `file` nodes, prior `edited` turns, commits
through `touched`, neighboring files from shared commits, and an
`<ax_file_context>` block.

## Turn References Prototype

Question: can we make file/symbol/error mentions into first-class graph edges so
context injection does not need to fuzzy-scan raw transcript text every time?

Run:

```sh
bun run prototype:turn-references -- --limit 500
```

For a single session:

```sh
bun run prototype:turn-references -- \
  --session 019e2531-b552-7b53-a029-c780adbb6560 \
  --limit 200
```

The script extracts and writes:

- `turn -> mentioned_file -> file`
- `turn -> mentioned_symbol -> symbol`
- `turn -> mentioned_error -> error_signature`

Those edges are the next product-grade ingestion layer behind file-based
context injection.
