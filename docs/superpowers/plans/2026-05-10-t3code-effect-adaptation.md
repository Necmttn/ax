# T3Code Effect Adaptation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adapt the useful Effect patterns from `docs/effect-reference-t3code.md` into `agentctl` without a broad rewrite: typed config, reusable process execution, schema boundary decoders, mockable layers, typed CLI commands, and structured diagnostics.

**Architecture:** Keep `Context.Service` plus `Layer.effect` as the service style, matching `src/lib/db.ts` and the t3code reference. Add new leaf services first, migrate callers one boundary at a time, and keep all production wiring in `src/lib/layers.ts` so tests can swap layers cleanly. External input is decoded at module boundaries before data reaches ingest writers or query renderers.

**Tech Stack:** Bun 1.3+, TypeScript strict mode, Effect 4 beta, SurrealDB SDK, existing `bun:test` tests, optional `@effect/vitest` only after service-layer tests prove useful, `effect/unstable/cli` for the CLI refactor.

---

## Scope Check

This plan implements the sequence recommended by `docs/effect-reference-t3code.md`:

- Add `AgentctlConfig` with typed DB and path settings.
- Move process spawning behind a scoped `ProcessService`.
- Introduce shared schemas and decoders for external data.
- Add mock layers for services and convert the highest-value tests first.
- Refactor CLI dispatch to typed Effect CLI commands.
- Add structured diagnostics for ingest, query, and process evidence.

This plan intentionally keeps the repository as one package, keeps the existing `Context.Service` style, does not rewrite every test in one pass, and does not add custom lint rules.

## File Structure

- Create `src/lib/config.ts`: `AgentctlConfig` service, typed config schemas, defaults, and test layer factory.
- Modify `src/lib/db.ts`: remove direct `process.env` reads from the live Surreal layer and depend on `AgentctlConfig`.
- Modify `src/lib/layers.ts`: compose `AgentctlConfig.layer`, `ProcessService.layer`, diagnostics, and `SurrealClientLive` in one application layer.
- Create `src/lib/process.ts`: scoped Bun process execution service with timeout, output caps, stdin, env, cwd, and typed failures.
- Create `src/lib/schemas.ts`: branded IDs, external row schemas, JSON-string helpers, and decoder helpers.
- Modify `src/lib/errors.ts`: add typed config, process, decode, and diagnostics errors.
- Modify `src/ingest/git.ts`: replace local `runGit` with `ProcessService` and decode parsed commit/file data.
- Modify `src/ingest/transcripts.ts`: decode parsed Claude JSONL objects and emitted session/turn/tool-call shapes.
- Modify `src/ingest/codex.ts`: decode parsed Codex JSONL objects and emitted session/turn/tool-call shapes.
- Modify `src/queries/insights.ts`: decode Surreal query rows before returning insight payloads.
- Create `src/lib/test-layers.ts`: deterministic mock layers for config, process execution, Surreal client, and diagnostics.
- Create `src/lib/process.test.ts`: process service truncation, timeout, stdin, and failure tests.
- Create `src/lib/schemas.test.ts`: branded IDs, JSON string parsing, and decode error formatting tests.
- Modify `src/ingest/git.test.ts`: add service-layer tests that assert exact git command shapes without invoking git.
- Modify `package.json`: add CLI/test dependencies only when the CLI/test tasks reach that stage.
- Create `src/cli/commands.ts`: typed command definitions using `effect/unstable/cli`.
- Modify `src/cli/index.ts`: reduce to CLI bootstrap and top-level layer provision.
- Create `src/lib/diagnostics.ts`: structured diagnostics service, stage timing helpers, and JSON-safe diagnostic events.
- Modify `src/ingest/*.ts`, `src/dashboard/report.ts`, and `src/queries/insights.ts`: emit structured diagnostics around expensive or failure-prone stages.

## Task 1: Add AgentctlConfig Service

**Files:**
- Create: `src/lib/config.ts`
- Modify: `src/lib/layers.ts`
- Modify: `src/lib/db.ts`
- Test: `bun run typecheck`

- [ ] **Step 1: Create the config service**

Create `src/lib/config.ts` with `Context.Service` plus `Layer.effect`. Use `Config.string`, `Config.integer`, and `Config.orElse` so defaults live in one place:

