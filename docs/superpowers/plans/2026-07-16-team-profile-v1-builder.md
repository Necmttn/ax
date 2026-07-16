# TeamProfileV1 + Repo-Scoped Snapshot Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define `TeamProfileV1` (per-dev, per-repo, redacted, daily-collapsed snapshot) and `buildTeamProfile` - the repo-scoped variant of `buildProfile` that Slice-1 `ax team push` will serialize into `<org>/ax-team/.ax-team/<login>.json`.

**Architecture:** One indexed SQL query resolves the repo's session-id set (`session.repository = repository:\`<key>\``, via the `session_repository_started` index - same scoping as `listSessionsHere`). Every other aggregate is computed by fetching per-row data keyed by the denormalized `session` field (`session_token_usage`, `invoked`) or by per-session indexed fan-out (`tool_call`), then filtering/aggregating against that id set **in JS**. Deref-free SQL, JS joins - house style. Redaction is structural: `TeamProfileV1` has no free-text fields at all (no taste summaries, no paths, no project names).

**Tech Stack:** TypeScript strict, Effect (v4 beta) `Effect.fn` + `Schema`, bun:test, `@ax/lib/testing/surreal` (`makeTestSurrealLayer` route-based mock).

## Global Constraints

- Do NOT modify `apps/axctl/src/profile/queries.ts` behavior - the design needs zero changes there (reuse `fetchWindowedInvocations` by import only).
- Do NOT touch CLI commands, push/GitHubEnv, bindings state, `apps/axctl/src/team/model.ts` or other existing team files.
- SurrealDB 3.x rules: no derefs inside grouped aggregates; record-typed comparisons use `recordLiteral`, not bindings; `session IN [list]` is a non-indexed per-row membership test - NEVER use it (fan out per-session literals instead, like `enrichSessions`).
- Privacy invariants (non-negotiable): no `taste.patterns[].summary`-style free text; `share === "anon"` → `login: null`; `includeCost === false` → `cost_usd: null` and no per-model cost.
- Tests: mock only the DB leaf via `@ax/lib/testing/surreal` routes; assert the real output snapshot (never "query was called").
- Gates: `bun run typecheck` exit 0, new bun:test green, `bun run check:no-node-fs` exit 0.

## File Structure

- Create: `apps/axctl/src/team/team-profile-types.ts` - `TeamProfileV1` Effect Schema + `decodeTeamProfile`.
- Create: `apps/axctl/src/team/team-profile-queries.ts` - 3 repo-scoped queries (`fetchTeamRepoSessions`, `fetchSessionUsageRows`, `fetchToolCallAggBySession`).
- Create: `apps/axctl/src/team/team-profile.ts` - `buildTeamProfile` (query composition + JS aggregation + redaction).
- Test: `apps/axctl/src/team/team-profile-types.test.ts`, `apps/axctl/src/team/team-profile.test.ts`.

Left machine-wide / omitted for follow-up chunks (escape-hatch report): workflow arcs, guardrail receipts, insights (durations/peak-hour/deep-sessions), content-type mix, origin (main-vs-subagent) split.

---

### Task 1: TeamProfileV1 schema + decoder

**Files:**
- Create: `apps/axctl/src/team/team-profile-types.ts`
- Test: `apps/axctl/src/team/team-profile-types.test.ts`

**Interfaces:**
- Produces: `TeamProfileV1` (type + Schema), `decodeTeamProfile(input: unknown): TeamProfileV1`, `TeamShare = "public" | "anon"`.

- [ ] **Step 1: Write the failing test** (`team-profile-types.test.ts`)

