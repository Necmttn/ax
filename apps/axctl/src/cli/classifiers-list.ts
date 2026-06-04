import { Console, Effect, type FileSystem, type Path } from "effect";
import { formatClassifierList, listClassifiers } from "../classifiers/list.ts";

export const cmdClassifiersList = (
    args: readonly string[],
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const json = args.includes("--json");
        const rows = yield* listClassifiers();
        yield* Console.log(formatClassifierList(rows, { json }));
    });
