import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { compileTeam } from "@ax/community-compile/team";
import { AxApi } from "@ax/lib/shared/api-contract";
import { GitHubEnv } from "../../profile/github-env.ts";
import {
    defaultTeamBindingsPath,
    loadTeamBindings,
} from "../../team/team-bindings-state.ts";
import { readTeamSnapshots } from "../../team/team-snapshot-reader.ts";

const boundOrg = (): Effect.Effect<string | undefined> =>
    Effect.promise(async () => {
        const state = await loadTeamBindings(defaultTeamBindingsPath());
        const orgs = new Set(Object.values(state.bindings).map((binding) => binding.org));
        return orgs.size === 1 ? [...orgs][0] : undefined;
    });

export const TeamGroupLive = HttpApiBuilder.group(AxApi, "team", (handlers) =>
    handlers.handle("teamBoards", ({ query }) =>
        Effect.gen(function* () {
            const github = yield* GitHubEnv;
            const requested = query.org?.trim();
            const org = requested === undefined || requested === ""
                ? yield* boundOrg()
                : requested;
            if (org === undefined) return compileTeam([]);
            const snapshots = yield* readTeamSnapshots(github, org).pipe(
                Effect.catch(() => Effect.succeed([])),
            );
            return compileTeam(snapshots);
        })),
);
