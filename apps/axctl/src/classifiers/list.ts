import { Effect, FileSystem, Path } from "effect";
import { orAbsent } from "@ax/lib/shared/fs-error";
import type { ClassifierDefinition } from "./core.ts";
import { registeredClassifiers, type RegisteredClassifier } from "./registry.ts";
import { loadClassifierEvalSuites, type ClassifierEvalSuite } from "./eval.ts";

export interface ClassifierListRow {
    readonly key: string;
    readonly version: string;
    readonly kind: string;
    readonly input: string;
    readonly source: "built-in" | "package";
    readonly packageName?: string;
    readonly manifestPath?: string;
    readonly labels: readonly string[];
    readonly targets: readonly string[];
    readonly fixtureCases: number;
    readonly description: string;
}

const fixtureCountsByClassifier = (
    fixturePath: string,
): Effect.Effect<Map<string, number>, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const counts = new Map<string, number>();
        // Original probed with statSync and treated ANY failure (missing /
        // unreadable fixture path) as "no fixtures here": load suites tolerantly.
        const suites = yield* loadClassifierEvalSuites(fixturePath).pipe(
            orAbsent([] as readonly ClassifierEvalSuite[]),
        );
        for (const suite of suites) {
            const current = counts.get(suite.name) ?? 0;
            counts.set(suite.name, current + suite.cases.length);
        }
        return counts;
    });

export const listClassifiers = (
    classifiers: readonly RegisteredClassifier[] = registeredClassifiers,
): Effect.Effect<readonly ClassifierListRow[], never, FileSystem.FileSystem | Path.Path> =>
    Effect.forEach(classifiers, (entry) =>
        Effect.gen(function* () {
            const classifier: ClassifierDefinition = entry.definition;
            let fixtureCases = 0;
            for (const path of entry.fixturePaths) {
                const counts = yield* fixtureCountsByClassifier(path);
                fixtureCases += counts.get(classifier.key) ?? 0;
            }
            return {
                key: classifier.key,
                version: classifier.version,
                kind: classifier.kind,
                input: classifier.input,
                source: entry.source,
                ...(entry.packageName ? { packageName: entry.packageName } : {}),
                ...(entry.manifestPath ? { manifestPath: entry.manifestPath } : {}),
                labels: classifier.labels,
                targets: classifier.targets,
                fixtureCases,
                description: classifier.description,
            } satisfies ClassifierListRow;
        }));

const pad = (value: string, width: number): string =>
    value.length >= width ? value : value.padEnd(width);

export function formatClassifierList(rows: readonly ClassifierListRow[], opts: { readonly json?: boolean } = {}): string {
    if (opts.json) return JSON.stringify(rows, null, 2);
    if (rows.length === 0) return "No classifiers registered.";
    const lines = [
        `${pad("classifier", 24)} ${pad("version", 8)} ${pad("kind", 11)} ${pad("input", 12)} ${pad("source", 8)} fixtures labels -> targets`,
    ];
    for (const row of rows) {
        lines.push([
            pad(row.key, 24),
            pad(row.version, 8),
            pad(row.kind, 11),
            pad(row.input, 12),
            pad(row.source, 8),
            String(row.fixtureCases).padStart(8),
            `${row.labels.join(",")} -> ${row.targets.join(",")}`,
        ].join(" "));
    }
    return lines.join("\n");
}

export const classifierFixtureFiles = (
    dir = "src/classifiers/eval-fixtures",
): Effect.Effect<readonly string[], never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // Original swallowed ANY readdir error (missing dir) to an empty list.
        const entries = yield* fs.readDirectory(dir).pipe(orAbsent([] as readonly string[]));
        return entries
            .filter((file) => file.endsWith(".json"))
            .sort()
            .map((file) => path.join(dir, file));
    });
