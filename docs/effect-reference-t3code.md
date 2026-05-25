# Effect Reference: t3code

Reference clone:

```text
.references/t3code
```

The repo was cloned from `git@github.com:pingdotgg/t3code.git` at `b793401`
for local study. `.references/` is gitignored, so this document preserves the
patterns worth adapting into `ax`.

## What To Adapt

1. Keep `Context.Service + Layer.effect` for infrastructure services.

   `t3code` does not use `Effect.Service` in the inspected code. It defines
   explicit service shapes, tags them with `Context.Service`, captures
   dependencies in a `make = Effect.fn(...)`, returns `Service.of(...)`, then
   exports `Layer.effect(...)`.

   Good references:

   - `.references/t3code/apps/server/src/sourceControl/SourceControlRepositoryService.ts`
   - `.references/t3code/apps/server/src/vcs/VcsProcess.ts`
   - `.references/t3code/apps/server/src/sourceControl/GitHubCli.ts`

   This matches the current `SurrealClient` direction in `src/lib/db.ts`.

2. Move config into an Effect service.

   `ax` still reads DB settings from `process.env` in `src/lib/db.ts`.
   `t3code` uses `Config.*` and a config service for typed env/default
   resolution. We should add `AxConfig` and make `SurrealClientLive`,
   ingest services, dashboard generation, and future hooks depend on it.

   References:

   - `.references/t3code/apps/server/src/config.ts`
   - `.references/t3code/apps/server/src/cli/config.ts`

3. Add a reusable process service before Git ingest grows further.

   `t3code` has a `VcsProcess` service with:

   - operation names
   - command, args, cwd, env, stdin
   - timeout
   - max output bytes
   - stdout/stderr truncation markers
   - typed spawn, exit, timeout, and decode errors
   - scoped finalizers that kill child processes

   `ax` currently has local `runGit` helpers. A shared `ProcessService`
   would make Git ingest, Surreal helpers, benchmarks, and tool evidence more
   consistent.

4. Decode all external data at boundaries.

   `t3code` centralizes schema primitives and branded IDs, compiles decoders at
   module scope, and maps schema failures into domain errors with formatted
   issues.

   Adaptation for `ax`:

   - shared schemas for `SessionId`, `TurnId`, `SkillId`, `FileId`,
     `CommitSha`, `RepositoryKey`, `CheckoutKey`
   - transcript/Codex/Claude insights decoders
   - Surreal query result decoders
   - helpers for JSON strings stored in SurrealDB v3 string fields

   References:

   - `.references/t3code/packages/contracts/src/baseSchemas.ts`
   - `.references/t3code/packages/shared/src/schemaJson.ts`
   - `.references/t3code/apps/server/src/persistence/Errors.ts`
   - `.references/t3code/oxlint-plugin-t3code/rules/no-inline-schema-compile.ts`

5. Test services through layers.

   `t3code` tests Effect services with `@effect/vitest`, `it.effect`, and
   `Layer.mock`. This is especially useful for process and source-control
   wrappers because tests can assert exact command shape without invoking real
   tools.

   Adaptation for `ax`:

   - add mock layers around `SurrealClient`
   - test Git ingest correlation without a live DB where possible
   - test CLI commands after migrating away from manual argv parsing

   References:

   - `.references/t3code/apps/server/src/sourceControl/GitHubCli.test.ts`
   - `.references/t3code/apps/server/src/bin.test.ts`
   - `.references/t3code/apps/server/src/sourceControl/SourceControlDiscovery.test.ts`

6. Prefer `effect/unstable/cli` for the CLI refactor.

   Current `src/cli/index.ts` is manually dispatching commands and parsing
   flags. `t3code` uses `Command.make`, `Argument`, `Flag.withSchema`, and
   `Command.run`.

   Keep this as a later refactor. The current prototype needs stable graph
   behavior more than a CLI rewrite, but typed commands will help once
   `insights`, `dashboard`, benchmarks, and project grounding settle.

7. Add structured logs and diagnostics before adding a benchmark framework.

   `t3code` does not have a first-class benchmark framework. It leans on
   structured Effect logging, traces, and diagnostics. For `ax`, the
   empty-DB benchmark script is useful, but long-term performance evidence
   should come from ingest stage timings and query diagnostics stored as graph
   evidence.

   References:

   - `.references/t3code/docs/observability.md`
   - `.references/t3code/apps/server/src/observability/Metrics.ts`
   - `.references/t3code/apps/server/src/diagnostics/TraceDiagnostics.ts`

## What Not To Copy Yet

- Do not split the repo into a monorepo only because `t3code` does. `ax`
  is still small enough for a single package.
- Do not rewrite all existing services to `Effect.Service`; the reference repo
  does not justify that, and our current `Context.Service` style is compatible.
- Do not add custom lint plugins immediately. Keep the `no inline schema
  compile` idea as a later guard after schema decoders are introduced.
- Do not migrate every test to `@effect/vitest` in one pass. Start where
  layers and mocks materially simplify process, DB, and CLI tests.

## Suggested Sequence

1. Add `AxConfig` with typed DB/path settings.
2. Add `ProcessService` and move Git command execution onto it.
3. Introduce shared branded schemas and boundary decoders.
4. Add mock layers for `SurrealClient` and process execution.
5. Split CLI commands onto `effect/unstable/cli`.
6. Add structured ingest/query diagnostics to feed future insights.
