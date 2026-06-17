# Profile Publish + Fork Rails (Plan 2 of 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ax profile publish` pushes the ProfileV1 artifact to a user-owned public gist (create once, PATCH in place), registers the user via fork + PR into `Necmttn/ax` (`community/users/<login>.json`), and the watcher keeps the gist fresh; `ax profile unpublish` reverses it.

**Architecture:** A `GitHubEnv` Effect service (mirrors hooks-sdk `GitEnv`: Context.Service + Live/Test layers) wraps every `gh api` call so all publish logic is layer-testable without network. Local consent + gist state lives in `~/.ax/profile-publish.json` (atomic-write). The publish pipeline: render (Plan 1 `buildProfile`) → first-run consent (print exact JSON, y/N) → gist create/patch → one-time registration (fork → remote commit via git-data API, no local clone → PR). Watcher plist gains a debounced `profile publish --if-stale=2h` step that silently no-ops until the user has consented once.

**Tech Stack:** bun, effect@beta v4, `gh` CLI (auth + API transport), `@ax/lib/atomic-write`, bun:test with layer mocks.

**Conventions that bite:**
- Effect v4 beta: run `effect-solutions show services-and-layers data-modeling` before writing service code; verify against `.references/effect-smol/packages/effect/src` and the in-repo exemplar `packages/hooks-sdk/src/git-env.ts` (Context.Service + `Layer.succeed` live/test shapes).
- No `node:fs` (CI gate). Bun APIs or `@ax/lib/atomic-write` (Effect FileSystem) only.
- `bun test` may be hook-blocked → run via `/tmp/run-ax-tests.sh` (`bun test "$@"`).
- New CLI subcommands must be reflected in `docs/cli.md` (CI gate `check:cli-reference`) and registered in BOTH `registeredCommands` and `RUNTIME_BY_COMMAND` (`effect-cli.test.ts` gate).
- Interactive confirm pattern: `globalThis.prompt?.("...")` (see `apps/axctl/src/cli/install.ts:1041`).
- Gist update-in-place: `gh api --method PATCH /gists/:id` (gist URL must never change once shared).
- PUBLISH GATE (from Plan 1, `profile/taste.ts` header): taste summaries are raw proposal prose - the consent preview MUST show them verbatim before anything leaves the machine.

**File structure:**

```
apps/axctl/src/profile/
├── github-env.ts        # GitHubEnv service: api(method, path, body?) + login(); Live(gh)/Test layers
├── github-env.test.ts
├── publish-state.ts     # ~/.ax/profile-publish.json codec + load/save (path injectable)
├── publish-state.test.ts
├── publish.ts           # gist payload, create/patch, staleness, fork+registration+PR ops
└── publish.test.ts
apps/axctl/src/cli/commands/profile.ts   # extend: publish + unpublish subcommands
scripts/com.necmttn.ax-watch.plist       # append profile publish --if-stale step
docs/cli.md, CLAUDE.md                   # command reference (CI gate)
```

---

### Task 1: `GitHubEnv` service

**Files:**
- Create: `apps/axctl/src/profile/github-env.ts`
- Test: `apps/axctl/src/profile/github-env.test.ts`
- Reference (read first): `packages/hooks-sdk/src/git-env.ts` (service shape), `apps/axctl/src/share/gist.ts:80-117` (gh spawn + error mapping)

- [ ] **Step 1: Consult guides**

Run: `effect-solutions show services-and-layers`. Confirm v4 `Context.Service` + `Layer.succeed` usage matches `git-env.ts`.

- [ ] **Step 2: Write the failing test**

```ts
// apps/axctl/src/profile/github-env.test.ts
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { GitHubEnv, GitHubEnvTest } from "./github-env.ts";

const run = <A, E>(eff: Effect.Effect<A, E, GitHubEnv>, layer: ReturnType<typeof GitHubEnvTest>) =>
    Effect.runPromise(eff.pipe(Effect.provide(layer.layer)) as Effect.Effect<A, E>);

describe("GitHubEnvTest", () => {
    test("replays canned responses per METHOD path key and records calls", async () => {
        const t = GitHubEnvTest({
            responses: { "POST /gists": { id: "abc123", owner: { login: "necmttn" } } },
            login: "necmttn",
        });
        const out = await run(
            Effect.gen(function* () {
                const gh = yield* GitHubEnv;
                const created = yield* gh.api("POST", "/gists", { files: {} });
                const login = yield* gh.login();
                return { created, login };
            }),
            t,
        );
        expect((out.created as { id: string }).id).toBe("abc123");
        expect(out.login).toBe("necmttn");
        expect(t.calls).toEqual([{ method: "POST", path: "/gists", body: { files: {} } }]);
    });

    test("missing canned response fails with GitHubApiError", async () => {
        const t = GitHubEnvTest({ responses: {} });
        const result = await run(
            Effect.gen(function* () {
                const gh = yield* GitHubEnv;
                return yield* gh.api("GET", "/user").pipe(
                    Effect.map(() => "ok" as const),
                    Effect.catchTag("GitHubApiError", (e) => Effect.succeed(`err:${e.status}`)),
                );
            }),
            t,
        );
        expect(result).toBe("err:404");
    });
});
```

