// Extracted from the cli/index.ts dispatch bypass (issue #242): `star` now
// routes through the standard manifest path like every other "none" command.
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { cmdStar } from "../star-nudge.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { boolArg } from "./shared.ts";

export const starCommand = Command.make(
    "star",
    {
        done: Flag.boolean("done").pipe(Flag.withDefault(false)),
        starred: Flag.boolean("starred").pipe(Flag.withDefault(false)),
    },
    ({ done, starred }) =>
        Effect.promise(() =>
            cmdStar([...boolArg("done", done), ...boolArg("starred", starred)]),
        ),
).pipe(
    Command.withDescription(
        "Star the ax repo on GitHub via gh (--done / --starred just hides the reminder)",
    ),
);

export const starRuntime: RuntimeManifest = {
    star: "none",
};