```typescript
import { Config, Context, Effect, Layer, Schema } from "effect";
import { join } from "node:path";
import { homedir } from "node:os";

const PositiveInt = Schema.Int.pipe(Schema.greaterThan(0));

export interface AgentctlConfigShape {
    readonly db: {
        readonly url: string;
        readonly ns: string;
        readonly db: string;
        readonly user: string;
        readonly pass: string;
        readonly connectTimeoutMs: number;
    };
    readonly paths: {
        readonly claudeProjectsDir: string;
        readonly codexSessionsDir: string;
        readonly repoListFile: string;
    };
    readonly ingest: {
        readonly defaultSinceDays: number;
        readonly maxSinceDays: number;
        readonly processTimeoutMs: number;
        readonly maxOutputBytes: number;
    };
}

export class AgentctlConfig extends Context.Service<
    AgentctlConfig,
    AgentctlConfigShape
>()("agentctl/AgentctlConfig") {}

const intConfig = (name: string, fallback: number) =>
    Config.integer(name).pipe(
        Config.orElse(() => Config.succeed(fallback)),
        Config.mapOrFail((value) =>
            Schema.decodeUnknown(PositiveInt)(value).pipe(
                Effect.mapError((error) =>
                    Config.Error.InvalidData([], `${name} must be a positive integer: ${error}`),
                ),
            ),
        ),
    );

export const AgentctlConfigLive: Layer.Layer<AgentctlConfig> = Layer.effect(
    AgentctlConfig,
    Effect.gen(function* () {
        const dbUrl = yield* Config.string("AGENTCTL_DB_URL").pipe(
            Config.orElse(() => Config.succeed("ws://127.0.0.1:8521")),
        );
        const dbNs = yield* Config.string("AGENTCTL_DB_NS").pipe(
            Config.orElse(() => Config.succeed("agentctl")),
        );
        const dbDb = yield* Config.string("AGENTCTL_DB_DB").pipe(
            Config.orElse(() => Config.succeed("main")),
        );
        const dbUser = yield* Config.string("AGENTCTL_DB_USER").pipe(
            Config.orElse(() => Config.succeed("root")),
        );
        const dbPass = yield* Config.string("AGENTCTL_DB_PASS").pipe(
            Config.orElse(() => Config.succeed("root")),
        );
        const connectTimeoutMs = yield* intConfig("AGENTCTL_DB_CONNECT_TIMEOUT_MS", 5000);
        const claudeProjectsDir = yield* Config.string("AGENTCTL_CLAUDE_PROJECTS_DIR").pipe(
            Config.orElse(() => Config.succeed(join(homedir(), ".claude", "projects"))),
        );
        const codexSessionsDir = yield* Config.string("AGENTCTL_CODEX_DIR").pipe(
            Config.orElse(() => Config.succeed(join(homedir(), ".codex", "sessions"))),
        );
        const repoListFile = yield* Config.string("AGENTCTL_REPO_LIST").pipe(
            Config.orElse(() =>
                Config.succeed(join(homedir(), ".local", "share", "agentctl", "agentctl-repos.txt")),
            ),
        );
        const defaultSinceDays = yield* intConfig("AGENTCTL_DEFAULT_SINCE_DAYS", 30);
        const maxSinceDays = yield* intConfig("AGENTCTL_MAX_SINCE_DAYS", 90);
        const processTimeoutMs = yield* intConfig("AGENTCTL_PROCESS_TIMEOUT_MS", 30000);
        const maxOutputBytes = yield* intConfig("AGENTCTL_PROCESS_MAX_OUTPUT_BYTES", 1_000_000);

        return AgentctlConfig.of({
            db: {
                url: dbUrl,
                ns: dbNs,
                db: dbDb,
                user: dbUser,
                pass: dbPass,
                connectTimeoutMs,
            },
            paths: {
                claudeProjectsDir,
                codexSessionsDir,
                repoListFile,
            },
            ingest: {
                defaultSinceDays,
                maxSinceDays,
                processTimeoutMs,
                maxOutputBytes,
            },
        });
    }),
);

export const makeAgentctlConfigTestLayer = (
    overrides: Partial<AgentctlConfigShape> = {},
): Layer.Layer<AgentctlConfig> =>
    Layer.succeed(
        AgentctlConfig,
        AgentctlConfig.of({
            db: {
                url: "ws://127.0.0.1:8521",
                ns: "agentctl",
                db: "main",
                user: "root",
                pass: "root",
                connectTimeoutMs: 50,
                ...overrides.db,
            },
            paths: {
                claudeProjectsDir: "/tmp/agentctl/claude/projects",
                codexSessionsDir: "/tmp/agentctl/codex/sessions",
                repoListFile: "/tmp/agentctl/repos.txt",
                ...overrides.paths,
            },
            ingest: {
                defaultSinceDays: 30,
                maxSinceDays: 90,
                processTimeoutMs: 1000,
                maxOutputBytes: 4096,
                ...overrides.ingest,
            },
        }),
    );
```

- [ ] **Step 2: Wire config into the app layer**

Modify `src/lib/layers.ts` so `AgentctlConfigLive` is provided once at the application boundary:

```typescript
import { Layer } from "effect";
import { AgentctlConfigLive } from "./config.ts";
import { SurrealClientLive } from "./db.ts";

export const AppLayer = SurrealClientLive.pipe(
    Layer.provideMerge(AgentctlConfigLive),
);
```

- [ ] **Step 3: Remove direct env config from SurrealClientLive**

Modify `src/lib/db.ts`:

```typescript
import { AgentctlConfig } from "./config.ts";
```

Delete `envConfig()` and make the live layer read the service:

```typescript
export const SurrealClientLive: Layer.Layer<SurrealClient, DbError, AgentctlConfig> =
    Layer.effect(
        SurrealClient,
        Effect.gen(function* () {
            const cfg = yield* AgentctlConfig;
            const db = yield* Effect.acquireRelease(acquire(cfg.db), release);
            return wrap(db);
        }),
    );
```

Update the connect timeout to use `cfg.db.connectTimeoutMs` by changing `acquire` to:

```typescript
const acquire = (cfg: DbConfig): Effect.Effect<Surreal, DbError> =>
    Effect.tryPromise({
        try: async () => {
            const db = new Surreal();
            await db.connect(cfg.url);
            await db.signin({ username: cfg.user, password: cfg.pass });
            await db.use({ namespace: cfg.ns, database: cfg.db });
            return db;
        },
        catch: (err) => connectError(cfg.url, errorMessage(err)),
    }).pipe(
        Effect.timeoutOrElse({
            duration: `${cfg.connectTimeoutMs} millis`,
            orElse: () =>
                Effect.fail(
                    connectError(
                        cfg.url,
                        `connect timed out after ${cfg.connectTimeoutMs}ms`,
                    ),
                ),
        }),
    );
```

Add `connectTimeoutMs: number` to `DbConfig`.

- [ ] **Step 4: Run verification**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/config.ts src/lib/db.ts src/lib/layers.ts
git commit -m "feat(effect): add typed agentctl config"
```

## Task 2: Add ProcessService

**Files:**
- Create: `src/lib/process.ts`
- Modify: `src/lib/errors.ts`
- Modify: `src/lib/layers.ts`
- Test: `src/lib/process.test.ts`

- [ ] **Step 1: Add typed process errors**

Modify `src/lib/errors.ts`:

```typescript
export class ProcessError extends Schema.TaggedErrorClass<ProcessError>(
    "ProcessError",
)("ProcessError", {
    operation: Schema.String,
    command: Schema.String,
    args: Schema.Array(Schema.String),
    cwd: Schema.optional(Schema.String),
    exitCode: Schema.optional(Schema.Number),
    signal: Schema.optional(Schema.String),
    stdoutExcerpt: Schema.optional(Schema.String),
    stderrExcerpt: Schema.optional(Schema.String),
    message: Schema.String,
}) {}
```

- [ ] **Step 2: Create the process service**

Create `src/lib/process.ts`:

```typescript
import { Context, Effect, Layer } from "effect";
import { AgentctlConfig } from "./config.ts";
import { ProcessError } from "./errors.ts";

