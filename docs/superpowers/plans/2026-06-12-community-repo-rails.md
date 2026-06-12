# Community Repo Rails (Plan 3 of 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The `Necmttn/ax` repo accepts profile registrations safely (schema-validated, identity-checked, auto-merged) and compiles all registered gists nightly into leaderboard / skill-stats / hook-stats / state-distribution JSON the site (Plan 4) reads.

**Architecture:** Two bun scripts (testable, no Action-only logic) + two thin workflows. `scripts/validate-community-users.ts` enforces the registration contract on PRs; `community-users.yml` runs it, verifies PR author == filename == json.github and that nothing else is touched, then auto-merges. `scripts/compile-community.ts` walks `community/users/*.json`, fetches each gist's `ax-profile.json` (injectable fetcher; ETag cache), validates rows through the canonical `ProfileV1` decoder (single source of truth from Plan 1), drops absurd values, and emits deterministic compiled JSON; `community-nightly.yml` runs it on cron and commits only on change.

**Tech Stack:** bun scripts, GitHub Actions (mirror `.github/workflows/ci.yml` conventions: ubuntu-24.04, `oven-sh/setup-bun@v2` bun 1.3.10, `bun install --frozen-lockfile`), bun:test.

**Conventions that bite:**
- Scripts live in `scripts/`, run via `bun scripts/<name>.ts`, and exit non-zero with printed reasons (see `scripts/check-cli-reference.ts` for tone). Note: `scripts/` is NOT under the `check:no-node-fs` source gate the same way app code is - but verify with `bun run check:no-node-fs` after writing; if scripts are gated, use Bun APIs.
- `bun test` may be hook-blocked locally → `/tmp/run-ax-tests.sh` wrapper.
- Workflows: least-privilege `permissions:` per job; auto-merge needs `contents: write` + `pull-requests: write`.
- Importing app code from scripts works by relative path (bun monorepo, no build step): `import { decodeProfile } from "../apps/axctl/src/profile/schema.ts"`.
- Determinism: compiled JSON must be byte-stable for identical inputs (sorted keys/rows) or the nightly commit-on-change will churn.

**File structure:**

```
community/
├── README.md                          # what this dir is, registration contract
└── users/                             # one <login>.json per registered user (starts empty)
scripts/
├── validate-community-users.ts        # PR gate: schema + identity + filename
├── validate-community-users.test.ts
├── compile-community.ts               # nightly: gists -> leaderboard/skill-stats/hook-stats/state
└── compile-community.test.ts
.github/workflows/
├── community-users.yml                # validate + auto-merge registrations
└── community-nightly.yml              # cron compile + commit-on-change
```

---

### Task 1: Registration validator script

**Files:**
- Create: `scripts/validate-community-users.ts`
- Test: `scripts/validate-community-users.test.ts`

Contract (spec §3a): each `community/users/<login>.json` is exactly `{ github, gist_id, joined }`; `github` matches filename (case-insensitive login, file lowercase); `joined` is `YYYY-MM-DD`; unknown fields rejected. The script takes file paths as argv (the workflow passes changed files) plus `--author=<login>` and exits 1 on any violation.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/validate-community-users.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { validateUserFile } from "./validate-community-users.ts";

const dir = `/tmp/ax-community-validate-${process.pid}`;

afterEach(async () => {
    await Bun.$`rm -rf ${dir}`.quiet().nothrow();
});

const write = async (name: string, content: unknown): Promise<string> => {
    const path = `${dir}/community/users/${name}`;
    await Bun.write(path, typeof content === "string" ? content : JSON.stringify(content));
    return path;
};

