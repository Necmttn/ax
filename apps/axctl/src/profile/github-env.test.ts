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