- [ ] **Step 3: Run test, verify FAIL** (`/tmp/run-ax-tests.sh apps/axctl/src/profile/github-env.test.ts`)

- [ ] **Step 4: Implement**

```ts
// apps/axctl/src/profile/github-env.ts
/**
 * GitHubEnv - the single seam through which profile publish talks to
 * GitHub. Live layer shells out to `gh api` (auth handled by gh); the test
 * layer replays canned responses and records calls, so every publish
 * operation is testable without network. Mirrors hooks-sdk GitEnv.
 */
import { Context, Effect, Layer, Schema } from "effect";

export class GitHubApiError extends Schema.TaggedErrorClass<GitHubApiError>(
    "GitHubApiError",
)("GitHubApiError", {
    status: Schema.Number,
    message: Schema.String,
}) {}

export type GhMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface GitHubEnvService {
    /** `gh api --method <method> <path>` with optional JSON body on stdin. */
    readonly api: (
        method: GhMethod,
        path: string,
        body?: unknown,
    ) => Effect.Effect<unknown, GitHubApiError>;
    /** authenticated login, null when gh is missing/unauthenticated. */
    readonly login: () => Effect.Effect<string | null>;
}

export class GitHubEnv extends Context.Service<GitHubEnv, GitHubEnvService>()(
    "axctl/profile/GitHubEnv",
) {}

const ghApi = async (method: GhMethod, path: string, body?: unknown): Promise<unknown> => {
    const args = ["gh", "api", "--method", method, path, ...(body !== undefined ? ["--input", "-"] : [])];
    const proc = Bun.spawn(args, {
        stdin: body !== undefined ? "pipe" : "ignore",
        stdout: "pipe",
        stderr: "pipe",
    });
    if (body !== undefined) {
        proc.stdin.write(JSON.stringify(body));
        proc.stdin.end();
    }
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    if (exitCode !== 0) {
        // gh prints "gh: Not Found (HTTP 404)" style messages on stderr.
        const m = /HTTP (\d{3})/.exec(stderr);
        throw new GitHubApiError({
            status: m ? Number(m[1]) : 1,
            message: stderr.trim() || stdout.trim() || `gh api ${path} exited ${exitCode}`,
        });
    }
    return stdout.trim() === "" ? null : JSON.parse(stdout);
};

const liveShape: GitHubEnvService = {
    api: (method, path, body) =>
        Effect.tryPromise({
            try: () => ghApi(method, path, body),
            catch: (e) =>
                e instanceof GitHubApiError
                    ? e
                    : new GitHubApiError({ status: 0, message: e instanceof Error ? e.message : String(e) }),
        }),
    login: () =>
        Effect.tryPromise({
            try: async () => {
                const proc = Bun.spawn(["gh", "api", "user", "--jq", ".login"], {
                    stdout: "pipe",
                    stderr: "ignore",
                });
                const out = await new Response(proc.stdout).text();
                return (await proc.exited) === 0 && out.trim() !== "" ? out.trim() : null;
            },
            catch: () => null,
        }).pipe(Effect.orElseSucceed(() => null)),
};

export const GitHubEnvLive: Layer.Layer<GitHubEnv> = Layer.succeed(GitHubEnv)(liveShape);

export interface RecordedCall {
    readonly method: GhMethod;
    readonly path: string;
    readonly body?: unknown;
}

/** Test layer: canned responses keyed "METHOD path"; records every call. */
export const GitHubEnvTest = (config: {
    responses: Record<string, unknown>;
    login?: string | null;
}): { layer: Layer.Layer<GitHubEnv>; calls: RecordedCall[] } => {
    const calls: RecordedCall[] = [];
    const layer = Layer.succeed(GitHubEnv)({
        api: (method, path, body) => {
            calls.push(body !== undefined ? { method, path, body } : { method, path });
            const key = `${method} ${path}`;
            if (key in config.responses) return Effect.succeed(config.responses[key]);
            return Effect.fail(new GitHubApiError({ status: 404, message: `no canned response for ${key}` }));
        },
        login: () => Effect.succeed(config.login ?? null),
    });
    return { layer, calls };
};
```