export interface ProcessRequest {
    readonly operation: string;
    readonly command: string;
    readonly args?: ReadonlyArray<string>;
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly stdin?: string | Uint8Array;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
}

export interface ProcessResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
    readonly stdoutTruncated: boolean;
    readonly stderrTruncated: boolean;
}

export interface ProcessServiceShape {
    readonly run: (request: ProcessRequest) => Effect.Effect<ProcessResult, ProcessError>;
}

export class ProcessService extends Context.Service<
    ProcessService,
    ProcessServiceShape
>()("agentctl/ProcessService") {}

const decodeBounded = async (
    stream: ReadableStream<Uint8Array> | null,
    maxBytes: number,
): Promise<{ text: string; truncated: boolean }> => {
    if (stream === null) return { text: "", truncated: false };
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    for (;;) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value;
        if (total + chunk.byteLength <= maxBytes) {
            chunks.push(chunk);
            total += chunk.byteLength;
        } else {
            const remaining = Math.max(0, maxBytes - total);
            if (remaining > 0) chunks.push(chunk.slice(0, remaining));
            total = maxBytes;
            truncated = true;
            await reader.cancel();
            break;
        }
    }
    return {
        text: new TextDecoder().decode(Buffer.concat(chunks)),
        truncated,
    };
};

const excerpt = (text: string): string =>
    text.length > 1200 ? `${text.slice(0, 1200)}…` : text;

export const ProcessServiceLive: Layer.Layer<
    ProcessService,
    never,
    AgentctlConfig
> = Layer.effect(
    ProcessService,
    Effect.gen(function* () {
        const cfg = yield* AgentctlConfig;

        const run = (request: ProcessRequest) =>
            Effect.async<ProcessResult, ProcessError>((resume) => {
                const args = [...(request.args ?? [])];
                const timeoutMs = request.timeoutMs ?? cfg.ingest.processTimeoutMs;
                const maxOutputBytes = request.maxOutputBytes ?? cfg.ingest.maxOutputBytes;
                const proc = Bun.spawn([request.command, ...args], {
                    cwd: request.cwd,
                    env: request.env ? { ...process.env, ...request.env } : process.env,
                    stdin: request.stdin === undefined ? "ignore" : "pipe",
                    stdout: "pipe",
                    stderr: "pipe",
                });

                const timeout = setTimeout(() => {
                    proc.kill();
                    resume(
                        Effect.fail(
                            new ProcessError({
                                operation: request.operation,
                                command: request.command,
                                args,
                                cwd: request.cwd,
                                message: `process timed out after ${timeoutMs}ms`,
                            }),
                        ),
                    );
                }, timeoutMs);

                if (request.stdin !== undefined && proc.stdin) {
                    void proc.stdin.write(request.stdin);
                    void proc.stdin.end();
                }

                void Promise.all([
                    decodeBounded(proc.stdout, maxOutputBytes),
                    decodeBounded(proc.stderr, maxOutputBytes),
                    proc.exited,
                ])
                    .then(([stdout, stderr]) => {
                        clearTimeout(timeout);
                        const exitCode = proc.exitCode ?? 0;
                        const result: ProcessResult = {
                            stdout: stdout.text,
                            stderr: stderr.text,
                            exitCode,
                            stdoutTruncated: stdout.truncated,
                            stderrTruncated: stderr.truncated,
                        };
                        if (exitCode === 0) {
                            resume(Effect.succeed(result));
                            return;
                        }
                        resume(
                            Effect.fail(
                                new ProcessError({
                                    operation: request.operation,
                                    command: request.command,
                                    args,
                                    cwd: request.cwd,
                                    exitCode,
                                    stdoutExcerpt: excerpt(result.stdout),
                                    stderrExcerpt: excerpt(result.stderr),
                                    message: `process exited with code ${exitCode}`,
                                }),
                            ),
                        );
                    })
                    .catch((error) => {
                        clearTimeout(timeout);
                        resume(
                            Effect.fail(
                                new ProcessError({
                                    operation: request.operation,
                                    command: request.command,
                                    args,
                                    cwd: request.cwd,
                                    message: error instanceof Error ? error.message : String(error),
                                }),
                            ),
                        );
                    });

                return Effect.sync(() => {
                    clearTimeout(timeout);
                    proc.kill();
                });
            });

        return ProcessService.of({ run });
    }),
);
```

- [ ] **Step 3: Add ProcessService to the app layer**

Modify `src/lib/layers.ts`:

```typescript
import { Layer } from "effect";
import { AgentctlConfigLive } from "./config.ts";
import { SurrealClientLive } from "./db.ts";
import { ProcessServiceLive } from "./process.ts";

const BaseLayer = Layer.mergeAll(AgentctlConfigLive);

export const AppLayer = Layer.mergeAll(
    SurrealClientLive,
    ProcessServiceLive,
).pipe(Layer.provideMerge(BaseLayer));
```

- [ ] **Step 4: Add focused tests**

Create `src/lib/process.test.ts` using `bun:test` and `Effect.runPromise`. Cover success, non-zero exit, and output truncation:

```typescript
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { makeAgentctlConfigTestLayer } from "./config.ts";
import { ProcessService, ProcessServiceLive } from "./process.ts";

