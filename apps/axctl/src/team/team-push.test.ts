import { afterEach, describe, expect, test } from "bun:test";
import { makeMockDb } from "@ax/lib/testing/surreal";
import { Effect, Layer } from "effect";
import { GitHubEnvTest } from "../profile/github-env.ts";
import { savePublishState } from "../profile/publish-state.ts";
import { upsertTeamBinding } from "./team-bindings-state.ts";
import { pushCurrentTeamProfile } from "./team-push.ts";

const dir = `/tmp/ax-team-push-test-${process.pid}`;
const bindingsPath = `${dir}/team-bindings.json`;
const publishStatePath = `${dir}/profile-publish.json`;

afterEach(async () => {
    await Bun.$`rm -rf ${dir}`.quiet().nothrow();
});

describe("pushCurrentTeamProfile", () => {
    test("refuses an unbound repository without sending anything to GitHub", async () => {
        const github = GitHubEnvTest({ responses: {}, login: "alice" });
        const db = makeMockDb(new Map());

        const outcome = await Effect.runPromise(
            pushCurrentTeamProfile({
                repoKey: "repo-unbound",
                bindingsPath,
                publishStatePath,
                windowDays: 30,
                generatedAt: "2026-07-16T00:00:00Z",
            }).pipe(
                Effect.match({
                    onSuccess: (value) => ({ ok: true as const, value }),
                    onFailure: (error) => ({ ok: false as const, error }),
                }),
                Effect.provide(Layer.merge(github.layer, db.layer)),
            ),
        );

        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
            expect(outcome.error._tag).toBe("TeamRepoUnboundError");
            expect(outcome.error.message).toMatch(/unbound|not bound|refus/i);
        }
        expect(github.calls).toEqual([]);
        expect(db.captured).toEqual([]);
    });

    test("creates without a sha, then updates with the current contents sha", async () => {
        const repoKey = "repo-acme";
        await upsertTeamBinding(bindingsPath, repoKey, {
            org: "acme",
            share: "full",
            joined_at: "2026-07-16T00:00:00Z",
        });
        const path = "/repos/acme/ax-team/contents/.ax-team/alice.json";
        const db = makeMockDb(new Map());
        const first = GitHubEnvTest({
            responses: {
                [`PUT ${path}`]: { content: { sha: "created-sha" } },
            },
            login: "Alice",
        });

        const firstResult = await Effect.runPromise(
            pushCurrentTeamProfile({
                repoKey,
                bindingsPath,
                publishStatePath,
                windowDays: 30,
                generatedAt: "2026-07-16T00:00:00Z",
            }).pipe(Effect.provide(Layer.merge(first.layer, db.layer))),
        );

        expect(firstResult.file).toBe(".ax-team/alice.json");
        expect(first.calls.map(({ method, path: callPath }) => `${method} ${callPath}`)).toEqual([
            `GET ${path}`,
            `PUT ${path}`,
        ]);
        const firstBody = first.calls[1]?.body as Record<string, unknown>;
        expect(firstBody).not.toHaveProperty("sha");
        const firstProfile = JSON.parse(
            Buffer.from(String(firstBody.content), "base64").toString("utf8"),
        ) as Record<string, unknown>;
        expect(firstProfile.login).toBe("Alice");
        expect(firstProfile.repo_key).toBe(repoKey);

        const second = GitHubEnvTest({
            responses: {
                [`GET ${path}`]: { sha: "current-sha" },
                [`PUT ${path}`]: { content: { sha: "updated-sha" } },
            },
            login: "Alice",
        });
        await Effect.runPromise(
            pushCurrentTeamProfile({
                repoKey,
                bindingsPath,
                publishStatePath,
                windowDays: 30,
                generatedAt: "2026-07-16T00:00:00Z",
            }).pipe(Effect.provide(Layer.merge(second.layer, db.layer))),
        );

        expect(second.calls.map(({ method, path: callPath }) => `${method} ${callPath}`)).toEqual([
            `GET ${path}`,
            `PUT ${path}`,
        ]);
        expect(second.calls[1]?.body).toMatchObject({ sha: "current-sha" });
    });

    test("anonymous sharing uses a pseudonymous filename and strips identity and cost", async () => {
        const repoKey = "repo-private";
        await upsertTeamBinding(bindingsPath, repoKey, {
            org: "secret-org",
            share: "anon",
            joined_at: "2026-07-16T00:00:00Z",
        });
        await savePublishState(publishStatePath, {
            v: 1,
            gist_id: "profile-gist",
            owner: "Alice",
            consented_at: "2026-07-16T00:00:00Z",
            published_at: "2026-07-16T00:00:00Z",
            no_cost: true,
        });
        const anonymousPath =
            "/repos/secret-org/ax-team/contents/.ax-team/anon-a82d4c1d6bcd84fd0bfc8cbf.json";
        const github = GitHubEnvTest({
            responses: {
                [`PUT ${anonymousPath}`]: { content: { sha: "created-sha" } },
            },
            login: "Alice",
        });
        const db = makeMockDb(new Map());

        const result = await Effect.runPromise(
            pushCurrentTeamProfile({
                repoKey,
                bindingsPath,
                publishStatePath,
                windowDays: 30,
                generatedAt: "2026-07-16T00:00:00Z",
            }).pipe(Effect.provide(Layer.merge(github.layer, db.layer))),
        );

        expect(result.anonymous).toBe(true);
        expect(result.file).toMatch(/^\.ax-team\/anon-[a-f0-9]{24}\.json$/);
        expect(result.file.toLowerCase()).not.toContain("alice");
        const put = github.calls.find((call) => call.method === "PUT");
        const body = put?.body as Record<string, unknown>;
        const profile = JSON.parse(
            Buffer.from(String(body.content), "base64").toString("utf8"),
        ) as {
            login: string | null;
            spend: { cost_usd: number | null; model_mix: Array<Record<string, unknown>> };
        };
        expect(profile.login).toBeNull();
        expect(profile.spend.cost_usd).toBeNull();
        expect(profile.spend.model_mix.every((model) => !("cost_usd" in model))).toBe(true);
        expect(JSON.stringify({ calls: github.calls, profile }).toLowerCase()).not.toContain("alice");
    });

    test("each bound repository pushes only to its own organization", async () => {
        await upsertTeamBinding(bindingsPath, "repo-one", {
            org: "org-one",
            share: "full",
            joined_at: "2026-07-16T00:00:00Z",
        });
        await upsertTeamBinding(bindingsPath, "repo-two", {
            org: "org-two",
            share: "full",
            joined_at: "2026-07-16T00:00:00Z",
        });
        const onePath = "/repos/org-one/ax-team/contents/.ax-team/alice.json";
        const twoPath = "/repos/org-two/ax-team/contents/.ax-team/alice.json";
        const github = GitHubEnvTest({
            responses: {
                [`PUT ${onePath}`]: {},
                [`PUT ${twoPath}`]: {},
            },
            login: "alice",
        });
        const db = makeMockDb(new Map());
        const layer = Layer.merge(github.layer, db.layer);

        await Effect.runPromise(
            pushCurrentTeamProfile({
                repoKey: "repo-one",
                bindingsPath,
                publishStatePath,
                windowDays: 30,
                generatedAt: "2026-07-16T00:00:00Z",
            }).pipe(Effect.provide(layer)),
        );
        await Effect.runPromise(
            pushCurrentTeamProfile({
                repoKey: "repo-two",
                bindingsPath,
                publishStatePath,
                windowDays: 30,
                generatedAt: "2026-07-16T00:00:00Z",
            }).pipe(Effect.provide(layer)),
        );

        expect(github.calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
            `GET ${onePath}`,
            `PUT ${onePath}`,
            `GET ${twoPath}`,
            `PUT ${twoPath}`,
        ]);
        const profiles = github.calls
            .filter((call) => call.method === "PUT")
            .map((call) => JSON.parse(
                Buffer.from(
                    String((call.body as Record<string, unknown>).content),
                    "base64",
                ).toString("utf8"),
            ) as { org: string; repo_key: string });
        expect(profiles.map(({ org, repo_key }) => ({ org, repo_key }))).toEqual([
            { org: "org-one", repo_key: "repo-one" },
            { org: "org-two", repo_key: "repo-two" },
        ]);
    });
});