describe("validateUserFile", () => {
    test("accepts a valid registration matching the author", async () => {
        const p = await write("necmttn.json", { github: "necmttn", gist_id: "abc123", joined: "2026-06-12" });
        expect(await validateUserFile(p, "necmttn")).toEqual([]);
    });

    test("author mismatch rejected", async () => {
        const p = await write("necmttn.json", { github: "necmttn", gist_id: "abc", joined: "2026-06-12" });
        const errs = await validateUserFile(p, "someone-else");
        expect(errs.some((e) => e.includes("author"))).toBe(true);
    });

    test("filename / github mismatch rejected", async () => {
        const p = await write("other.json", { github: "necmttn", gist_id: "abc", joined: "2026-06-12" });
        const errs = await validateUserFile(p, "necmttn");
        expect(errs.some((e) => e.includes("filename"))).toBe(true);
    });

    test("unknown fields rejected", async () => {
        const p = await write("necmttn.json", { github: "necmttn", gist_id: "abc", joined: "2026-06-12", admin: true });
        const errs = await validateUserFile(p, "necmttn");
        expect(errs.some((e) => e.includes("unknown field"))).toBe(true);
    });

    test("bad joined date rejected", async () => {
        const p = await write("necmttn.json", { github: "necmttn", gist_id: "abc", joined: "yesterday" });
        const errs = await validateUserFile(p, "necmttn");
        expect(errs.some((e) => e.includes("joined"))).toBe(true);
    });

    test("malformed json rejected without throwing", async () => {
        const p = await write("necmttn.json", "{nope");
        const errs = await validateUserFile(p, "necmttn");
        expect(errs.length).toBeGreaterThan(0);
    });

    test("uppercase login normalizes: file lowercase, github field case-insensitive", async () => {
        const p = await write("necmttn.json", { github: "Necmttn", gist_id: "abc", joined: "2026-06-12" });
        expect(await validateUserFile(p, "Necmttn")).toEqual([]);
    });
});
```

- [ ] **Step 2: Run (`/tmp/run-ax-tests.sh scripts/validate-community-users.test.ts`), verify FAIL**

- [ ] **Step 3: Implement**

```ts
// scripts/validate-community-users.ts
/**
 * PR gate for community/users/<login>.json registrations (profiles spec
 * §3a). Strict by construction: exactly {github, gist_id, joined}, filename
 * == github == PR author (case-insensitive; filename lowercase), joined is
 * YYYY-MM-DD. Used by .github/workflows/community-users.yml; also runnable
 * locally: bun scripts/validate-community-users.ts --author=me community/users/me.json
 */

const ALLOWED_KEYS = new Set(["github", "gist_id", "joined"]);

export async function validateUserFile(path: string, author: string): Promise<string[]> {
    const errors: string[] = [];
    const fileName = path.split("/").pop() ?? "";
    const stem = fileName.replace(/\.json$/, "");

    let raw: unknown;
    try {
        raw = JSON.parse(await Bun.file(path).text());
    } catch (e) {
        return [`${fileName}: not valid JSON (${e instanceof Error ? e.message : String(e)})`];
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return [`${fileName}: must be a JSON object`];
    }
    const r = raw as Record<string, unknown>;

    for (const key of Object.keys(r)) {
        if (!ALLOWED_KEYS.has(key)) errors.push(`${fileName}: unknown field "${key}"`);
    }
    const github = typeof r.github === "string" ? r.github : "";
    if (github === "") errors.push(`${fileName}: "github" must be a non-empty string`);
    if (typeof r.gist_id !== "string" || r.gist_id === "" || !/^[a-f0-9]+$/i.test(r.gist_id)) {
        errors.push(`${fileName}: "gist_id" must be a hex gist id`);
    }
    if (typeof r.joined !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.joined)) {
        errors.push(`${fileName}: "joined" must be YYYY-MM-DD`);
    }
    if (github !== "" && stem !== github.toLowerCase()) {
        errors.push(`${fileName}: filename must be the lowercase github login ("${github.toLowerCase()}.json")`);
    }
    if (github !== "" && github.toLowerCase() !== author.toLowerCase()) {
        errors.push(`${fileName}: "github" (${github}) must match the PR author (${author})`);
    }
    return errors;
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    const authorArg = args.find((a) => a.startsWith("--author="));
    const files = args.filter((a) => !a.startsWith("--"));
    if (!authorArg || files.length === 0) {
        console.error("usage: bun scripts/validate-community-users.ts --author=<login> <file>...");
        process.exit(2);
    }
    const author = authorArg.slice("--author=".length);
    let failed = false;
    for (const file of files) {
        const errors = await validateUserFile(file, author);
        for (const e of errors) {
            console.error(e);
            failed = true;
        }
    }
    if (failed) process.exit(1);
    console.log(`${files.length} registration file(s) valid for @${author}.`);
}
```

- [ ] **Step 4: Run, verify PASS (7 tests)**

- [ ] **Step 5: Commit**

```bash
git add scripts/validate-community-users.ts scripts/validate-community-users.test.ts
git commit -m "feat(community): registration validator for community/users PRs"
```

---

### Task 2: Community directory scaffolding

**Files:**
- Create: `community/README.md`, `community/users/.gitkeep`

- [ ] **Step 1: Write community/README.md**

```markdown
# ax community

