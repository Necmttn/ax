// Extracted from cli/index.ts (Phase 2 CLI split)
import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { prettyPrint } from "@ax/lib/json";
import { buildFileContextPack } from "../../context/file-context.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { jsonFlag, parseFileHints } from "./shared.ts";

const contextFileCommand = Command.make(
    "file",
    {
        query: Argument.string("query").pipe(Argument.variadic({ min: 1 })),
        files: Flag.string("files").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ query, files, json }) =>
        Effect.gen(function* () {
            const pack = yield* buildFileContextPack({
                q: query.join(" "),
                files: parseFileHints(files),
            });
            if (json) {
                console.log(prettyPrint(pack));
                return;
            }
            console.log(pack.ai_context);
            console.log("");
            console.log("Graph inspection query:");
            console.log(pack.graph_inspection_query);
        }),
).pipe(Command.withDescription("Build graph-derived file context for an agent task"));

export const contextCommand = Command.make("context").pipe(
    Command.withDescription("Build just-in-time context packs for agents"),
    Command.withSubcommands([contextFileCommand]),
);

export const contextRuntime: RuntimeManifest = {
    context: { runtime: "db", hidden: true },
};