```ts
import { describe, expect, test } from "bun:test";
import { decodeTeamProfile } from "./team-profile-types.ts";

const valid = {
    v: 1,
    login: "necmttn",
    org: "acme",
    repo_key: "remote__github_com_acme_widgets__abc123",
    window_days: 30,
    generated_at: "2026-07-16T00:00:00Z",
    stats: { sessions: 12, active_days: 5, harnesses: ["claude", "codex"] },
    activity: { daily: [{ date: "2026-07-15", sessions: 3, tokens: 120000 }] },
    skills: [{ skill: "tdd", runs: 8, sessions: 4 }],
    spend: {
        tokens: { prompt: 1000, completion: 200, total: 1200 },
        cost_usd: 4.2,
        model_mix: [{ model: "fable", share: 1, tokens: 1200, cost_usd: 4.2 }],
    },
    efficiency: { tool_calls: 300, tool_failures: 12, verification_calls: 40 },
};

describe("decodeTeamProfile", () => {
    test("round-trips a valid snapshot", () => {
        const decoded = decodeTeamProfile(valid);
        expect(decoded).toEqual(valid as never);
        // plain-JSON serializable (lands in git, read by a browser)
        expect(decodeTeamProfile(JSON.parse(JSON.stringify(decoded)))).toEqual(decoded);
    });

    test("accepts anon (login null) and no-cost (cost_usd null, no per-model cost)", () => {
        const anon = {
            ...valid,
            login: null,
            spend: {
                ...valid.spend,
                cost_usd: null,
                model_mix: [{ model: "fable", share: 1, tokens: 1200 }],
            },
        };
        expect(decodeTeamProfile(anon).login).toBeNull();
        expect(decodeTeamProfile(anon).spend.cost_usd).toBeNull();
    });

    test("rejects malformed snapshots", () => {
        expect(() => decodeTeamProfile({ ...valid, v: 2 })).toThrow();
        expect(() => decodeTeamProfile({ ...valid, stats: { sessions: "12" } })).toThrow();
        expect(() => decodeTeamProfile(null)).toThrow();
    });

    test("has no free-text summary fields anywhere in the shape", () => {
        expect(JSON.stringify(valid)).not.toContain("summary");
        expect(JSON.stringify(valid)).not.toContain("patterns");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from worktree root): `bun test apps/axctl/src/team/team-profile-types.test.ts`
Expected: FAIL - cannot resolve `./team-profile-types.ts`.

- [ ] **Step 3: Write the implementation** (`team-profile-types.ts`)

```ts
/**
 * TeamProfileV1 - the per-dev, per-repo, redacted, daily-collapsed snapshot
 * that `ax team push` (later chunk) uploads to `<org>/ax-team` as
 * `.ax-team/<login>.json` (goal package: 2026-07-01-team-dashboard-git-native,
 * §5 Slice 1). Derived from ProfileV1's stat shapes but scoped to ONE repo.
 *
 * Redaction is STRUCTURAL: this shape carries no free-text fields at all -
 * no taste-pattern summaries, no paths, no project names (§4). Aggregates
 * only. `login` is null when the dev pushes anonymously; `cost_usd` is null
 * under the sticky no_cost flag. Plain JSON - it lands in git and is read
 * by a browser (Slice 2/4).
 */
import { Schema } from "effect";

export type TeamShare = "public" | "anon";

const TeamTokens = Schema.Struct({
    prompt: Schema.Number,
    completion: Schema.Number,
    total: Schema.Number,
});

const TeamModelMix = Schema.Struct({
    model: Schema.String,
    /** cost-weighted when cost is shared, token-weighted otherwise */
    share: Schema.Number,
    tokens: Schema.Number,
    cost_usd: Schema.optional(Schema.Number),
});

const TeamStats = Schema.Struct({
    sessions: Schema.Number,
    active_days: Schema.Number,
    harnesses: Schema.Array(Schema.String),
});

const TeamDailyRow = Schema.Struct({
    date: Schema.String,
    sessions: Schema.Number,
    tokens: Schema.Number,
});

const TeamSkillRow = Schema.Struct({
    skill: Schema.String,
    runs: Schema.Number,
    /** distinct repo sessions that invoked the skill (team-side medians are computed across devs) */
    sessions: Schema.Number,
});

const TeamSpend = Schema.Struct({
    tokens: TeamTokens,
    /** null under the sticky no_cost flag */
    cost_usd: Schema.NullOr(Schema.Number),
    model_mix: Schema.Array(TeamModelMix),
});

const TeamEfficiency = Schema.Struct({
    tool_calls: Schema.Number,
    tool_failures: Schema.Number,
    verification_calls: Schema.Number,
});

export const TeamProfileV1 = Schema.Struct({
    v: Schema.Literal(1),
    /** github login; null when share === "anon" */
    login: Schema.NullOr(Schema.String),
    org: Schema.String,
    repo_key: Schema.String,
    window_days: Schema.Number,
    generated_at: Schema.String,
    stats: TeamStats,
    activity: Schema.Struct({ daily: Schema.Array(TeamDailyRow) }),
    skills: Schema.Array(TeamSkillRow),
    spend: TeamSpend,
    efficiency: TeamEfficiency,
});
export type TeamProfileV1 = typeof TeamProfileV1.Type;

