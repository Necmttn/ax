import type { ClassifierDefinition } from "./core.ts";
import { correctionEventClassifier } from "./correction-event/index.ts";
import { reactionEventClassifier } from "./reaction-event/index.ts";
import { directionEventClassifier } from "@ax-classifier/direction-event";
import { verificationEventClassifier } from "@ax-classifier/verification-event";

export interface RegisteredClassifier {
    readonly definition: ClassifierDefinition;
    readonly source: "built-in" | "package";
    readonly packageName?: string;
    readonly manifestPath?: string;
    readonly fixturePaths: readonly string[];
}

export const registeredClassifiers = [
    {
        definition: reactionEventClassifier,
        source: "built-in",
        fixturePaths: ["src/classifiers/eval-fixtures/reaction-event.json"],
    },
    {
        definition: directionEventClassifier,
        source: "package",
        packageName: "@ax-classifier/direction-event",
        manifestPath: "packages/ax-classifier-direction-event/ax.classifier.json",
        fixturePaths: ["packages/ax-classifier-direction-event/eval-fixtures/direction-event.json"],
    },
    {
        definition: correctionEventClassifier,
        source: "built-in",
        fixturePaths: ["src/classifiers/eval-fixtures/correction-event.json"],
    },
    {
        definition: verificationEventClassifier,
        source: "package",
        packageName: "@ax-classifier/verification-event",
        manifestPath: "packages/ax-classifier-verification-event/ax.classifier.json",
        fixturePaths: ["packages/ax-classifier-verification-event/eval-fixtures/verification-event.json"],
    },
] as const satisfies readonly RegisteredClassifier[];

export const builtInClassifiers = registeredClassifiers.map((entry) => entry.definition) satisfies readonly ClassifierDefinition[];