Profiles, leaderboards, and (soon) shared patterns/skills/hooks for ax users.
Spec: docs/superpowers/specs/2026-06-12-ax-profiles-design.md

## users/

One file per registered user: `users/<login>.json`

```json
{ "github": "<login>", "gist_id": "<hex>", "joined": "YYYY-MM-DD" }
```

Registration is opened automatically by `ax profile publish` (fork + PR).
PRs touching only your own `users/<login>.json` are schema-checked and
auto-merged by CI; the profile data itself lives in your gist and updates
without further PRs.

## Compiled outputs (nightly)

`leaderboard.json`, `skill-stats.json`, `hook-stats.json`,
`state/<year>.json` are generated by `scripts/compile-community.ts` - do not
edit by hand.
```

- [ ] **Step 2: Commit**

```bash
git add community/README.md community/users/.gitkeep
git commit -m "feat(community): directory scaffolding + registration contract"
```

---

### Task 3: Compile script (gists → boards/stats/state)

**Files:**
- Create: `scripts/compile-community.ts`
- Test: `scripts/compile-community.test.ts`

Injectable fetcher so tests run without network. Validation through `decodeProfile` (Plan 1). Absurd-row guard: `tokens.total > 100e9` or `sessions > 50_000` over the profile window → excluded (logged). Output is deterministic (rows sorted by value desc then login asc; stable key order via explicit object building).

- [ ] **Step 1: Write the failing test**

```ts
// scripts/compile-community.test.ts
import { describe, expect, test } from "bun:test";
import { compileCommunity, type GistFetcher } from "./compile-community.ts";

const profile = (login: string, over: Record<string, unknown> = {}) => ({
    v: 1,
    github: login,
    generated_at: "2026-06-12T00:00:00Z",
    window_days: 30,
    stats: {
        sessions: 100, active_days: 20, streak_days: 5,
        tokens: { prompt: 900, completion: 100, total: 1000 },
        cost_usd: 42, models: [], harnesses: ["claude"],
        ...((over.stats as object) ?? {}),
    },
    rig: {
        skills: [{ name: "tdd", source: "superpowers", runs: 10 }],
        hooks: ["enforce-worktree"],
        routing_table: true,
        ...((over.rig as object) ?? {}),
    },
});

const fetcher = (gists: Record<string, unknown>): GistFetcher => async (gistId) =>
    gistId in gists ? { profile: gists[gistId], etag: null } : null;

const users = [
    { github: "alice", gist_id: "g1", joined: "2026-06-01" },
    { github: "bob", gist_id: "g2", joined: "2026-06-02" },
];