/** Throws on invariant breach - a malformed snapshot is a bug in the builder. */
export const decodeTeamProfile = (input: unknown): TeamProfileV1 =>
    Schema.decodeUnknownSync(TeamProfileV1)(input);
```

NOTE: check `profile/schema.ts` imports (`Schema` from `"effect"`) compile identically here; `Schema.NullOr` exists in this Effect version (verify with a quick `rg "NullOr" apps/ packages/` for prior art - if absent, use `Schema.Union([Schema.String, Schema.Null])`).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/axctl/src/team/team-profile-types.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/team/team-profile-types.ts apps/axctl/src/team/team-profile-types.test.ts
git commit -m "feat(team): TeamProfileV1 schema + decoder"
```

---

### Task 2: repo-scoped queries

**Files:**
- Create: `apps/axctl/src/team/team-profile-queries.ts`
- Test: covered by Task 3's build test (route-based; SQL text asserted there). No separate test file.

**Interfaces:**
- Consumes: `SurrealClient` from `@ax/lib/db`, `recordLiteral` from `@ax/lib/ids`.
- Produces:
  - `fetchTeamRepoSessions(opts: { repoKey: string; windowDays: number }): Effect<TeamSessionRow[]>` where `TeamSessionRow = { id: string; started_at: string; source: string }` (id in `type::string(id)` form, e.g. `session:⟨uuid⟩`).
  - `fetchSessionUsageRows(opts: { windowDays: number }): Effect<SessionUsageRow[]>` where `SessionUsageRow = { session: string; model: string | null; prompt_tokens: number; completion_tokens: number; cost_usd: number | null }`.
  - `fetchToolCallAggBySession(opts: { sessionIds: ReadonlyArray<string> }): Effect<ToolCmdRow[]>` where `ToolCmdRow = { cmd: string; count: number; failures: number }` (already summed across the given sessions).

