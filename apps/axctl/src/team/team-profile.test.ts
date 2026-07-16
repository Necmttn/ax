import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeMockDb, type TestSurrealResponder } from "@ax/lib/testing/surreal";
import { buildTeamProfile } from "./team-profile.ts";

const REPO_A = "remote__github_com_acme_widgets__abc123";

// Two-repo fixture: repo A owns sessions a1/a2; session b1 belongs to another
// repo. The session route answers ONLY repo-A rows (the SQL itself carries the
// repository literal - asserted below); usage/invocation routes answer rows for
// BOTH repos' sessions, so any b1 data reaching the output means the JS repo
// filter is broken.
//
// tool_call is fanned out per-session (one query per session id), and the
// mock's route matching is a stateless SQL-substring test - a flat response
// would answer BOTH the a1 and a2 queries identically, doubling every count.
// Only session a1 carries tool-call activity in this fixture, so the
// responder inspects the issued SQL for the session literal it's answering.
const routes = new Map<string, TestSurrealResponder>([
    ["FROM session\n", [[
        { id: "session:⟨a1⟩", started_at: "2026-07-14T10:00:00Z", source: "claude" },
        { id: "session:⟨a2⟩", started_at: "2026-07-15T09:00:00Z", source: "codex" },
    ]]],
    ["FROM session_token_usage", [[
        { session: "session:⟨a1⟩", model: "fable", prompt_tokens: 1000, completion_tokens: 200, cost_usd: 3 },
        { session: "session:⟨a2⟩", model: "haiku", prompt_tokens: 500, completion_tokens: 100, cost_usd: 1 },
        { session: "session:⟨b1⟩", model: "fable", prompt_tokens: 9_000_000, completion_tokens: 9_000_000, cost_usd: 999 },
    ]]],
    ["FROM invoked", [[
        { session: "session:⟨a1⟩", skill: "tdd", ts: "2026-07-14T10:01:00Z" },
        { session: "session:⟨a1⟩", skill: "tdd", ts: "2026-07-14T10:30:00Z" },
        { session: "session:⟨a2⟩", skill: "tdd", ts: "2026-07-15T09:10:00Z" },
        { session: "session:⟨a2⟩", skill: "review", ts: "2026-07-15T09:20:00Z" },
        { session: "session:⟨b1⟩", skill: "leaky-skill", ts: "2026-07-15T09:30:00Z" },
    ]]],
    ["FROM tool_call", (sql: string) =>
        sql.includes("session:`a1`")
            ? [[
                { cmd: "bun test", count: 10, failures: 1 },
                { cmd: "Read", count: 20, failures: 0 },
            ]]
            : [[]],
    ],
]);

const run = (opts: {
    share: "public" | "anon";
    includeCost: boolean;
}) => {
    const { layer, captured } = makeMockDb(routes);
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
        // The top-level `spend.cost_usd` key is REQUIRED by the (immutable,
        // Task-1) schema and stays present as `null` - so a blanket
        // `not.toContain("cost_usd")` is unsatisfiable. What actually must
        // hold: no *second* occurrence (a leaked per-model cost) - the key
        // appears exactly once, for the null placeholder.
        const costUsdOccurrences = JSON.stringify(profile).match(/cost_usd/g) ?? [];
        expect(costUsdOccurrences).toHaveLength(1);
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
        const { layer } = makeMockDb(new Map());
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