describe("compileCommunity", () => {
    test("builds boards sorted by value desc", async () => {
        const out = await compileCommunity(users, fetcher({
            g1: profile("alice", { stats: { tokens: { prompt: 1, completion: 1, total: 2000 } } }),
            g2: profile("bob"),
        }), { now: "2026-06-12T03:00:00Z" });

        expect(out.leaderboard.boards.tokens.map((r) => r.login)).toEqual(["alice", "bob"]);
        expect(out.leaderboard.boards.cost[0]).toEqual({ login: "alice", value: 42 });
        expect(out.leaderboard.compiled_at).toBe("2026-06-12T03:00:00Z");
    });

    test("skill/hook stats aggregate by source+name across users", async () => {
        const out = await compileCommunity(users, fetcher({
            g1: profile("alice"),
            g2: profile("bob"),
        }), { now: "2026-06-12T03:00:00Z" });

        expect(out.skillStats["superpowers:tdd"]).toEqual({ users: 2, runs: 20 });
        expect(out.hookStats["enforce-worktree"]).toEqual({ users: 2 });
    });

    test("invalid profile rows are dropped and reported", async () => {
        const out = await compileCommunity(users, fetcher({
            g1: profile("alice"),
            g2: { v: 99, garbage: true },
        }), { now: "2026-06-12T03:00:00Z" });

        expect(out.leaderboard.boards.tokens).toHaveLength(1);
        expect(out.dropped).toEqual([{ login: "bob", reason: "invalid-profile" }]);
    });

    test("absurd values excluded from boards", async () => {
        const out = await compileCommunity(users, fetcher({
            g1: profile("alice", { stats: { tokens: { prompt: 0, completion: 0, total: 200e9 } } }),
            g2: profile("bob"),
        }), { now: "2026-06-12T03:00:00Z" });

        expect(out.leaderboard.boards.tokens.map((r) => r.login)).toEqual(["bob"]);
        expect(out.dropped).toEqual([{ login: "alice", reason: "absurd-values" }]);
    });

    test("unreachable gist dropped, compile continues", async () => {
        const out = await compileCommunity(users, fetcher({ g1: profile("alice") }), { now: "2026-06-12T03:00:00Z" });
        expect(out.leaderboard.boards.tokens).toHaveLength(1);
        expect(out.dropped).toEqual([{ login: "bob", reason: "fetch-failed" }]);
    });

    test("state distributions: model share + harness mix histograms exist", async () => {
        const out = await compileCommunity(users, fetcher({ g1: profile("alice"), g2: profile("bob") }), {
            now: "2026-06-12T03:00:00Z",
        });
        expect(out.state.year).toBe(2026);
        expect(out.state.users).toBe(2);
        expect(out.state.harness_mix.claude).toBe(2);
        expect(out.state.skill_adoption["superpowers:tdd"]).toBe(2);
    });

    test("output is deterministic for identical input", async () => {
        const f = fetcher({ g1: profile("alice"), g2: profile("bob") });
        const a = await compileCommunity(users, f, { now: "2026-06-12T03:00:00Z" });
        const b = await compileCommunity(users, f, { now: "2026-06-12T03:00:00Z" });
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

```ts
// scripts/compile-community.ts
/**
 * Nightly community compile (profiles spec §3b): walk community/users/,
 * fetch each registered gist's ax-profile.json, validate through the
 * canonical ProfileV1 decoder, drop invalid/absurd rows (reported, never
 * silent), and emit deterministic compiled JSON:
 *   community/leaderboard.json   - boards: tokens, sessions, streak, cost
 *   community/skill-stats.json   - { "<source>:<name>": { users, runs } }
 *   community/hook-stats.json    - { "<hook>": { users } }
 *   community/state/<year>.json  - anonymized distributions
 * Fetcher is injectable for tests; the CLI entry uses fetch() with an ETag
 * cache so unchanged gists cost a 304.
 */
import { decodeProfile, type ProfileV1 } from "../apps/axctl/src/profile/schema.ts";

export interface RegisteredUser {
    readonly github: string;
    readonly gist_id: string;
    readonly joined: string;
}

export type GistFetcher = (
    gistId: string,
) => Promise<{ profile: unknown; etag: string | null } | null>;

export interface BoardRow {
    readonly login: string;
    readonly value: number;
}

export interface CompiledOutput {
    readonly leaderboard: {
        readonly compiled_at: string;
        readonly window_days: number;
        readonly boards: {
            readonly tokens: BoardRow[];
            readonly sessions: BoardRow[];
            readonly streak: BoardRow[];
            readonly cost: BoardRow[];
        };
    };
    readonly skillStats: Record<string, { users: number; runs: number }>;
    readonly hookStats: Record<string, { users: number }>;
    readonly state: {
        readonly year: number;
        readonly users: number;
        readonly harness_mix: Record<string, number>;
        readonly skill_adoption: Record<string, number>;
        readonly model_share: Record<string, number>;
    };
    readonly dropped: Array<{ login: string; reason: "fetch-failed" | "invalid-profile" | "absurd-values" }>;
}

const MAX_TOKENS = 100e9;
const MAX_SESSIONS = 50_000;

const sortBoard = (rows: BoardRow[]): BoardRow[] =>
    [...rows].sort((a, b) => b.value - a.value || a.login.localeCompare(b.login));

const sortedRecord = <V>(entries: Array<[string, V]>): Record<string, V> =>
    Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));

export async function compileCommunity(
    users: ReadonlyArray<RegisteredUser>,
    fetchGist: GistFetcher,
    opts: { readonly now: string },
): Promise<CompiledOutput> {
    const profiles: Array<{ login: string; p: ProfileV1 }> = [];
    const dropped: CompiledOutput["dropped"] = [];

    for (const user of [...users].sort((a, b) => a.github.localeCompare(b.github))) {
        const fetched = await fetchGist(user.gist_id);
        if (fetched === null) {
            dropped.push({ login: user.github, reason: "fetch-failed" });
            continue;
        }
        let p: ProfileV1;
        try {
            p = decodeProfile(fetched.profile);
        } catch {
            dropped.push({ login: user.github, reason: "invalid-profile" });
            continue;
        }
        if (p.stats.tokens.total > MAX_TOKENS || p.stats.sessions > MAX_SESSIONS) {
            dropped.push({ login: user.github, reason: "absurd-values" });
            continue;
        }
        profiles.push({ login: user.github, p });
    }

    const board = (value: (p: ProfileV1) => number | undefined): BoardRow[] =>
        sortBoard(
            profiles.flatMap(({ login, p }) => {
                const v = value(p);
                return v === undefined ? [] : [{ login, value: v }];
            }),
        );

    const skillAgg = new Map<string, { users: number; runs: number }>();
    const hookAgg = new Map<string, { users: number }>();
    const harnessMix = new Map<string, number>();
    const modelUsers = new Map<string, number>();
    for (const { p } of profiles) {
        for (const s of p.rig.skills) {
            const key = `${s.source}:${s.name}`;
            const cur = skillAgg.get(key) ?? { users: 0, runs: 0 };
            skillAgg.set(key, { users: cur.users + 1, runs: cur.runs + s.runs });
        }
        for (const h of p.rig.hooks) {
            const cur = hookAgg.get(h) ?? { users: 0 };
            hookAgg.set(h, { users: cur.users + 1 });
        }
        for (const h of p.stats.harnesses) {
            harnessMix.set(h, (harnessMix.get(h) ?? 0) + 1);
        }
        for (const m of p.stats.models) {
            modelUsers.set(m.name, (modelUsers.get(m.name) ?? 0) + 1);
        }
    }

    return {
        leaderboard: {
            compiled_at: opts.now,
            window_days: 30,
            boards: {
                tokens: board((p) => p.stats.tokens.total),
                sessions: board((p) => p.stats.sessions),
                streak: board((p) => p.stats.streak_days),
                cost: board((p) => p.stats.cost_usd),
            },
        },
        skillStats: sortedRecord([...skillAgg.entries()]),
        hookStats: sortedRecord([...hookAgg.entries()]),
        state: {
            year: Number(opts.now.slice(0, 4)),
            users: profiles.length,
            harness_mix: sortedRecord([...harnessMix.entries()]),
            skill_adoption: sortedRecord([...skillAgg.entries()].map(([k, v]) => [k, v.users])),
            model_share: sortedRecord([...modelUsers.entries()]),
        },
        dropped,
    };
}

// ---------------------------------------------------------------------------
// CLI entry: read users dir, fetch via HTTP with ETag cache, write outputs.
// ---------------------------------------------------------------------------

const liveFetcher = (cache: Record<string, { etag: string; profile: unknown }>): GistFetcher =>
    async (gistId) => {
        try {
            const cached = cache[gistId];
            const res = await fetch(`https://api.github.com/gists/${gistId}`, {
                headers: {
                    accept: "application/vnd.github+json",
                    ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
                    ...(cached ? { "if-none-match": cached.etag } : {}),
                },
            });
            if (res.status === 304 && cached) return { profile: cached.profile, etag: cached.etag };
            if (!res.ok) return null;
            const body = (await res.json()) as {
                files?: Record<string, { content?: string }>;
            };
            const content = body.files?.["ax-profile.json"]?.content;
            if (typeof content !== "string") return null;
            const profile: unknown = JSON.parse(content);
            const etag = res.headers.get("etag");
            if (etag) cache[gistId] = { etag, profile };
            return { profile, etag };
        } catch {
            return null;
        }
    };