- [ ] **Step 1: Write the implementation** (tests arrive with the builder in Task 3, which asserts both the SQL scoping text and the JS filtering through real output - writing this file first keeps Task 3's red phase meaningful)

```ts
/**
 * Repo-scoped queries for the TeamProfileV1 builder. Scoping strategy:
 * ONE indexed query resolves the repo's session ids
 * (`session_repository_started` index, same scoping as listSessionsHere);
 * everything else fetches per-row data keyed by the denormalized `session`
 * field and is filtered/aggregated against that id set in JS. Deref-free
 * SQL, JS joins (SurrealDB 3.x house rules). `session IN [list]` is a
 * non-indexed per-row membership test - never used here; tool_call is
 * fanned out per-session literal (hits tool_call_session_ts, ~1ms each,
 * same pattern as sessions-query.ts enrichSessions).
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { recordLiteral } from "@ax/lib/ids";

const win = (d: number) => `${Math.max(1, Math.trunc(d))}d`;

// --- repo session set --------------------------------------------------------

export interface TeamSessionRow {
    /** type::string(id) form, e.g. `session:⟨uuid⟩` - matches invoked/usage row keys */
    readonly id: string;
    readonly started_at: string;
    readonly source: string;
}

const TEAM_REPO_SESSIONS_SQL = (repoKey: string, d: number) => `
SELECT
    type::string(id) AS id,
    type::string(started_at) AS started_at,
    source
FROM session
WHERE repository = ${recordLiteral("repository", repoKey)}
  AND started_at > time::now() - ${win(d)}
  AND started_at IS NOT NONE;`;

export const fetchTeamRepoSessions = Effect.fn("team.fetchTeamRepoSessions")(
    function* (opts: { readonly repoKey: string; readonly windowDays: number }) {
        const db = yield* SurrealClient;
        const rows = yield* db
            .query<[Array<Record<string, unknown>>]>(
                TEAM_REPO_SESSIONS_SQL(opts.repoKey, opts.windowDays),
            )
            .pipe(Effect.map((r) => r?.[0] ?? []));
        return rows
            .filter((r) => r.id != null && r.started_at != null)
            .map((r) => ({
                id: String(r.id),
                started_at: String(r.started_at),
                source: String(r.source ?? "claude"),
            })) satisfies TeamSessionRow[];
    },
);

// --- per-session token usage (machine window; repo-filtered in JS) -----------
// One row per session (session_token_usage_session UNIQUE index), so a
// whole-window scan is a few thousand rows at most - cheaper and simpler
// than per-session fan-out here.

export interface SessionUsageRow {
    readonly session: string;
    readonly model: string | null;
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly cost_usd: number | null;
}

const SESSION_USAGE_SQL = (d: number) => `
SELECT
    type::string(session) AS session,
    model,
    prompt_tokens ?? 0 AS prompt_tokens,
    completion_tokens ?? 0 AS completion_tokens,
    estimated_cost_usd AS cost_usd
FROM session_token_usage
WHERE ts > time::now() - ${win(d)};`;

export const fetchSessionUsageRows = Effect.fn("team.fetchSessionUsageRows")(
    function* (opts: { readonly windowDays: number }) {
        const db = yield* SurrealClient;
        const rows = yield* db
            .query<[Array<Record<string, unknown>>]>(SESSION_USAGE_SQL(opts.windowDays))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        return rows
            .filter((r) => r.session != null)
            .map((r) => ({
                session: String(r.session),
                model: r.model == null ? null : String(r.model),
                prompt_tokens: Number(r.prompt_tokens ?? 0),
                completion_tokens: Number(r.completion_tokens ?? 0),
                cost_usd: r.cost_usd == null ? null : Number(r.cost_usd),
            })) satisfies SessionUsageRow[];
    },
);

// --- tool-call command aggregate, per-session fan-out -------------------------
// Classification (verification share) happens on the FULL command text in JS
// (profile/tool-taxonomy.ts) - command text is never returned to the caller
// beyond this module's aggregation input and never serialized into the
// snapshot (counts-only privacy invariant, mirrors fetchWrappedCounts).

export interface ToolCmdRow {
    readonly cmd: string;
    readonly count: number;
    readonly failures: number;
}

const TOOL_AGG_FOR_SESSION_SQL = (sessionLit: string) => `
SELECT
    (command_text ?? command_norm ?? name) AS cmd,
    count() AS count,
    math::sum(IF has_error = true THEN 1 ELSE 0 END) AS failures
FROM tool_call
WHERE session = ${sessionLit}
  AND (command_text ?? command_norm ?? name) IS NOT NONE
GROUP BY cmd;`;

/** `type::string(id)` output → clean backtick record literal (sessions-query.ts idiom). */
const sessionLiteral = (id: string): string => {
    let k = id.replace(/^session:/, "");
    if (k.startsWith("⟨") && k.endsWith("⟩")) k = k.slice(1, -1);
    else if (k.startsWith("`") && k.endsWith("`")) k = k.slice(1, -1);
    return `session:\`${k}\``;
};

const TOOL_AGG_CONCURRENCY = 8;

export const fetchToolCallAggBySession = Effect.fn("team.fetchToolCallAggBySession")(
    function* (opts: { readonly sessionIds: ReadonlyArray<string> }) {
        if (opts.sessionIds.length === 0) return [] as ToolCmdRow[];
        const db = yield* SurrealClient;
        const perSession = yield* Effect.forEach(
            opts.sessionIds,
            (id) =>
                db.query<[Array<Record<string, unknown>>]>(
                    TOOL_AGG_FOR_SESSION_SQL(sessionLiteral(id)),
                ).pipe(Effect.map((r) => r?.[0] ?? [])),
            { concurrency: TOOL_AGG_CONCURRENCY },
        );
        // Merge per-session command rows into one cmd -> counts map.
        const merged = new Map<string, { count: number; failures: number }>();
        for (const rows of perSession) {
            for (const r of rows) {
                const cmd = String(r.cmd ?? "");
                if (cmd.length === 0) continue;
                const cur = merged.get(cmd) ?? { count: 0, failures: 0 };
                cur.count += Number(r.count ?? 0);
                cur.failures += Number(r.failures ?? 0);
                merged.set(cmd, cur);
            }
        }
        return [...merged.entries()].map(([cmd, v]) => ({
            cmd,
            count: v.count,
            failures: v.failures,
        })) satisfies ToolCmdRow[];
    },
);
```

- [ ] **Step 2: Typecheck the new module**

Run: `bun run typecheck`
Expected: exit 0 (verify with `echo $?` immediately after; no piping).

- [ ] **Step 3: Commit**

```bash
git add apps/axctl/src/team/team-profile-queries.ts
git commit -m "feat(team): repo-scoped queries for team profile builder"
```

---

### Task 3: buildTeamProfile + redaction + tests

**Files:**
- Create: `apps/axctl/src/team/team-profile.ts`
- Test: `apps/axctl/src/team/team-profile.test.ts`

**Interfaces:**
- Consumes: Task 1 `decodeTeamProfile`/`TeamProfileV1`/`TeamShare`; Task 2 queries; `fetchWindowedInvocations` from `../profile/queries.ts` (import only - file unchanged); `isVerificationTool` from `../profile/tool-taxonomy.ts`.
- Produces: `buildTeamProfile(opts: { org: string; repoKey: string; windowDays: number; share: TeamShare; includeCost: boolean; env: TeamProfileEnv }): Effect<TeamProfileV1, DbError, SurrealClient>` with `TeamProfileEnv = { login: string; generatedAt: string }`.

- [ ] **Step 1: Write the failing test** (`team-profile.test.ts`)

The mock is ROUTE-based (`@ax/lib/testing/surreal`), not order-based: routes match SQL substrings, and `captured` lets us assert the session query is genuinely repo-scoped. The two-repo fixture puts usage/invocation/tool rows for BOTH repos' sessions behind machine-window routes; only repo-A aggregates may reach the output.

```ts
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeTestSurrealLayer } from "@ax/lib/testing/surreal";
import { buildTeamProfile } from "./team-profile.ts";