Adapt API names to real v4 (e.g. `Schema.TaggedErrorClass` usage is the live pattern in `share/gist.ts:10-14` - copy it exactly).

- [ ] **Step 5: Run test, verify PASS (2 tests)**

- [ ] **Step 6: Typecheck + commit**

```bash
bun run typecheck
git add apps/axctl/src/profile/github-env.ts apps/axctl/src/profile/github-env.test.ts
git commit -m "feat(profile): GitHubEnv service - layer-testable gh api seam"
```

---

### Task 2: Publish state file

**Files:**
- Create: `apps/axctl/src/profile/publish-state.ts`
- Test: `apps/axctl/src/profile/publish-state.test.ts`

State = consent + gist pointer + last publish time. Lives at `~/.ax/profile-publish.json`. Path injectable; tests use a tmp dir. Use plain Bun file IO (this is a 100-byte JSON, atomic-write's FileSystem dependency is overkill here - but validate on read).

- [ ] **Step 1: Write the failing test**

```ts
// apps/axctl/src/profile/publish-state.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { loadPublishState, savePublishState, type PublishState } from "./publish-state.ts";

const dir = `/tmp/ax-publish-state-test-${process.pid}`;
const path = `${dir}/profile-publish.json`;

afterEach(async () => {
    await Bun.$`rm -rf ${dir}`.quiet().nothrow();
});

const state: PublishState = {
    v: 1,
    gist_id: "abc123",
    owner: "necmttn",
    consented_at: "2026-06-12T19:00:00Z",
    published_at: "2026-06-12T19:00:00Z",
    no_cost: false,
};

describe("publish state", () => {
    test("round-trips", async () => {
        await savePublishState(path, state);
        expect(await loadPublishState(path)).toEqual(state);
    });

    test("missing file -> null", async () => {
        expect(await loadPublishState(`${dir}/nope.json`)).toBeNull();
    });

    test("corrupt file -> null (never throws)", async () => {
        await Bun.write(path, "{not json");
        expect(await loadPublishState(path)).toBeNull();
    });

    test("wrong shape -> null", async () => {
        await Bun.write(path, JSON.stringify({ v: 99 }));
        expect(await loadPublishState(path)).toBeNull();
    });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

```ts
// apps/axctl/src/profile/publish-state.ts
/**
 * Local publish state: consent + gist pointer + freshness. One JSON at
 * ~/.ax/profile-publish.json. Deleting the file revokes consent (the
 * watcher step no-ops without it). Reads never throw - any corruption
 * degrades to "not published yet".
 */
export interface PublishState {
    readonly v: 1;
    readonly gist_id: string;
    readonly owner: string;
    readonly consented_at: string;
    readonly published_at: string;
    readonly no_cost: boolean;
}

export const defaultPublishStatePath = (): string =>
    `${process.env.HOME}/.ax/profile-publish.json`;

export async function loadPublishState(path: string): Promise<PublishState | null> {
    try {
        const file = Bun.file(path);
        if (!(await file.exists())) return null;
        const raw: unknown = JSON.parse(await file.text());
        if (typeof raw !== "object" || raw === null) return null;
        const r = raw as Record<string, unknown>;
        if (
            r.v !== 1 ||
            typeof r.gist_id !== "string" ||
            typeof r.owner !== "string" ||
            typeof r.consented_at !== "string" ||
            typeof r.published_at !== "string" ||
            typeof r.no_cost !== "boolean"
        ) {
            return null;
        }
        return {
            v: 1,
            gist_id: r.gist_id,
            owner: r.owner,
            consented_at: r.consented_at,
            published_at: r.published_at,
            no_cost: r.no_cost,
        };
    } catch {
        return null;
    }
}

export async function savePublishState(path: string, state: PublishState): Promise<void> {
    // Sibling tmp + rename: same-directory rename is atomic.
    const tmp = `${path}.${process.pid}.tmp`;
    await Bun.write(tmp, `${JSON.stringify(state, null, 2)}\n`, { createPath: true });
    const { renameSync } = await import("node:fs"); // NOT allowed - see note
    renameSync(tmp, path);
}
```

NOTE: `node:fs` is banned by the `check:no-node-fs` gate. Check `scripts/` for the gate's allowlist OR use the repo-blessed alternative: look at how `packages/lib/src/runtime-state.ts` (or similar local-state writers) persist small JSON without node:fs, and mirror that. If no precedent exists, `Bun.write(tmp)` + `Bun.spawnSync(["mv", tmp, path])` is an acceptable atomic rename without node:fs. Resolve this at implementation time; the test is the contract.

- [ ] **Step 4: Run, verify PASS (4 tests)**

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/profile/publish-state.ts apps/axctl/src/profile/publish-state.test.ts
git commit -m "feat(profile): local publish state (consent + gist pointer)"
```

---

### Task 3: Publish operations

**Files:**
- Create: `apps/axctl/src/profile/publish.ts`
- Test: `apps/axctl/src/profile/publish.test.ts`

All ops take `GitHubEnv` from context - pure orchestration, fully tested via `GitHubEnvTest`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/axctl/src/profile/publish.test.ts
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { GitHubEnvTest } from "./github-env.ts";
import {
    createProfileGist,
    ensureRegistration,
    isStale,
    patchProfileGist,
    profileGistPayload,
    REGISTRY_REPO,
} from "./publish.ts";
import type { ProfileV1 } from "./schema.ts";

const profile = {
    v: 1, github: "necmttn", generated_at: "2026-06-12T19:00:00Z", window_days: 30,
    stats: {
        sessions: 1, active_days: 1, streak_days: 1,
        tokens: { prompt: 1, completion: 1, total: 2 },
        models: [], harnesses: ["claude"],
    },
    rig: { skills: [], hooks: [], routing_table: false },
} as unknown as ProfileV1;

const run = <A, E>(eff: Effect.Effect<A, E, never>) => Effect.runPromise(eff);

describe("profileGistPayload", () => {
    test("one file, public, stable filename", () => {
        const p = profileGistPayload(profile);
        expect(p.public).toBe(true);
        expect(Object.keys(p.files)).toEqual(["ax-profile.json"]);
        expect(JSON.parse(p.files["ax-profile.json"]!.content).github).toBe("necmttn");
    });
});

describe("isStale", () => {
    test("fresh within ttl", () => {
        expect(isStale("2026-06-12T18:00:00Z", 6, "2026-06-12T19:00:00Z")).toBe(false);
    });
    test("stale past ttl", () => {
        expect(isStale("2026-06-12T10:00:00Z", 6, "2026-06-12T19:00:00Z")).toBe(true);
    });
    test("garbage timestamp counts as stale", () => {
        expect(isStale("nope", 6, "2026-06-12T19:00:00Z")).toBe(true);
    });
});

describe("createProfileGist / patchProfileGist", () => {
    test("create POSTs /gists and returns ref", async () => {
        const t = GitHubEnvTest({
            responses: { "POST /gists": { id: "g1", owner: { login: "necmttn" } } },
        });
        const ref = await run(createProfileGist(profile).pipe(Effect.provide(t.layer)));
        expect(ref).toEqual({ gistId: "g1", owner: "necmttn" });
        expect(t.calls[0]!.method).toBe("POST");
    });

    test("patch PATCHes /gists/:id", async () => {
        const t = GitHubEnvTest({ responses: { "PATCH /gists/g1": { id: "g1" } } });
        await run(patchProfileGist("g1", profile).pipe(Effect.provide(t.layer)));
        expect(t.calls[0]).toMatchObject({ method: "PATCH", path: "/gists/g1" });
    });
});

describe("ensureRegistration", () => {
    test("skips when registration file already exists upstream", async () => {
        const t = GitHubEnvTest({
            responses: {
                [`GET /repos/${REGISTRY_REPO}/contents/community/users/necmttn.json`]: { sha: "x" },
            },
        });
        const r = await run(
            ensureRegistration({ login: "necmttn", gistId: "g1", joined: "2026-06-12" })
                .pipe(Effect.provide(t.layer)),
        );
        expect(r).toEqual({ status: "already-registered" });
        expect(t.calls).toHaveLength(1);
    });

    test("full flow: fork, branch ref, blob/tree/commit, ref, PR", async () => {
        const login = "necmttn";
        const fork = `${login}/ax`;
        const t = GitHubEnvTest({
            responses: {
                [`GET /repos/${REGISTRY_REPO}/contents/community/users/${login}.json`]: undefined as never, // 404 via missing key
                [`POST /repos/${REGISTRY_REPO}/forks`]: { full_name: fork },
                [`GET /repos/${fork}/git/ref/heads/main`]: { object: { sha: "base" } },
                [`POST /repos/${fork}/git/blobs`]: { sha: "blob1" },
                [`GET /repos/${fork}/git/commits/base`]: { tree: { sha: "tree0" } },
                [`POST /repos/${fork}/git/trees`]: { sha: "tree1" },
                [`POST /repos/${fork}/git/commits`]: { sha: "commit1" },
                [`POST /repos/${fork}/git/refs`]: { ref: "refs/heads/ax-profile-necmttn" },
                [`POST /repos/${REGISTRY_REPO}/pulls`]: { html_url: "https://github.com/Necmttn/ax/pull/999" },
            },
        });
        // remove the undefined key so the GET 404s through the test layer
        const r = await run(
            ensureRegistration({ login, gistId: "g1", joined: "2026-06-12" })
                .pipe(Effect.provide(t.layer)),
        );
        expect(r).toEqual({ status: "pr-opened", prUrl: "https://github.com/Necmttn/ax/pull/999" });
        const paths = t.calls.map((c) => `${c.method} ${c.path}`);
        expect(paths).toContain(`POST /repos/${REGISTRY_REPO}/forks`);
        expect(paths).toContain(`POST /repos/${login}/ax/git/blobs`);
        expect(paths).toContain(`POST /repos/${REGISTRY_REPO}/pulls`);
    });
});
```

(In the full-flow test, do NOT include the GET contents key at all - the test layer 404s missing keys, which is the "not registered" signal.)

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

```ts
// apps/axctl/src/profile/publish.ts
/**
 * Publish operations: gist payload + create/patch, staleness, and the
 * one-time fork -> remote commit -> PR registration into the main repo
 * (community/users/<login>.json). Everything goes through GitHubEnv; no
 * local clone is ever made (git-data API: blob -> tree -> commit -> ref).
 */
import { Effect } from "effect";
import { GitHubEnv, GitHubApiError } from "./github-env.ts";
import type { ProfileV1 } from "./schema.ts";

export const REGISTRY_REPO = "Necmttn/ax";

export interface GistRef {
    readonly gistId: string;
    readonly owner: string;
}

export function profileGistPayload(profile: ProfileV1): {
    readonly description: string;
    readonly public: boolean;
    readonly files: Record<string, { readonly content: string }>;
} {
    return {
        description: `ax profile - ${profile.github}`,
        public: true,
        files: { "ax-profile.json": { content: `${JSON.stringify(profile, null, 2)}\n` } },
    };
}

/** hoursTtl staleness vs an injected `now` (no Date.now in logic). */
export function isStale(publishedAt: string, hoursTtl: number, now: string): boolean {
    const pub = Date.parse(publishedAt);
    const ref = Date.parse(now);
    if (!Number.isFinite(pub) || !Number.isFinite(ref)) return true;
    return ref - pub > hoursTtl * 3_600_000;
}

const asRecord = (u: unknown): Record<string, unknown> =>
    typeof u === "object" && u !== null ? (u as Record<string, unknown>) : {};

export const createProfileGist = Effect.fn("profile.createProfileGist")(
    function* (profile: ProfileV1) {
        const gh = yield* GitHubEnv;
        const out = asRecord(yield* gh.api("POST", "/gists", profileGistPayload(profile)));
        const owner = asRecord(out.owner);
        return {
            gistId: String(out.id ?? ""),
            owner: typeof owner.login === "string" ? owner.login : "",
        } satisfies GistRef;
    },
);

export const patchProfileGist = Effect.fn("profile.patchProfileGist")(
    function* (gistId: string, profile: ProfileV1) {
        const gh = yield* GitHubEnv;
        yield* gh.api("PATCH", `/gists/${gistId}`, profileGistPayload(profile));
    },
);

export const deleteProfileGist = Effect.fn("profile.deleteProfileGist")(
    function* (gistId: string) {
        const gh = yield* GitHubEnv;
        yield* gh.api("DELETE", `/gists/${gistId}`);
    },
);

export type RegistrationResult =
    | { readonly status: "already-registered" }
    | { readonly status: "pr-opened"; readonly prUrl: string };

/**
 * One-time registration: community/users/<login>.json via the user's fork.
 * Idempotent: skips when the file already exists upstream. The branch is
 * deterministic (ax-profile-<login>) so re-runs collide loudly instead of
 * spamming PRs.
 */
export const ensureRegistration = Effect.fn("profile.ensureRegistration")(
    function* (input: { readonly login: string; readonly gistId: string; readonly joined: string }) {
        const gh = yield* GitHubEnv;
        const { login, gistId, joined } = input;
        const filePath = `community/users/${login}.json`;

        const exists = yield* gh.api("GET", `/repos/${REGISTRY_REPO}/contents/${filePath}`).pipe(
            Effect.map(() => true),
            Effect.catchTag("GitHubApiError", (e) =>
                e.status === 404 ? Effect.succeed(false) : Effect.fail(e),
            ),
        );
        if (exists) return { status: "already-registered" } as const;

        const fork = asRecord(yield* gh.api("POST", `/repos/${REGISTRY_REPO}/forks`, {}));
        const forkFullName = typeof fork.full_name === "string" ? fork.full_name : `${login}/ax`;

        const baseRef = asRecord(yield* gh.api("GET", `/repos/${forkFullName}/git/ref/heads/main`));
        const baseSha = String(asRecord(baseRef.object).sha ?? "");

        const content = `${JSON.stringify({ github: login, gist_id: gistId, joined }, null, 2)}\n`;
        const blob = asRecord(
            yield* gh.api("POST", `/repos/${forkFullName}/git/blobs`, {
                content,
                encoding: "utf-8",
            }),
        );

        const baseCommit = asRecord(yield* gh.api("GET", `/repos/${forkFullName}/git/commits/${baseSha}`));
        const baseTreeSha = String(asRecord(baseCommit.tree).sha ?? "");

        const tree = asRecord(
            yield* gh.api("POST", `/repos/${forkFullName}/git/trees`, {
                base_tree: baseTreeSha,
                tree: [{ path: filePath, mode: "100644", type: "blob", sha: blob.sha }],
            }),
        );

        const commit = asRecord(
            yield* gh.api("POST", `/repos/${forkFullName}/git/commits`, {
                message: `community: register ax profile for @${login}`,
                tree: tree.sha,
                parents: [baseSha],
            }),
        );

        const branch = `ax-profile-${login}`;
        yield* gh.api("POST", `/repos/${forkFullName}/git/refs`, {
            ref: `refs/heads/${branch}`,
            sha: commit.sha,
        });

        const pr = asRecord(
            yield* gh.api("POST", `/repos/${REGISTRY_REPO}/pulls`, {
                title: `community: register ax profile for @${login}`,
                head: `${login}:${branch}`,
                base: "main",
                body: `One-time ax profile registration. Gist: https://gist.github.com/${login}/${gistId}\n\nOpened by \`ax profile publish\`.`,
            }),
        );

        return { status: "pr-opened", prUrl: String(pr.html_url ?? "") } as const;
    },
);
```

- [ ] **Step 4: Run, verify PASS (7 tests)**

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/profile/publish.ts apps/axctl/src/profile/publish.test.ts
git commit -m "feat(profile): gist publish ops + fork registration via git-data API"
```

---

### Task 4: `ax profile publish` / `unpublish` subcommands

**Files:**
- Modify: `apps/axctl/src/cli/commands/profile.ts` (add subcommands next to `show`)
- Reference: existing `show` handler in the same file (gatherEnv reuse), `install.ts:1041` (prompt pattern)

- [ ] **Step 1: Add the publish/unpublish handlers**

Append to `apps/axctl/src/cli/commands/profile.ts` (reusing `gatherEnv` and existing imports; add new imports for publish ops, state, GitHubEnvLive):

```ts
import { GitHubEnvLive } from "../../profile/github-env.ts";
import {
    createProfileGist,
    deleteProfileGist,
    ensureRegistration,
    isStale,
    patchProfileGist,
} from "../../profile/publish.ts";
import {
    defaultPublishStatePath,
    loadPublishState,
    savePublishState,
} from "../../profile/publish-state.ts";

const cmdProfilePublish = (input: {
    readonly window: number;
    readonly noCost: boolean;
    readonly ifStaleHours: number | null;
    readonly yes: boolean;
    readonly skipRegistration: boolean;
}) =>
    Effect.gen(function* () {
        const statePath = defaultPublishStatePath();
        const state = yield* Effect.promise(() => loadPublishState(statePath));
        const nowIso = new Date().toISOString();

        if (input.ifStaleHours !== null) {
            if (state === null) {
                // --if-stale is the watcher path: never prompt, never first-publish.
                return;
            }
            if (!isStale(state.published_at, input.ifStaleHours, nowIso)) return;
        }

        const env = yield* gatherEnv;
        const noCost = input.noCost || (state?.no_cost ?? false);
        const profile = yield* buildProfile({
            windowDays: input.window,
            includeCost: !noCost,
            env,
        });

        if (state === null) {
            // First publish: consent gate. Show EXACTLY what leaves the machine
            // (incl. taste summaries - see profile/taste.ts PUBLISH GATE).
            console.log(prettyPrint(profile));
            console.log("\nThis exact JSON will be published as a PUBLIC gist under your GitHub account.");
            if (!input.yes) {
                const ans = (globalThis.prompt?.("Publish? [y/N]") ?? "").trim().toLowerCase();
                if (ans !== "y" && ans !== "yes") {
                    console.log("Aborted. Nothing was published.");
                    return;
                }
            }
            const ref = yield* createProfileGist(profile);
            yield* Effect.promise(() =>
                savePublishState(statePath, {
                    v: 1,
                    gist_id: ref.gistId,
                    owner: ref.owner,
                    consented_at: nowIso,
                    published_at: nowIso,
                    no_cost: noCost,
                }),
            );
            console.log(`\npublished: https://gist.github.com/${ref.owner}/${ref.gistId}`);

            if (!input.skipRegistration) {
                const result = yield* ensureRegistration({
                    login: ref.owner,
                    gistId: ref.gistId,
                    joined: nowIso.slice(0, 10),
                });
                console.log(
                    result.status === "pr-opened"
                        ? `registration PR: ${result.prUrl}`
                        : "already registered in the community directory.",
                );
            }
            return;
        }

        yield* patchProfileGist(state.gist_id, profile);
        yield* Effect.promise(() =>
            savePublishState(statePath, { ...state, published_at: nowIso, no_cost: noCost }),
        );
        console.log(`updated: https://gist.github.com/${state.owner}/${state.gist_id}`);
    }).pipe(Effect.provide(GitHubEnvLive));