const layer = ProcessServiceLive.pipe(
    Layer.provide(makeAgentctlConfigTestLayer({
        ingest: {
            defaultSinceDays: 30,
            maxSinceDays: 90,
            processTimeoutMs: 1000,
            maxOutputBytes: 8,
        },
    })),
);

describe("ProcessService", () => {
    test("captures stdout for successful commands", async () => {
        const result = await Effect.runPromise(
            Effect.gen(function* () {
                const process = yield* ProcessService;
                return yield* process.run({
                    operation: "test.echo",
                    command: "printf",
                    args: ["hello"],
                });
            }).pipe(Effect.provide(layer)),
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("hello");
        expect(result.stderr).toBe("");
    });

    test("fails with command metadata for non-zero exit", async () => {
        const result = await Effect.runPromiseExit(
            Effect.gen(function* () {
                const process = yield* ProcessService;
                return yield* process.run({
                    operation: "test.fail",
                    command: "sh",
                    args: ["-c", "echo nope >&2; exit 7"],
                });
            }).pipe(Effect.provide(layer)),
        );

        expect(result._tag).toBe("Failure");
        expect(String(result.cause)).toContain("test.fail");
        expect(String(result.cause)).toContain("exit");
    });

    test("caps stdout at configured max bytes", async () => {
        const result = await Effect.runPromise(
            Effect.gen(function* () {
                const process = yield* ProcessService;
                return yield* process.run({
                    operation: "test.truncate",
                    command: "printf",
                    args: ["abcdefghijklmnop"],
                });
            }).pipe(Effect.provide(layer)),
        );

        expect(result.stdout).toBe("abcdefgh");
        expect(result.stdoutTruncated).toBe(true);
    });
});
```

- [ ] **Step 5: Run verification**

Run:

```bash
bun test src/lib/process.test.ts
bun run typecheck
```

Expected: both commands PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/process.ts src/lib/process.test.ts src/lib/errors.ts src/lib/layers.ts
git commit -m "feat(effect): add process service"
```

## Task 3: Migrate Git Ingest to ProcessService

**Files:**
- Modify: `src/ingest/git.ts`
- Modify: `src/ingest/git.test.ts`
- Test: `bun test src/ingest/git.test.ts`

- [ ] **Step 1: Replace the local git runner**

In `src/ingest/git.ts`, remove the local `runGit` implementation and import `ProcessService`:

```typescript
import { ProcessService } from "../lib/process.ts";
```

Replace the git runner with a service-backed helper:

```typescript
interface RunResult {
    stdout: string;
    code: number;
}

const runGit = (
    cwd: string,
    args: ReadonlyArray<string>,
): Effect.Effect<RunResult, never, ProcessService> =>
    Effect.gen(function* () {
        const process = yield* ProcessService;
        const result = yield* process.run({
            operation: "git",
            command: "git",
            args: ["-C", cwd, ...args],
            cwd,
        }).pipe(
            Effect.catchTag("ProcessError", () =>
                Effect.succeed({
                    stdout: "",
                    stderr: "",
                    exitCode: 1,
                    stdoutTruncated: false,
                    stderrTruncated: false,
                }),
            ),
        );
        return { stdout: result.stdout, code: result.exitCode };
    });
```

Update any exported ingest effect types that currently require only `SurrealClient` so they also require `ProcessService` where git commands are executed.

- [ ] **Step 2: Add a mock process layer for git tests**

Create the reusable mock in `src/lib/test-layers.ts`:

```typescript
import { Effect, Layer } from "effect";
import { SurrealClient, type SurrealClientShape } from "./db.ts";
import { ProcessService, type ProcessRequest, type ProcessResult } from "./process.ts";

export const makeProcessMockLayer = (
    handler: (request: ProcessRequest) => ProcessResult,
): Layer.Layer<ProcessService> =>
    Layer.succeed(
        ProcessService,
        ProcessService.of({
            run: (request) => Effect.succeed(handler(request)),
        }),
    );

export const makeSurrealMockLayer = (
    overrides: Partial<SurrealClientShape> = {},
): Layer.Layer<SurrealClient> =>
    Layer.succeed(
        SurrealClient,
        SurrealClient.of({
            query: () => Effect.succeed([[]] as unknown[]),
            upsert: () => Effect.succeed(undefined),
            relate: () => Effect.succeed(undefined),
            putFile: () => Effect.void,
            getFile: () => Effect.succeed(""),
            raw: {} as SurrealClientShape["raw"],
            ...overrides,
        }),
    );
```

- [ ] **Step 3: Assert exact git command shape**

Add a test to `src/ingest/git.test.ts` that exercises `buildRepoInfo` after exporting it for tests:

```typescript
test("buildRepoInfo runs git through ProcessService with explicit cwd", async () => {
    const requests: Array<{ command: string; args: ReadonlyArray<string>; cwd?: string }> = [];
    const layer = makeProcessMockLayer((request) => {
        requests.push({
            command: request.command,
            args: request.args ?? [],
            cwd: request.cwd,
        });
        if (request.args?.includes("remote.origin.url")) {
            return { stdout: "git@github.com:Necmttn/agentctl.git\n", stderr: "", exitCode: 0, stdoutTruncated: false, stderrTruncated: false };
        }
        if (request.args?.includes("--max-parents=0")) {
            return { stdout: "1111111111111111111111111111111111111111\n", stderr: "", exitCode: 0, stdoutTruncated: false, stderrTruncated: false };
        }
        if (request.args?.includes("--git-dir")) {
            return { stdout: ".git\n", stderr: "", exitCode: 0, stdoutTruncated: false, stderrTruncated: false };
        }
        if (request.args?.includes("--show-current")) {
            return { stdout: "main\n", stderr: "", exitCode: 0, stdoutTruncated: false, stderrTruncated: false };
        }
        if (request.args?.includes("HEAD")) {
            return { stdout: "2222222222222222222222222222222222222222\n", stderr: "", exitCode: 0, stdoutTruncated: false, stderrTruncated: false };
        }
        return { stdout: "", stderr: "", exitCode: 1, stdoutTruncated: false, stderrTruncated: false };
    });

    const repo = await Effect.runPromise(buildRepoInfo("/repo/agentctl").pipe(Effect.provide(layer)));

    expect(repo.branch).toBe("main");
    expect(requests.every((request) => request.command === "git")).toBe(true);
    expect(requests.every((request) => request.cwd === "/repo/agentctl")).toBe(true);
    expect(requests[0].args).toEqual(["-C", "/repo/agentctl", "config", "--get", "remote.origin.url"]);
});
```

If `buildRepoInfo` reads `.git` from disk, split `readGitEntry` behind a small `GitFs` helper or make the test use a temporary directory with a `.git` directory:

```typescript
const tmp = await mkdtemp(join(tmpdir(), "agentctl-git-"));
await mkdir(join(tmp, ".git"));
```

- [ ] **Step 4: Run verification**

Run:

```bash
bun test src/ingest/git.test.ts
bun run typecheck
```

Expected: both commands PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/git.ts src/ingest/git.test.ts src/lib/test-layers.ts
git commit -m "refactor(ingest): run git through process service"
```

## Task 4: Add Shared Schemas and Boundary Decoders

**Files:**
- Create: `src/lib/schemas.ts`
- Create: `src/lib/schemas.test.ts`
- Modify: `src/lib/errors.ts`
- Modify: `src/ingest/transcripts.ts`
- Modify: `src/ingest/codex.ts`
- Modify: `src/queries/insights.ts`
- Test: `bun test src/lib/schemas.test.ts src/ingest/transcripts.test.ts src/ingest/codex.test.ts src/queries/insights.test.ts`

- [ ] **Step 1: Add decode error type**

Modify `src/lib/errors.ts`:

```typescript
export class DecodeError extends Schema.TaggedErrorClass<DecodeError>(
    "DecodeError",
)("DecodeError", {
    boundary: Schema.String,
    message: Schema.String,
    issues: Schema.String,
}) {}
```

- [ ] **Step 2: Create branded schemas and helpers**

Create `src/lib/schemas.ts`:

```typescript
import { Effect, Schema } from "effect";
import { DecodeError } from "./errors.ts";

export const SessionId = Schema.String.pipe(Schema.minLength(1), Schema.brand("SessionId"));
export type SessionId = typeof SessionId.Type;

export const TurnId = Schema.String.pipe(Schema.minLength(1), Schema.brand("TurnId"));
export type TurnId = typeof TurnId.Type;

export const SkillId = Schema.String.pipe(Schema.minLength(1), Schema.brand("SkillId"));
export type SkillId = typeof SkillId.Type;

export const FileId = Schema.String.pipe(Schema.minLength(1), Schema.brand("FileId"));
export type FileId = typeof FileId.Type;

export const CommitSha = Schema.String.pipe(
    Schema.pattern(/^[0-9a-f]{40}$/i),
    Schema.brand("CommitSha"),
);
export type CommitSha = typeof CommitSha.Type;

export const RepositoryKey = Schema.String.pipe(Schema.minLength(1), Schema.brand("RepositoryKey"));
export type RepositoryKey = typeof RepositoryKey.Type;

export const CheckoutKey = Schema.String.pipe(Schema.minLength(1), Schema.brand("CheckoutKey"));
export type CheckoutKey = typeof CheckoutKey.Type;

export const JsonRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown });

export const ClaudeJsonlEntry = Schema.Struct({
    uuid: Schema.optional(Schema.String),
    parentUuid: Schema.optional(Schema.NullOr(Schema.String)),
    type: Schema.String,
    timestamp: Schema.optional(Schema.String),
    cwd: Schema.optional(Schema.NullOr(Schema.String)),
    message: Schema.optional(Schema.Unknown),
    toolUseResult: Schema.optional(Schema.Unknown),
});

export const CodexJsonlEntry = Schema.Struct({
    timestamp: Schema.optional(Schema.String),
    type: Schema.String,
    payload: Schema.optional(Schema.Unknown),
});

export const SurrealInsightRow = Schema.Record({
    key: Schema.String,
    value: Schema.Unknown,
});

export const decodeBoundary =
    <A, I>(boundary: string, schema: Schema.Schema<A, I>) =>
    (input: I): Effect.Effect<A, DecodeError> =>
        Schema.decodeUnknown(schema)(input).pipe(
            Effect.mapError(
                (error) =>
                    new DecodeError({
                        boundary,
                        message: `failed to decode ${boundary}`,
                        issues: String(error),
                    }),
            ),
        );

export const decodeJsonString =
    <A, I>(boundary: string, schema: Schema.Schema<A, I>) =>
    (input: string): Effect.Effect<A, DecodeError> =>
        Effect.try({
            try: () => JSON.parse(input) as I,
            catch: (error) =>
                new DecodeError({
                    boundary,
                    message: `failed to parse JSON string for ${boundary}`,
                    issues: error instanceof Error ? error.message : String(error),
                }),
        }).pipe(Effect.flatMap(decodeBoundary(boundary, schema)));
```

- [ ] **Step 3: Add schema tests**

Create `src/lib/schemas.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
    CommitSha,
    ClaudeJsonlEntry,
    decodeBoundary,
    decodeJsonString,
    JsonRecord,
} from "./schemas.ts";

