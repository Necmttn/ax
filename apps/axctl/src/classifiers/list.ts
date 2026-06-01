import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ClassifierDefinition } from "./core.ts";
import { registeredClassifiers, type RegisteredClassifier } from "./registry.ts";
import { loadClassifierEvalSuites } from "./eval.ts";

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

const fixtureCountsByClassifier = (fixturePath: string): Map<string, number> => {
    const counts = new Map<string, number>();
    try {
        statSync(fixturePath);
    } catch {
        return counts;
    }
    for (const suite of loadClassifierEvalSuites(fixturePath)) {
        const current = counts.get(suite.name) ?? 0;
        counts.set(suite.name, current + suite.cases.length);
    }
    return counts;
};

export function listClassifiers(
    classifiers: readonly RegisteredClassifier[] = registeredClassifiers,
): readonly ClassifierListRow[] {
    return classifiers.map((entry) => {
        const classifier: ClassifierDefinition = entry.definition;
        const fixtureCases = entry.fixturePaths.reduce((total, path) => {
            const counts = fixtureCountsByClassifier(path);
            return total + (counts.get(classifier.key) ?? 0);
        }, 0);
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
        };
    });
}

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

export function classifierFixtureFiles(path = "src/classifiers/eval-fixtures"): readonly string[] {
    try {
        return readdirSync(path)
            .filter((file) => file.endsWith(".json"))
            .sort()
            .map((file) => join(path, file));
    } catch {
        return [];
    }
}