const cmdProfileUnpublish = () =>
    Effect.gen(function* () {
        const statePath = defaultPublishStatePath();
        const state = yield* Effect.promise(() => loadPublishState(statePath));
        if (state === null) {
            console.log("not published (no local publish state).");
            return;
        }
        yield* deleteProfileGist(state.gist_id);
        yield* Effect.promise(async () => {
            await Bun.$`rm -f ${statePath}`.quiet().nothrow();
        });
        console.log(`deleted gist ${state.gist_id} and local publish state.`);
        console.log(
            `If you registered, open a removal PR for community/users/${state.owner}.json in ${"Necmttn/ax"}.`,
        );
    }).pipe(Effect.provide(GitHubEnvLive));
```

Subcommand definitions + wiring into the existing `profileCommand` group:

```ts
const profilePublishCommand = Command.make(
    "publish",
    {
        window: Flag.integer("window").pipe(Flag.withDefault(30)),
        noCost: Flag.boolean("no-cost").pipe(Flag.withDefault(false)),
        ifStale: Flag.integer("if-stale").pipe(Flag.optional), // hours
        yes: Flag.boolean("yes").pipe(Flag.withDefault(false)),
        skipRegistration: Flag.boolean("skip-registration").pipe(Flag.withDefault(false)),
    },
    ({ window, noCost, ifStale, yes, skipRegistration }) => {
        if (!Number.isInteger(window) || window <= 0) {
            fail(`ax profile publish: --window must be a positive integer (got "${window}")`);
        }
        const ifStaleHours = optionValue(ifStale) ?? null;
        if (ifStaleHours !== null && (!Number.isInteger(ifStaleHours) || ifStaleHours <= 0)) {
            fail(`ax profile publish: --if-stale must be positive hours (got "${ifStaleHours}")`);
        }
        return cmdProfilePublish({ window, noCost, ifStaleHours, yes, skipRegistration });
    },
).pipe(
    Command.withDescription(
        "Publish your profile to a public gist (create once, update in place); " +
        "first run asks for consent and opens the community registration PR. " +
        "--window=N  --no-cost  --if-stale=<hours>  --yes  --skip-registration",
    ),
);