describe("schemas", () => {
    test("accepts valid commit shas", async () => {
        const sha = await Effect.runPromise(
            decodeBoundary("commit", CommitSha)("0123456789abcdef0123456789abcdef01234567"),
        );
        expect(sha).toBe("0123456789abcdef0123456789abcdef01234567");
    });

    test("rejects invalid commit shas with boundary name", async () => {
        const result = await Effect.runPromiseExit(
            decodeBoundary("commit", CommitSha)("short"),
        );
        expect(result._tag).toBe("Failure");
        expect(String(result.cause)).toContain("commit");
    });

    test("decodes JSON strings stored in Surreal string fields", async () => {
        const value = await Effect.runPromise(
            decodeJsonString("stored-json", JsonRecord)('{"kind":"ok"}'),
        );
        expect(value.kind).toBe("ok");
    });

    test("decodes Claude JSONL boundary shape", async () => {
        const entry = await Effect.runPromise(
            decodeBoundary("claude-jsonl", ClaudeJsonlEntry)({
                type: "assistant",
                timestamp: "2026-05-10T00:00:00.000Z",
                message: { content: [] },
            }),
        );
        expect(entry.type).toBe("assistant");
    });
});
```

- [ ] **Step 4: Apply decoders at ingest boundaries**

In `src/ingest/transcripts.ts`, replace raw `JSON.parse` acceptance with:

```typescript
const parseJsonl = (line: string): Effect.Effect<Record<string, unknown> | null, DecodeError> =>
    Effect.try({
        try: () => JSON.parse(line) as unknown,
        catch: () => null,
    }).pipe(
        Effect.flatMap((parsed) => {
            if (parsed === null) return Effect.succeed(null);
            return decodeBoundary("claude-jsonl", ClaudeJsonlEntry)(parsed).pipe(
                Effect.map((entry) => entry as Record<string, unknown>),
            );
        }),
    );
```

Update call sites that currently expect a nullable value from `parseJsonl` to `yield* parseJsonl(line)`.

In `src/ingest/codex.ts`, use the same pattern with `CodexJsonlEntry` and boundary name `codex-jsonl`.

In `src/queries/insights.ts`, decode Surreal rows before rendering or returning them:

```typescript
const decodeInsightRows = (rows: unknown[]): Effect.Effect<Array<Record<string, unknown>>, DecodeError> =>
    Effect.forEach(rows, decodeBoundary("insight-row", SurrealInsightRow), {
        concurrency: 16,
    });
```

- [ ] **Step 5: Run verification**

Run:

```bash
bun test src/lib/schemas.test.ts src/ingest/transcripts.test.ts src/ingest/codex.test.ts src/queries/insights.test.ts
bun run typecheck
```

Expected: both commands PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/schemas.ts src/lib/schemas.test.ts src/lib/errors.ts src/ingest/transcripts.ts src/ingest/codex.ts src/queries/insights.ts
git commit -m "feat(effect): decode external data at boundaries"
```

## Task 5: Add Mock Layers for Service Tests

**Files:**
- Modify: `src/lib/test-layers.ts`
- Modify: `src/ingest/git.test.ts`
- Modify: `src/dashboard/report.test.ts`
- Modify: `src/queries/insights.test.ts`
- Test: `bun test src/ingest/git.test.ts src/dashboard/report.test.ts src/queries/insights.test.ts`

- [ ] **Step 1: Expand mock layer helpers**

Modify `src/lib/test-layers.ts` so tests can inspect calls:

```typescript
export interface ProcessMock {
    readonly requests: ProcessRequest[];
    readonly layer: Layer.Layer<ProcessService>;
}

export const makeRecordingProcessMock = (
    handler: (request: ProcessRequest) => ProcessResult,
): ProcessMock => {
    const requests: ProcessRequest[] = [];
    return {
        requests,
        layer: makeProcessMockLayer((request) => {
            requests.push(request);
            return handler(request);
        }),
    };
};

export interface SurrealMock {
    readonly queries: Array<{ sql: string; bindings?: Record<string, unknown> }>;
    readonly upserts: Array<{ id: unknown; content: Record<string, unknown> }>;
    readonly layer: Layer.Layer<SurrealClient>;
}

export const makeRecordingSurrealMock = (
    results: unknown[][] = [[]],
): SurrealMock => {
    const queries: Array<{ sql: string; bindings?: Record<string, unknown> }> = [];
    const upserts: Array<{ id: unknown; content: Record<string, unknown> }> = [];
    return {
        queries,
        upserts,
        layer: makeSurrealMockLayer({
            query: (sql, bindings) =>
                Effect.sync(() => {
                    queries.push({ sql, bindings });
                    return results as never;
                }),
            upsert: (id, content) =>
                Effect.sync(() => {
                    upserts.push({ id, content });
                    return undefined;
                }),
        }),
    };
};
```

- [ ] **Step 2: Convert high-value DB tests to mock layers**

In `src/queries/insights.test.ts`, add one test that runs the real query function with `makeRecordingSurrealMock` and asserts the SQL uses the expected view-specific index or grouping logic. Use this pattern:

```typescript
const db = makeRecordingSurrealMock([[{ id: "skill:one", name: "one" }]]);
await Effect.runPromise(
    runInsightView("tools", 10).pipe(Effect.provide(db.layer)),
);
expect(db.queries[0].sql).toContain("FROM invoked");
expect(db.queries[0].sql).toContain("GROUP BY");
```

If the public function only returns SQL today, keep existing pure tests and add a smaller `SurrealClient` integration point before adding this test:

```typescript
export const queryInsightView = (view: InsightView, limit: number) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const result = yield* db.query<[Array<Record<string, unknown>>]>(
            insightSqlForView(view, limit),
        );
        return result?.[0] ?? [];
    });
```

- [ ] **Step 3: Keep mock tests narrow**

Convert only tests that benefit from layers:

```bash
bun test src/ingest/git.test.ts
bun test src/queries/insights.test.ts
bun test src/dashboard/report.test.ts
```

Expected: all three commands PASS.