if (import.meta.main) {
    const usersDir = "community/users";
    const glob = new Bun.Glob("*.json");
    const users: RegisteredUser[] = [];
    for await (const name of glob.scan({ cwd: usersDir })) {
        const raw: unknown = JSON.parse(await Bun.file(`${usersDir}/${name}`).text());
        const r = raw as Record<string, unknown>;
        users.push({ github: String(r.github), gist_id: String(r.gist_id), joined: String(r.joined) });
    }

    const cachePath = "community/.gist-etag-cache.json";
    let cache: Record<string, { etag: string; profile: unknown }> = {};
    try {
        cache = JSON.parse(await Bun.file(cachePath).text());
    } catch {
        // first run / corrupt cache: full fetch
    }

    const out = await compileCommunity(users, liveFetcher(cache), { now: new Date().toISOString() });

    const year = new Date().getUTCFullYear();
    await Bun.write("community/leaderboard.json", `${JSON.stringify(out.leaderboard, null, 2)}\n`);
    await Bun.write("community/skill-stats.json", `${JSON.stringify(out.skillStats, null, 2)}\n`);
    await Bun.write("community/hook-stats.json", `${JSON.stringify(out.hookStats, null, 2)}\n`);
    await Bun.write(`community/state/${year}.json`, `${JSON.stringify(out.state, null, 2)}\n`);
    await Bun.write(cachePath, `${JSON.stringify(cache, null, 2)}\n`);

    console.log(`compiled ${users.length - out.dropped.length}/${users.length} profiles.`);
    for (const d of out.dropped) console.log(`  dropped ${d.login}: ${d.reason}`);
}
```

NOTE: `compiled_at` makes output non-byte-stable across runs even with identical inputs - the nightly workflow's commit-on-change must therefore diff IGNORING `compiled_at`, or simpler: only update `compiled_at` when something else changed. Resolve in Task 4 with the simple approach: workflow does `git diff --ignore-matching-lines='"compiled_at"' --quiet` - verify the flag exists (it's `-I` in git diff) and works; fallback: write compiled_at into a separate tiny `community/compiled-meta.json` excluded from the diff check.

- [ ] **Step 4: Run, verify PASS (7 tests)**

- [ ] **Step 5: Commit**

```bash
git add scripts/compile-community.ts scripts/compile-community.test.ts
git commit -m "feat(community): nightly gist compile - leaderboard/skill-stats/state"
```

---

### Task 4: Workflows

**Files:**
- Create: `.github/workflows/community-users.yml`, `.github/workflows/community-nightly.yml`

- [ ] **Step 1: community-users.yml**

```yaml
name: community-users

