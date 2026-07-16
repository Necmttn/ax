/**
 * Push one explicitly bound Repository's redacted TeamProfileV1 through the
 * GitHub contents API. Anonymous filenames are org-scoped pseudonyms so the
 * real login is absent from both the path and snapshot.
 */
import { Effect, Schema } from "effect";
import { GitHubApiError, GitHubEnv } from "../profile/github-env.ts";
import { loadPublishState } from "../profile/publish-state.ts";
import { sha256Hex } from "./exec-hash.ts";
import { bindingFor, loadTeamBindings } from "./team-bindings-state.ts";
import { buildTeamProfile } from "./team-profile.ts";

export class TeamRepoUnboundError extends Schema.TaggedErrorClass<TeamRepoUnboundError>(
    "TeamRepoUnboundError",
)("TeamRepoUnboundError", {
    repoKey: Schema.String,
    message: Schema.String,
}) {}

export class TeamPushIdentityError extends Schema.TaggedErrorClass<TeamPushIdentityError>(
    "TeamPushIdentityError",
)("TeamPushIdentityError", {
    message: Schema.String,
}) {}

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null
        ? value as Record<string, unknown>
        : {};

const snapshotFilename = (input: {
    readonly login: string;
    readonly org: string;
    readonly anonymous: boolean;
}): string =>
    input.anonymous
        ? `anon-${sha256Hex(`${input.org.toLowerCase()}\0${input.login.toLowerCase()}`).slice(0, 24)}.json`
        : `${input.login.toLowerCase()}.json`;

export const pushCurrentTeamProfile = Effect.fn("team.pushCurrentTeamProfile")(
    function* (input: {
        readonly repoKey: string;
        readonly bindingsPath: string;
        readonly publishStatePath: string;
        readonly windowDays: number;
        readonly generatedAt: string;
    }) {
        const bindings = yield* Effect.promise(() => loadTeamBindings(input.bindingsPath));
        const binding = bindingFor(bindings, input.repoKey);
        if (binding === undefined) {
            return yield* new TeamRepoUnboundError({
                repoKey: input.repoKey,
                message: `Repository ${input.repoKey} is unbound; refusing to push.`,
            });
        }

        const github = yield* GitHubEnv;
        const login = yield* github.login();
        if (login === null || login.trim().length === 0) {
            return yield* new TeamPushIdentityError({
                message: "GitHub identity is unavailable; run `gh auth login` before `ax team push`.",
            });
        }

        const anonymous = binding.share === "anon";
        const filename = snapshotFilename({
            login,
            org: binding.org,
            anonymous,
        });
        const file = `.ax-team/${filename}`;
        const apiPath = `/repos/${binding.org}/ax-team/contents/${file}`;
        const publishState = yield* Effect.promise(() =>
            loadPublishState(input.publishStatePath),
        );
        const profile = yield* buildTeamProfile({
            org: binding.org,
            repoKey: input.repoKey,
            windowDays: input.windowDays,
            // Bindings call named sharing "full"; TeamProfileV1 calls it "public".
            share: anonymous ? "anon" : "public",
            includeCost: !(publishState?.no_cost ?? false),
            env: {
                login,
                generatedAt: input.generatedAt,
            },
        });
        const currentSha = yield* github.api("GET", apiPath).pipe(
            Effect.map((response) => {
                const sha = asRecord(response).sha;
                return typeof sha === "string" && sha.length > 0 ? sha : undefined;
            }),
            Effect.catchTag("GitHubApiError", (error: GitHubApiError) =>
                error.status === 404
                    ? Effect.succeed(undefined)
                    : Effect.fail(error),
            ),
        );
        yield* github.api("PUT", apiPath, {
            message: `team: update ${filename}`,
            content: Buffer.from(
                `${JSON.stringify(profile, null, 2)}\n`,
                "utf8",
            ).toString("base64"),
            ...(currentSha === undefined ? {} : { sha: currentSha }),
        });

        return {
            org: binding.org,
            repoKey: input.repoKey,
            file,
            anonymous,
        };
    },
);
