// Extracted from cli/index.ts (Phase 2 CLI split)
import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { cmdShare } from "../share.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { boolArg } from "./shared.ts";

export const shareCommand = Command.make(
    "share",
    {
        args: Argument.string("arg").pipe(Argument.variadic({ min: 0 })),
        dryRun: Flag.boolean("dry-run").pipe(Flag.withDefault(false)),
        open: Flag.boolean("open").pipe(Flag.withDefault(false)),
        public: Flag.boolean("public").pipe(Flag.withDefault(false)),
        yes: Flag.boolean("yes").pipe(Flag.withDefault(false)),
    },
    ({ args, dryRun, open, public: publicGist, yes }) =>
        Effect.promise(() =>
            cmdShare([
                ...args,
                ...boolArg("dry-run", dryRun),
                ...boolArg("open", open),
                ...boolArg("public", publicGist),
                ...boolArg("yes", yes),
            ]),
        ),
).pipe(
    Command.withDescription("Publish a redacted session share Gist"),
);

export const shareRuntime: RuntimeManifest = {
    share: "none",
};
