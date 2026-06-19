# Live Ingest Event Contract Facts

These facts are the shared understanding for the overnight goal.

1. Live ingest stream payloads are runtime-validated with Effect Schema in `packages/lib/src/shared/ingest-stream-events.ts`, not only described by TypeScript interfaces.
2. The public TypeScript names `IngestFileFailure` and `IngestStreamEvent` remain available from `@ax/lib/shared/ingest-stream-events`, and existing import sites keep working.
3. The event discriminator stays `kind`. Do not rename the stream event union to Effect's default `_tag` shape.
4. `stage_file_failures.failures` is validated as an array of `{ filePath: string, tag: string, message: string }`.
5. `stage_finished.status` accepts only `"ok"` or `"error"`.
6. `run_finished.status` accepts only `"completed"` or `"failed"`.
7. `stage_progress.etaLeftMs` accepts a finite number or `null`.
8. The daemon encodes or validates every `IngestStreamEvent` before appending it to Durable Streams.
9. The studio treats Durable Stream JSON items as `unknown` until each item passes the shared decoder.
10. A malformed stream item does not crash the studio reducer. It surfaces an error state and continues folding valid items.
11. The trace-to-ingest translator in `apps/axctl/src/ingest/stream-events.ts` keeps the current behavior and uses the shared schema where it removes manual shape checks.
12. The `/api/ingest` trigger response stays in `packages/lib/src/shared/api-contract.ts`; the stream transport itself stays outside `HttpApi`.
13. The comments in `api-contract.ts` are updated to say streaming routes are outside `HttpApi`, while the live-ingest event payload is still schema-typed in `ingest-stream-events.ts`.
14. No `@effect/rpc`, Electron, MessagePort, effect-atom, or new transport dependency is introduced.
15. Generated or embedded artifacts under `apps/studio/dist*` and `apps/studio-desktop/resources/ax-src` are not edited.
16. The work is verified with focused unit tests for the shared schema, the producer-side Durable Stream append path, the trace translator, and the studio stream fold path.
17. The final gate is `bun run typecheck` plus the focused `bun test` files listed in `plan.md`. Run the full `bun test` suite if time remains.