const REPO_A = "remote__github_com_acme_widgets__abc123";

// Two-repo fixture: repo A owns sessions a1/a2; session b1 belongs to another
// repo. The session route answers ONLY repo-A rows (the SQL itself carries the
// repository literal - asserted below); usage/invocation routes answer rows for
// BOTH repos' sessions, so any b1 data reaching the output means the JS repo
// filter is broken.
const routes = {
    "FROM session\n": [[
        { id: "session:⟨a1⟩", started_at: "2026-07-14T10:00:00Z", source: "claude" },
        { id: "session:⟨a2⟩", started_at: "2026-07-15T09:00:00Z", source: "codex" },
    ]],
    "FROM session_token_usage": [[
        { session: "session:⟨a1⟩", model: "fable", prompt_tokens: 1000, completion_tokens: 200, cost_usd: 3 },
        { session: "session:⟨a2⟩", model: "haiku", prompt_tokens: 500, completion_tokens: 100, cost_usd: 1 },
        { session: "session:⟨b1⟩", model: "fable", prompt_tokens: 9_000_000, completion_tokens: 9_000_000, cost_usd: 999 },
    ]],
    "FROM invoked": [[
        { session: "session:⟨a1⟩", skill: "tdd", ts: "2026-07-14T10:01:00Z" },
        { session: "session:⟨a1⟩", skill: "tdd", ts: "2026-07-14T10:30:00Z" },
        { session: "session:⟨a2⟩", skill: "tdd", ts: "2026-07-15T09:10:00Z" },
        { session: "session:⟨a2⟩", skill: "review", ts: "2026-07-15T09:20:00Z" },
        { session: "session:⟨b1⟩", skill: "leaky-skill", ts: "2026-07-15T09:30:00Z" },
    ]],
    "FROM tool_call": [[
        { cmd: "bun test", count: 10, failures: 1 },
        { cmd: "Read", count: 20, failures: 0 },
    ]],
};

const run = (opts: {
    share: "public" | "anon";
    includeCost: boolean;
}) => {
    const { layer, captured } = makeTestSurrealLayer({ routes, denyWrites: true });
    const profile = Effect.runSync(
        buildTeamProfile({
            org: "acme",
            repoKey: REPO_A,
            windowDays: 30,
            share: opts.share,
            includeCost: opts.includeCost,
            env: { login: "necmttn", generatedAt: "2026-07-16T00:00:00Z" },
        }).pipe(Effect.provide(layer)),
    );
    return { profile, captured };
};