const profileUnpublishCommand = Command.make("unpublish", {}, () => cmdProfileUnpublish()).pipe(
    Command.withDescription("Delete the published profile gist and local publish state."),
);
```

Update the group:

```ts
export const profileCommand = Command.make("profile").pipe(
    Command.withDescription(
        "Your ax profile: stats, rig, and taste rendered from the local graph",
    ),
    Command.withSubcommands([profileShowCommand, profilePublishCommand, profileUnpublishCommand]),
);
```

(`optionValue` is already exported from `./shared.ts` - see ax-cost.ts:21 import.)

- [ ] **Step 2: Gate tests**

```bash
/tmp/run-ax-tests.sh apps/axctl/src/cli/effect-cli.test.ts apps/axctl/src/profile/
bun run typecheck
```
Expected: all pass (no new RUNTIME entries needed - `profile` family already registered).

- [ ] **Step 3: Live smoke (careful - real GitHub)**

```bash
bun apps/axctl/src/cli/index.ts profile publish --if-stale=2   # no state -> silent no-op, exit 0
bun apps/axctl/src/cli/index.ts profile unpublish              # "not published" message
```
Do NOT run a real first publish in CI/implementation - that creates a real gist + PR. The consent prompt path is verified by the y/N abort: run `echo n | bun apps/axctl/src/cli/index.ts profile publish` and expect "Aborted".

- [ ] **Step 4: Commit**

```bash
git add apps/axctl/src/cli/commands/profile.ts
git commit -m "feat(cli): ax profile publish/unpublish - consent-gated gist + registration PR"
```

---

### Task 5: Watcher freshness step

**Files:**
- Modify: `scripts/com.necmttn.ax-watch.plist`

- [ ] **Step 1: Append the publish step to the watcher command**

In the `ProgramArguments` command string, change:

```
cd __AX_DIR__ && bun src/cli/index.ts ingest --since=1 >>__LOG_DIR__/watcher.log 2>&1
```

to:

```
cd __AX_DIR__ && bun src/cli/index.ts ingest --since=1 >>__LOG_DIR__/watcher.log 2>&1; bun src/cli/index.ts profile publish --if-stale=2 >>__LOG_DIR__/watcher.log 2>&1 || true
```

(`;` not `&&` - a failed ingest must not block the freshness check; `|| true` keeps launchd happy. The publish step is a silent no-op until the user has consented once - no state file, no publish, no prompt.)

- [ ] **Step 2: Verify the plist is still valid XML**

```bash
plutil -lint scripts/com.necmttn.ax-watch.plist
```
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add scripts/com.necmttn.ax-watch.plist
git commit -m "feat(watcher): keep published profile fresh (publish --if-stale=2)"
```

