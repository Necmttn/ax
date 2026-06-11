import { Console, Effect, type FileSystem, type Path, type PlatformError } from "effect";
import {
    formatClassifierEvalSummary,
    loadDefaultClassifierEvalSuites,
    loadClassifierEvalSuites,
    runClassifierEvalSuites,
} from "../classifiers/eval.ts";

export const cmdClassifiersEval = (
    args: readonly string[],
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const json = args.includes("--json");
        const pathArg = args.find((arg) => arg.startsWith("--path="));
        const suites = pathArg
            ? yield* loadClassifierEvalSuites(pathArg.slice("--path=".length))
            : yield* loadDefaultClassifierEvalSuites();
        const summary = yield* Effect.promise(() => runClassifierEvalSuites(suites));
        yield* Console.log(formatClassifierEvalSummary(summary, { json }));
        if (summary.failed > 0) {
            // process.exit never returns; annotate the thunk as void so its
            // inferred `never` doesn't read as a Promise to the Effect LSP.
            return yield* Effect.sync((): void => {
                process.exit(1);
            });
        }
    });