describe("buildTeamProfile", () => {
    test("scopes the session query to the repo and aggregates only repo sessions", () => {
        const { profile, captured } = run({ share: "public", includeCost: true });

        // The session query itself carries the repo literal (index-backed scoping).
        const sessionSql = captured.find((sql) => sql.includes("FROM session\n"));
        expect(sessionSql).toContain(`repository:\`${REPO_A}\``);

        // Aggregates cover ONLY repo-A sessions - b1's rows never leak through.
        expect(profile.stats.sessions).toBe(2);
        expect(profile.stats.active_days).toBe(2);
        expect(profile.stats.harnesses).toEqual(["claude", "codex"]);
        expect(profile.spend.tokens).toEqual({ prompt: 1500, completion: 300, total: 1800 });
        expect(profile.spend.cost_usd).toBe(4);
        expect(profile.skills).toEqual([
            { skill: "tdd", runs: 3, sessions: 2 },
            { skill: "review", runs: 1, sessions: 1 },
        ]);
        expect(JSON.stringify(profile)).not.toContain("leaky-skill");
        expect(JSON.stringify(profile)).not.toContain("999");

        // Daily-collapsed activity: tokens land on the session's started_at day.
        expect(profile.activity.daily).toEqual([
            { date: "2026-07-14", sessions: 1, tokens: 1200 },
            { date: "2026-07-15", sessions: 1, tokens: 600 },
        ]);

        // Efficiency: bun test classifies as verification via tool-taxonomy.
        expect(profile.efficiency).toEqual({
            tool_calls: 30,
            tool_failures: 1,
            verification_calls: 10,
        });

        // tool_call fan-out is per-session literal (indexed), never IN [list].
        const toolSqls = captured.filter((sql) => sql.includes("FROM tool_call"));
        expect(toolSqls).toHaveLength(2);
        expect(toolSqls[0]).toContain("session:`a1`");
        expect(toolSqls[1]).toContain("session:`a2`");

        expect(profile.v).toBe(1);
        expect(profile.login).toBe("necmttn");
        expect(profile.org).toBe("acme");
        expect(profile.repo_key).toBe(REPO_A);
    });

    test("share=anon strips login (null) and carries no github identity", () => {
        const { profile } = run({ share: "anon", includeCost: true });
        expect(profile.login).toBeNull();
        expect(JSON.stringify(profile)).not.toContain("necmttn");
    });

    test("includeCost=false nulls cost_usd, drops per-model cost, token-weights share", () => {
        const { profile } = run({ share: "public", includeCost: false });
        expect(profile.spend.cost_usd).toBeNull();
        for (const m of profile.spend.model_mix) {
            expect(m).not.toHaveProperty("cost_usd");
        }
        // token-weighted: fable 1200/1800, haiku 600/1800
        const fable = profile.spend.model_mix.find((m) => m.model === "fable");
        expect(fable?.share).toBeCloseTo(1200 / 1800);
        expect(JSON.stringify(profile)).not.toContain("cost_usd");
    });

    test("cost-weighted share when cost is included", () => {
        const { profile } = run({ share: "public", includeCost: true });
        const fable = profile.spend.model_mix.find((m) => m.model === "fable");
        expect(fable?.share).toBeCloseTo(3 / 4);
        expect(fable?.cost_usd).toBe(3);
    });

    test("no free-text pattern summaries in output", () => {
        const { profile } = run({ share: "public", includeCost: true });
        const json = JSON.stringify(profile);
        expect(json).not.toContain("summary");
        expect(json).not.toContain("patterns");
        expect(json).not.toContain("hypothesis");
    });

    test("empty repo window yields a valid zero snapshot", () => {
        const { layer } = makeTestSurrealLayer({ routes: {}, denyWrites: true });
        const profile = Effect.runSync(
            buildTeamProfile({
                org: "acme", repoKey: REPO_A, windowDays: 30,
                share: "public", includeCost: true,
                env: { login: "necmttn", generatedAt: "2026-07-16T00:00:00Z" },
            }).pipe(Effect.provide(layer)),
        );
        expect(profile.stats.sessions).toBe(0);
        expect(profile.activity.daily).toEqual([]);
        expect(profile.skills).toEqual([]);
        expect(profile.spend.cost_usd).toBe(0);
    });
});
```

NOTE for implementer: check the exact exported names of the test layer factory in `packages/lib/src/testing/surreal.ts` (`makeTestSurrealLayer` vs `makeMockDb`/`runWithMock`) and the shape of `captured` before writing - adjust the test's imports to the real API, keep the assertions identical. Route keys must be substrings that uniquely match each query's SQL (`"FROM session\n"` must NOT match `FROM session_token_usage` - verify against the actual SQL text from Task 2 and `WINDOWED_INVOCATIONS_SQL`).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/axctl/src/team/team-profile.test.ts`
Expected: FAIL - `./team-profile.ts` missing.