---

### Task 6: Docs (CI gate)

**Files:**
- Modify: `docs/cli.md` (the `axctl profile` line), `CLAUDE.md` (Profile section)

- [ ] **Step 1: docs/cli.md** - replace the profile line with:

```
axctl profile show [--window=N] [--no-cost]  # local profile: stats + rig + taste from the graph
axctl profile publish [--if-stale=H] [--yes] # publish profile gist + one-time community registration PR
axctl profile unpublish                      # delete the published gist + local consent
```

- [ ] **Step 2: CLAUDE.md Profile section** - extend to:

```markdown
### Profile

`ax profile show [--window=N] [--no-cost] [--json]` - render your local ax
profile (ProfileV1: stats + rig + taste patterns) from the graph.
`ax profile publish [--window=N] [--no-cost] [--if-stale=H] [--yes] [--skip-registration]` -
publish to a public gist (create once, PATCH in place). First run: consent
prompt showing the exact JSON, then fork + community/users/<login>.json
registration PR into Necmttn/ax (git-data API, no local clone). Watcher runs
`--if-stale=2` after ingest - silent no-op until first consent.
`ax profile unpublish` - delete gist + local state.
State: `~/.ax/profile-publish.json`. Spec:
docs/superpowers/specs/2026-06-12-ax-profiles-design.md.
```