on:
  pull_request_target:
    paths:
      - "community/users/**"

permissions:
  contents: read

jobs:
  validate:
    runs-on: ubuntu-24.04
    permissions:
      contents: write
      pull-requests: write
    steps:
      # pull_request_target runs with base-repo secrets; check out the PR
      # head EXPLICITLY and never execute its code - we only read JSON files
      # and run OUR validator from the base ref.
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.base.sha }}

      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          path: pr-head

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3.10"

      - name: Only community/users files changed
        id: scope
        run: |
          set -euo pipefail
          changed=$(git -C pr-head diff --name-only ${{ github.event.pull_request.base.sha }}...${{ github.event.pull_request.head.sha }})
          echo "$changed"
          if echo "$changed" | grep -v '^community/users/[a-z0-9-]*\.json$' | grep -q .; then
            echo "outside=true" >> "$GITHUB_OUTPUT"
          else
            echo "outside=false" >> "$GITHUB_OUTPUT"
            echo "files<<EOF" >> "$GITHUB_OUTPUT"
            echo "$changed" | sed 's|^|pr-head/|' >> "$GITHUB_OUTPUT"
            echo "EOF" >> "$GITHUB_OUTPUT"
          fi

      - name: Validate registrations
        if: steps.scope.outputs.outside == 'false'
        run: |
          bun install --frozen-lockfile
          bun scripts/validate-community-users.ts \
            --author="${{ github.event.pull_request.user.login }}" \
            ${{ steps.scope.outputs.files }}

      - name: Auto-merge
        if: steps.scope.outputs.outside == 'false'
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: gh pr merge ${{ github.event.pull_request.number }} --squash --auto --repo ${{ github.repository }}

      - name: Comment when human review needed
        if: steps.scope.outputs.outside == 'true'
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          gh pr comment ${{ github.event.pull_request.number }} --repo ${{ github.repository }} \
            --body "This PR touches files outside community/users/, so it needs normal human review (no auto-merge)."