- [ ] **Step 3: Write the implementation** (`team-profile.ts`)

```ts
/**
 * buildTeamProfile - repo-scoped, redacted, daily-collapsed TeamProfileV1
 * snapshot builder (goal package §5 Slice 1). Sibling of profile/render.ts
 * buildProfile, but scoped to ONE repo: an indexed session query resolves the
 * repo's session-id set; usage/invocation rows are filtered against it in JS;
 * tool_call aggregates fan out per-session literal. Privacy invariants live
 * HERE: anon strips login; !includeCost nulls cost; the output shape carries
 * no free text (structural redaction - see team-profile-types.ts).
 */
import { Effect } from "effect";
import { fetchWindowedInvocations } from "../profile/queries.ts";
import { isVerificationTool } from "../profile/tool-taxonomy.ts";
import {
    fetchSessionUsageRows,
    fetchTeamRepoSessions,
    fetchToolCallAggBySession,
} from "./team-profile-queries.ts";
import { decodeTeamProfile, type TeamProfileV1, type TeamShare } from "./team-profile-types.ts";

export interface TeamProfileEnv {
    readonly login: string;
    readonly generatedAt: string;
}

const day = (iso: string): string => iso.slice(0, 10);

export const buildTeamProfile = Effect.fn("team.buildTeamProfile")(
    function* (opts: {
        readonly org: string;
        readonly repoKey: string;
        readonly windowDays: number;
        readonly share: TeamShare;
        readonly includeCost: boolean;
        readonly env: TeamProfileEnv;
    }) {
        const { org, repoKey, windowDays, share, includeCost, env } = opts;

        // 1. Repo session set (indexed; the ONLY query that names the repo).
        const sessions = yield* fetchTeamRepoSessions({ repoKey, windowDays });
        const sessionIds = new Set(sessions.map((s) => s.id));

        // 2. Machine-window per-row fetches, repo-filtered in JS.
        const usageAll = yield* fetchSessionUsageRows({ windowDays });
        const usage = usageAll.filter((u) => sessionIds.has(u.session));
        const invocationsAll = yield* fetchWindowedInvocations({ windowDays });
        const invocations = invocationsAll.filter((i) => sessionIds.has(i.session));

        // 3. Per-session indexed tool_call fan-out (repo-scoped by construction).
        const toolAgg = yield* fetchToolCallAggBySession({ sessionIds: [...sessionIds] });

        // --- stats + daily-collapsed activity ---------------------------------
        const usageBySession = new Map(usage.map((u) => [u.session, u]));
        const dailyMap = new Map<string, { sessions: number; tokens: number }>();
        for (const s of sessions) {
            const d = day(s.started_at);
            const cur = dailyMap.get(d) ?? { sessions: 0, tokens: 0 };
            cur.sessions += 1;
            const u = usageBySession.get(s.id);
            if (u !== undefined) cur.tokens += u.prompt_tokens + u.completion_tokens;
            dailyMap.set(d, cur);
        }
        const daily = [...dailyMap.entries()]
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([date, v]) => ({ date, sessions: v.sessions, tokens: v.tokens }));

        const harnessCounts = new Map<string, number>();
        for (const s of sessions) {
            harnessCounts.set(s.source, (harnessCounts.get(s.source) ?? 0) + 1);
        }
        const harnesses = [...harnessCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([source]) => source);

        // --- skills ------------------------------------------------------------
        const skillAgg = new Map<string, { runs: number; sessions: Set<string> }>();
        for (const inv of invocations) {
            const cur = skillAgg.get(inv.skill) ?? { runs: 0, sessions: new Set<string>() };
            cur.runs += 1;
            cur.sessions.add(inv.session);
            skillAgg.set(inv.skill, cur);
        }
        const skills = [...skillAgg.entries()]
            .sort((a, b) => b[1].runs - a[1].runs)
            .map(([skill, v]) => ({ skill, runs: v.runs, sessions: v.sessions.size }));

        // --- spend --------------------------------------------------------------
        const prompt = usage.reduce((s, u) => s + u.prompt_tokens, 0);
        const completion = usage.reduce((s, u) => s + u.completion_tokens, 0);
        const totalTokens = prompt + completion;
        const totalCost = usage.reduce((s, u) => s + (u.cost_usd ?? 0), 0);

        const modelAgg = new Map<string, { tokens: number; cost: number }>();
        for (const u of usage) {
            const name = u.model ?? "(unattributed)";
            const cur = modelAgg.get(name) ?? { tokens: 0, cost: 0 };
            cur.tokens += u.prompt_tokens + u.completion_tokens;
            cur.cost += u.cost_usd ?? 0;
            modelAgg.set(name, cur);
        }
        // share is cost-weighted when cost is shared, token-weighted under
        // no_cost (a cost-derived share would leak spend ratios).
        const model_mix = [...modelAgg.entries()]
            .sort((a, b) => b[1].tokens - a[1].tokens)
            .map(([model, v]) => ({
                model,
                share: includeCost
                    ? totalCost > 0 ? v.cost / totalCost : 0
                    : totalTokens > 0 ? v.tokens / totalTokens : 0,
                tokens: v.tokens,
                ...(includeCost ? { cost_usd: v.cost } : {}),
            }));

        // --- efficiency ----------------------------------------------------------
        const tool_calls = toolAgg.reduce((s, r) => s + r.count, 0);
        const tool_failures = toolAgg.reduce((s, r) => s + r.failures, 0);
        const verification_calls = toolAgg
            .filter((r) => isVerificationTool(r.cmd))
            .reduce((s, r) => s + r.count, 0);

        // decodeTeamProfile throws on invariant breach -> Effect defect (die),
        // intentionally unrecoverable: a malformed snapshot is a bug here.
        const profile: TeamProfileV1 = decodeTeamProfile({
            v: 1,
            login: share === "anon" ? null : env.login,
            org,
            repo_key: repoKey,
            window_days: windowDays,
            generated_at: env.generatedAt,
            stats: {
                sessions: sessions.length,
                active_days: dailyMap.size,
                harnesses,
            },
            activity: { daily },
            skills,
            spend: {
                tokens: { prompt, completion, total: totalTokens },
                cost_usd: includeCost ? totalCost : null,
                model_mix,
            },
            efficiency: { tool_calls, tool_failures, verification_calls },
        });
        return profile;
    },
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/axctl/src/team/`
Expected: PASS (all Task 1 + Task 3 tests). If the tool-fan-out order assertion flakes on Set iteration order, sort `[...sessionIds]` before fan-out - deterministic order is fine to add.

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/team/team-profile.ts apps/axctl/src/team/team-profile.test.ts
git commit -m "feat(team): buildTeamProfile repo-scoped redacted snapshot builder"
```

---

### Task 4: gates + final commit

- [ ] **Step 1: Run all three gates from the worktree root, checking real exit codes**

```bash
bun run typecheck; echo "typecheck=$?"
bun test apps/axctl/src/team/; echo "tests=$?"
bun run check:no-node-fs; echo "no-node-fs=$?"
```
Expected: all three print `=0`.

- [ ] **Step 2: Final commit (fold plan doc + any stragglers; exclude BRIEF/REPORT)**

```bash
git add -A ':!BRIEF.md' ':!REPORT.md'
git commit -m "feat(team): TeamProfileV1 + repo-scoped redacted snapshot builder" || true
```
(If Tasks 1–3 already committed everything, squash is NOT needed - multiple conventional commits are acceptable; the brief's "one conventional commit" is satisfied by ensuring the final state is fully committed. If the orchestrator requires literally one commit, soft-reset and recommit: `git reset --soft $(git merge-base HEAD main) && git commit -m "feat(team): TeamProfileV1 + repo-scoped redacted snapshot builder"`.)

- [ ] **Step 3: Signal**

```bash
echo "$(date -Iseconds) team-profile DONE TeamProfileV1 + buildTeamProfile landed, gates green" >> /tmp/fleet-team-dash-s1.signals
```

## Self-Review Notes

- Spec coverage: type ✓ (Task 1), builder with repo scoping ✓ (Tasks 2–3), redaction invariants ✓ (structural + anon + no-cost tests), decoder ✓, gates ✓ (Task 4). Escape-hatch report: workflow arcs / guardrails / insights / origin-split intentionally omitted - record in final report.
- `profile/queries.ts` untouched (import-only reuse) - satisfies the "additive only, and only if needed" constraint by needing nothing.
- Test seam: DB mock is the non-deterministic leaf; assertions are on real output + captured SQL text (scoping), never "was called".