- [ ] **Step 3: Verify gate + commit**

```bash
bun run check:cli-reference
git add docs/cli.md CLAUDE.md
git commit -m "docs: ax profile publish/unpublish reference"
```

---

## Self-review

1. **Spec coverage (Plan-2 slice):** gist create/PATCH-in-place §1+§2 → Tasks 3-4; consent + exact-JSON preview §6 → Task 4; taste publish gate → consent preview shows full JSON (per-pattern confirm deferred, documented); fork + registration PR via git-data API §2 → Task 3; `--if-stale` debounce + watcher §5 → Tasks 4-5; unpublish §2 → Task 4 (gist delete + state removal; registration-removal PR is printed guidance, not automated - v1 simplification, spec's "open PR removing registration" deferred to Plan 3 where the community dir actually exists).
2. **Placeholder scan:** one explicit resolve-at-implementation note (atomic rename without node:fs) with concrete fallback given.
3. **Type consistency:** `GistRef` defined in publish.ts (not reusing share/gist.ts's different shape); `PublishState` fields match between state file and command; `GitHubEnvTest` return `{layer, calls}` used consistently in both test files.

Note: `ensureRegistration` targets `community/users/` which doesn't exist in the repo until Plan 3 - the PR it opens will be valid anyway (PRs can add new directories). Plan 3's CI/auto-merge lands before any real user PRs are expected.
