# Live Ingest Event Contract Goal

Make live ingest progress events a real shared runtime contract. Today `packages/lib/src/shared/ingest-stream-events.ts` calls itself a shared contract, but it exports TypeScript interfaces only. Promote those event shapes to Effect `Schema` definitions, validate/encode events before the daemon appends them to Durable Streams, and decode stream items in the studio before reducing them into UI state.

Read `facts.md` first. Execute `plan.md` task by task. Keep the scope focused on the live-ingest event contract and tests. Do not introduce `@effect/rpc`, Electron, effect-atom, or a new transport layer.

Done means:

- `IngestStreamEvent` is schema-backed and still importable from `@ax/lib/shared/ingest-stream-events`.
- The daemon validates/encodes events before Durable Stream append.
- The studio decodes unknown stream items and handles malformed items without crashing.
- Contract comments no longer imply live-ingest payloads are untyped.
- Focused tests pass, and `bun run typecheck` passes.

Recommended launch from this worktree:

```bash
/goal goals/live-ingest-event-contract/goal.md
```