- [ ] **Step 4: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/test-layers.ts src/ingest/git.test.ts src/dashboard/report.test.ts src/queries/insights.test.ts
git commit -m "test(effect): add service mock layers"
```

## Task 6: Refactor CLI to Effect Commands

**Files:**
- Modify: `package.json`
- Create: `src/cli/commands.ts`
- Modify: `src/cli/index.ts`
- Test: `bun run typecheck`

- [ ] **Step 1: Add CLI packages**

Run:

```bash
bun add @effect/cli @effect/platform @effect/platform-bun
```

Expected: `package.json` and `bun.lock` update with the new dependencies.

- [ ] **Step 2: Extract commands**

Create `src/cli/commands.ts` and move command handlers out of `src/cli/index.ts`. Use `Options.integer(...).pipe(Options.withDefault(...))` for `--limit`, `--days`, and `--since`, and `Options.boolean(...)` for ingest filters.

Define one command constant per current command:

| Current command | New constant |
| --- | --- |
| `ingest` | `ingestCommand` |
| `ingest-insights` | `ingestInsightsCommand` |
| `derive-signals` | `deriveSignalsCommand` |
| `insights` | `insightsCommand` |
| `dashboard` | `dashboardCommand` |
| `search` | `searchCommand` |
| `stats` | `statsCommand` |
| `recent` | `recentCommand` |
| `unused` | `unusedCommand` |
| `taste` | `tasteCommand` |
| `pairs` | `pairsCommand` |
| `recovery` | `recoveryCommand` |
| `project` | `projectCommand` |
| `tui` | `tuiCommand` |
| `install` | `installCommand` |
| `uninstall` | `uninstallCommand` |

Use this structure for the first migrated command, then repeat the same `Command.make` shape for each listed constant with the existing handler body from `src/cli/index.ts`:

```typescript
import { Command, Options } from "@effect/cli";
import { Console, Effect } from "effect";
import { ingestSkills } from "../ingest/skills.ts";
import { ingestCommands } from "../ingest/commands.ts";
import { ingestTranscripts } from "../ingest/transcripts.ts";
import { ingestCodex } from "../ingest/codex.ts";
import { ingestGit } from "../ingest/git.ts";
import { deriveSignals } from "../ingest/derive-signals.ts";

const since = Options.integer("since").pipe(Options.optional);
const limit = Options.integer("limit").pipe(Options.withDefault(20));

const ingestCommand = Command.make(
    "ingest",
    {
        since,
        skillsOnly: Options.boolean("skills-only"),
        transcriptsOnly: Options.boolean("transcripts-only"),
        claudeOnly: Options.boolean("claude-only"),
        codexOnly: Options.boolean("codex-only"),
        gitOnly: Options.boolean("git-only"),
    },
    ({ since, skillsOnly, transcriptsOnly, claudeOnly, codexOnly, gitOnly }) =>
        Effect.gen(function* () {
            const setOnly = [
                ["--skills-only", skillsOnly],
                ["--transcripts-only", transcriptsOnly],
                ["--claude-only", claudeOnly],
                ["--codex-only", codexOnly],
                ["--git-only", gitOnly],
            ].filter(([, value]) => value).map(([flag]) => flag);

            if (setOnly.length > 1) {
                yield* Console.error(
                    `agentctl ingest: ${setOnly.join(", ")} are mutually exclusive`,
                );
                return yield* Effect.fail(new Error("invalid ingest filters"));
            }

            const sinceDays = since._tag === "Some" ? since.value : undefined;

            if (!transcriptsOnly && !codexOnly && !gitOnly) {
                yield* ingestSkills();
                yield* ingestCommands();
            }
            if (!skillsOnly && !codexOnly && !gitOnly) {
                yield* ingestTranscripts({ sinceDays });
            }
            if (!skillsOnly && !transcriptsOnly && !claudeOnly && !gitOnly) {
                yield* ingestCodex({ sinceDays });
            }
            if (!skillsOnly && !transcriptsOnly && !codexOnly && !claudeOnly) {
                yield* ingestGit({ sinceDays });
            }
            if (!skillsOnly && !gitOnly) {
                yield* deriveSignals({ sinceDays });
            }
        }),
);

export const agentctlCommand = Command.make("agentctl").pipe(
    Command.withSubcommands([
        ingestCommand,
        ingestInsightsCommand,
        deriveSignalsCommand,
        insightsCommand,
        dashboardCommand,
        searchCommand,
        statsCommand,
        recentCommand,
        unusedCommand,
        tasteCommand,
        pairsCommand,
        recoveryCommand,
        projectCommand,
        tuiCommand,
        installCommand,
        uninstallCommand,
    ]),
);
```

- [ ] **Step 3: Bootstrap the CLI**

Reduce `src/cli/index.ts` to:

```typescript
#!/usr/bin/env bun
import { Command } from "@effect/cli";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { AppLayer } from "../lib/layers.ts";
import { agentctlCommand } from "./commands.ts";

const cli = Command.run(agentctlCommand, {
    name: "agentctl",
    version: "0.1.1",
});

const MainLayer = AppLayer.pipe(Layer.provideMerge(BunContext.layer));

cli(process.argv).pipe(
    Effect.provide(MainLayer),
    BunRuntime.runMain,
);
```

- [ ] **Step 4: Preserve command behavior**

Run smoke commands against help and parsing:

```bash
bun src/cli/index.ts --help
bun src/cli/index.ts ingest --help
bun src/cli/index.ts insights repositories --limit 1
bun src/cli/index.ts project context --json
```

Expected:

- Help lists all existing top-level commands.
- `ingest --help` lists the five ingest filters.
- `insights repositories --limit 1` prints JSON or a typed DB connection error.
- `project context --json` prints JSON without touching the database.

- [ ] **Step 5: Run verification**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock src/cli/commands.ts src/cli/index.ts
git commit -m "refactor(cli): use effect command parser"
```

## Task 7: Add Structured Diagnostics

**Files:**
- Create: `src/lib/diagnostics.ts`
- Modify: `src/lib/layers.ts`
- Modify: `src/ingest/git.ts`
- Modify: `src/ingest/transcripts.ts`
- Modify: `src/ingest/codex.ts`
- Modify: `src/queries/insights.ts`
- Modify: `src/dashboard/report.ts`
- Test: `bun run typecheck`

- [ ] **Step 1: Add diagnostics service**

Create `src/lib/diagnostics.ts`:

```typescript
import { Clock, Context, Effect, Layer } from "effect";

export interface DiagnosticEvent {
    readonly name: string;
    readonly stage: string;
    readonly status: "ok" | "error";
    readonly startedAt: string;
    readonly durationMs: number;
    readonly fields: Readonly<Record<string, unknown>>;
}

export interface DiagnosticsShape {
    readonly emit: (event: DiagnosticEvent) => Effect.Effect<void>;
    readonly timed: <A, E, R>(
        name: string,
        stage: string,
        fields: Readonly<Record<string, unknown>>,
        effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
}

export class Diagnostics extends Context.Service<
    Diagnostics,
    DiagnosticsShape
>()("agentctl/Diagnostics") {}

export const DiagnosticsLive: Layer.Layer<Diagnostics> = Layer.effect(
    Diagnostics,
    Effect.gen(function* () {
        const emit = (event: DiagnosticEvent) =>
            Effect.sync(() => {
                console.error(JSON.stringify({ kind: "agentctl.diagnostic", ...event }));
            });

        const timed = <A, E, R>(
            name: string,
            stage: string,
            fields: Readonly<Record<string, unknown>>,
            effect: Effect.Effect<A, E, R>,
        ): Effect.Effect<A, E, R> =>
            Effect.gen(function* () {
                const startedMs = yield* Clock.currentTimeMillis;
                const startedAt = new Date(startedMs).toISOString();
                const exit = yield* Effect.exit(effect);
                const endedMs = yield* Clock.currentTimeMillis;
                yield* emit({
                    name,
                    stage,
                    status: exit._tag === "Success" ? "ok" : "error",
                    startedAt,
                    durationMs: endedMs - startedMs,
                    fields,
                });
                return yield* Effect.done(exit);
            });

        return Diagnostics.of({ emit, timed });
    }),
);

export const DiagnosticsNoop: Layer.Layer<Diagnostics> = Layer.succeed(
    Diagnostics,
    Diagnostics.of({
        emit: () => Effect.void,
        timed: (_name, _stage, _fields, effect) => effect,
    }),
);
```

- [ ] **Step 2: Wire diagnostics into AppLayer**

Modify `src/lib/layers.ts`:

```typescript
import { DiagnosticsLive } from "./diagnostics.ts";

export const AppLayer = Layer.mergeAll(
    SurrealClientLive,
    ProcessServiceLive,
    DiagnosticsLive,
).pipe(Layer.provideMerge(BaseLayer));
```

- [ ] **Step 3: Instrument expensive stages**

In each ingest module, wrap top-level stages:

```typescript
const diagnostics = yield* Diagnostics;
yield* diagnostics.timed(
    "ingest.git",
    "discover-repos",
    { sinceDays },
    discoverRepos(),
);
```

Use these event names:

- `ingest.git`: `discover-repos`, `fetch-commits`, `write-repo`
- `ingest.transcripts`: `walk-files`, `parse-file`, `write-session`
- `ingest.codex`: `walk-files`, `parse-file`, `write-session`
- `queries.insights`: `query-view`
- `dashboard.report`: `load-data`, `write-html`

- [ ] **Step 4: Keep stdout clean**

Confirm diagnostics writes to stderr by running:

```bash
bun src/cli/index.ts project context --json > /tmp/agentctl-context.json
cat /tmp/agentctl-context.json | head -n 1
```

Expected: first line starts with `{` and no diagnostic JSON appears in stdout.

- [ ] **Step 5: Run verification**

Run:

```bash
bun run typecheck
bun test src/ingest/git.test.ts src/ingest/transcripts.test.ts src/ingest/codex.test.ts src/queries/insights.test.ts src/dashboard/report.test.ts
```

Expected: both commands PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/diagnostics.ts src/lib/layers.ts src/ingest/git.ts src/ingest/transcripts.ts src/ingest/codex.ts src/queries/insights.ts src/dashboard/report.ts
git commit -m "feat(effect): add structured diagnostics"
```

## Task 8: Final Integration Check

**Files:**
- Modify: `README.md` only if command usage changes from manual CLI parsing to `effect/unstable/cli` help output.
- Test: full local verification.

- [ ] **Step 1: Run static checks**

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 2: Run unit tests**

```bash
bun test
```

Expected: PASS.

- [ ] **Step 3: Run CLI smoke tests**

```bash
bun src/cli/index.ts --help
bun src/cli/index.ts project context --json
bun src/cli/index.ts insights repositories --limit 1
```

Expected:

- `--help` exits 0 and lists commands.
- `project context --json` exits 0 and prints JSON.
- `insights repositories --limit 1` exits 0 with JSON when the local DB is running, or exits non-zero with a typed connection message when the DB is stopped.

- [ ] **Step 4: Review service boundaries**

Run:

```bash
rg "process\\.env|Bun\\.spawn|JSON\\.parse|db\\.query" src
```

Expected:

- `process.env` appears only in config/bootstrap code or process env merging.
- `Bun.spawn` appears only in `src/lib/process.ts`.
- `JSON.parse` appears only in boundary decoder helpers or parse functions that immediately call `decodeBoundary`.
- `db.query` appears in persistence/query modules, not inside CLI argument parsing.

- [ ] **Step 5: Commit final documentation updates**

```bash
git add README.md
git commit -m "docs: document effect service patterns"
```

Skip this commit when `README.md` did not change.

## Self-Review Checklist

- Every service uses `Context.Service` plus `Layer.effect` or `Layer.succeed`.
- `AgentctlConfig` owns env/default resolution.
- `SurrealClientLive` no longer calls `process.env`.
- `ProcessService` is the only place that calls `Bun.spawn`.
- Ingest modules decode JSONL and Surreal string JSON at boundaries.
- Tests can provide mock `SurrealClient`, `ProcessService`, and config layers without live DB or git.
- CLI parsing errors happen before DB work starts.
- Diagnostics emit structured JSON to stderr and preserve stdout for machine-readable command output.