```

SECURITY NOTE (implementer must verify, not skip): `pull_request_target` + checking out PR head is the classic foot-gun. The mitigations here: PR head is checked out into `pr-head/` and ONLY read as data (the validator runs from the base checkout; nothing in `pr-head/` is executed or installed). Keep it that way. Also confirm branch protection on main doesn't block `--auto` squash merges from GITHUB_TOKEN; if it does, document that a repo setting change ("Allow auto-merge") is required - that's a settings change, not a code change.

- [ ] **Step 2: community-nightly.yml**

```yaml
name: community-nightly

on:
  schedule:
    - cron: "17 3 * * *"
  workflow_dispatch:

permissions:
  contents: write

jobs:
  compile:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3.10"

      - run: bun install --frozen-lockfile

      - name: Compile community outputs
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: bun scripts/compile-community.ts

      - name: Commit if changed
        run: |
          set -euo pipefail
          git add community/
          # -I ignores compiled_at-only churn; if everything else is identical, skip.
          if git diff --cached --quiet -I '"compiled_at"'; then
            echo "no changes"
            exit 0
          fi
          git config user.name "ax-community-bot"
          git config user.email "actions@github.com"
          git commit -m "chore(community): nightly compile"
          git push
```

(Verify `git diff -I` behaves with `--cached`; if not, fall back to the compiled-meta split from Task 3's NOTE.)

- [ ] **Step 3: Lint workflows**

```bash
bunx yaml-lint .github/workflows/community-users.yml .github/workflows/community-nightly.yml 2>/dev/null || bun -e 'const y=await import("js-yaml").catch(()=>null); console.log("manual review: ensure valid yaml")'
actionlint 2>/dev/null || echo "actionlint not installed - visual review"
```

(Best-effort: at minimum `bun -e 'JSON.stringify'`-style parse via a yaml lib if present, plus careful visual review.)

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/community-users.yml .github/workflows/community-nightly.yml
git commit -m "ci(community): registration auto-merge + nightly compile workflows"
```

---

### Task 5: Docs

**Files:**
- Modify: `CLAUDE.md` (Profile section gains a community paragraph)

- [ ] **Step 1: Append to the CLAUDE.md Profile section**

```markdown
Community rails: `community/users/<login>.json` registrations are validated
(schema + author==filename) and auto-merged by `community-users.yml`;
`community-nightly.yml` compiles registered gists into
`community/{leaderboard,skill-stats,hook-stats,state/<year>}.json`
(`scripts/compile-community.ts`, ETag-cached, absurd rows dropped). Compiled
files are generated - never hand-edit.
```

- [ ] **Step 2: Gates + commit**

```bash
bun run check:cli-reference   # unchanged commands - must still pass
/tmp/run-ax-tests.sh scripts/
git add CLAUDE.md
git commit -m "docs: community rails in CLAUDE.md"
```

---

## Self-review

1. **Spec coverage (Plan-3 slice):** §3a validation + identity + auto-merge → Tasks 1+4; scope guard (other paths → human review) → Task 4 workflow; §3b nightly compile, ETag, absurd-row drop, all four outputs incl. `state/<year>.json` → Tasks 3+4; `community/` scaffolding + contract docs → Task 2. Pattern/skill/hook contribution dirs (3c) are NOT in this plan - they ship with `ax contribute` later (post-Plan-4), noted in spec.
2. **Placeholder scan:** two explicit verify-at-implementation notes (git diff -I semantics; pull_request_target security + auto-merge repo setting), each with concrete fallback.
3. **Type consistency:** `RegisteredUser`/`GistFetcher`/`CompiledOutput` defined once in compile-community.ts; `decodeProfile`/`ProfileV1` imported from the canonical schema; `runs` field name matches Plan 1's rename (not `runs_30d`).
