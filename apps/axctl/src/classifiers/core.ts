import { Context, Effect, Layer, Option, Schema } from "effect";
import { decodeJsonOption } from "@ax/lib/decode";
import { safeKeyPart } from "@ax/lib/shared/derive-keys";
import { isControlOrContextText } from "./control-text.ts";

export type ClassifierKind = "heuristic" | "manual" | "local_model" | "llm_review";
export type ClassifierInputKind = "event_window" | "turn" | "session" | "tool_call";
export type ClassifierPolarity = "accept" | "reject" | "revise" | "explore" | "none";
export type ClassifierDurability =
    | "one_off"
    | "session_preference"
    | "repo_preference"
    | "global_preference"
    | "candidate_guidance";

export class ClassifierNotFound extends Schema.TaggedErrorClass<ClassifierNotFound>(
    "ClassifierNotFound",
)("ClassifierNotFound", { key: Schema.String }) {}

export class ClassifierInputError extends Schema.TaggedErrorClass<ClassifierInputError>(
    "ClassifierInputError",
)("ClassifierInputError", {
    classifierKey: Schema.String,
    message: Schema.String,
}) {}

export interface EventTurn {
    readonly id: string;
    readonly key: string;
    readonly seq: number;
    readonly role: string;
    readonly text: string;
    readonly ts: Date | string;
}

export interface EventToolCall {
    readonly id: string;
    readonly sourceTable?: "turn" | "tool_call";
    readonly name?: string | null;
    readonly text?: string | null;
    readonly ts?: Date | string | null;
}

export interface EventWindow {
    readonly key: string;
    readonly subjectType: ClassifierInputKind;
    readonly subjectId: string;
    readonly sessionId: string | null;
    readonly userTurn: EventTurn;
    readonly previousAssistantTurn: EventTurn | null;
    readonly recentToolCalls: readonly EventToolCall[];
    readonly recentToolFailures: readonly EventToolCall[];
    readonly recentFiles: readonly string[];
    readonly existingLabels: readonly string[];
}

export interface ClassifierResult {
    readonly key: string;
    readonly classifierKey: string;
    readonly classifierVersion: string;
    readonly subjectType: ClassifierInputKind;
    readonly subjectId: string;
    readonly sessionId: string | null;
    readonly turnId: string | null;
    readonly label: string;
    readonly target: string;
    readonly polarity: ClassifierPolarity;
    readonly durability: ClassifierDurability;
    readonly confidence: number;
    readonly method: ClassifierKind;
    readonly evidenceJson: string;
    readonly signals: readonly string[];
    readonly ts: Date | string;
}

export interface ClassifierDefinition {
    readonly key: string;
    readonly version: string;
    readonly kind: ClassifierKind;
    readonly description: string;
    readonly input: ClassifierInputKind;
    readonly labels: readonly string[];
    readonly targets: readonly string[];
    readonly classify: (input: EventWindow) => Effect.Effect<readonly ClassifierResult[], ClassifierInputError>;
}

export interface ClassifierResultKeyInput {
    readonly classifierKey: string;
    readonly classifierVersion: string;
    readonly subjectType: string;
    readonly subjectId: string;
    readonly label: string;
    readonly target: string;
}

export function classifierResultKey(input: ClassifierResultKeyInput): string {
    const stable = [
        input.classifierKey,
        input.classifierVersion,
        input.subjectType,
        input.subjectId,
        input.label,
        input.target,
    ].join("|");
    return [
        safeKeyPart(input.classifierKey),
        safeKeyPart(input.classifierVersion),
        safeKeyPart(input.subjectType),
        Bun.hash(stable).toString(16).slice(0, 16),
    ].join("__");
}

const clampConfidence = (value: number): number =>
    Math.max(0, Math.min(1, Number(value.toFixed(2))));

export function label(
    window: EventWindow,
    input: {
        readonly classifierKey: string;
        readonly classifierVersion: string;
        readonly label: string;
        readonly target: string;
        readonly polarity: ClassifierPolarity;
        readonly durability: ClassifierDurability;
        readonly confidence: number;
        readonly evidence: unknown;
        readonly signals?: readonly string[];
    },
): ClassifierResult {
    return {
        key: classifierResultKey({
            classifierKey: input.classifierKey,
            classifierVersion: input.classifierVersion,
            subjectType: window.subjectType,
            subjectId: window.subjectId,
            label: input.label,
            target: input.target,
        }),
        classifierKey: input.classifierKey,
        classifierVersion: input.classifierVersion,
        subjectType: window.subjectType,
        subjectId: window.subjectId,
        sessionId: window.sessionId,
        turnId: window.userTurn.id,
        label: input.label,
        target: input.target,
        polarity: input.polarity,
        durability: input.durability,
        confidence: clampConfidence(input.confidence),
        method: "heuristic",
        evidenceJson: JSON.stringify(input.evidence),
        signals: input.signals ?? [],
        ts: window.userTurn.ts,
    };
}

export function defineClassifier(definition: ClassifierDefinition): ClassifierDefinition {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(definition.key)) {
        throw new Error(`invalid classifier key: ${definition.key}`);
    }
    if (!/^\d+\.\d+\.\d+$/.test(definition.version)) {
        throw new Error(`invalid classifier version: ${definition.version}`);
    }
    return definition;
}

/**
 * One regex-driven branch of a heuristic classifier. `confidence` and `signals`
 * may be static or computed from the window + lowercased user text, mirroring the
 * per-rule variation the hand-written classifiers carried.
 */
export interface ClassifierPattern {
    readonly test: RegExp;
    readonly label: string;
    readonly target: string;
    /** Evidence tag passed to the (default or overridden) evidence builder. */
    readonly matched: string;
    readonly polarity: ClassifierPolarity;
    readonly durability: ClassifierDurability;
    readonly confidence: number | ((window: EventWindow, lower: string) => number);
    readonly signals?: readonly string[] | ((window: EventWindow, lower: string) => readonly string[]);
}

/**
 * Declarative config for {@link definePatternClassifier}. `labels`/`targets` are
 * intentionally absent: they are DERIVED from `patterns`, so a rule can never emit
 * a value `validateResult` rejects.
 */
export interface PatternClassifierConfig {
    readonly key: string;
    readonly version: string;
    readonly description: string;
    readonly patterns: readonly ClassifierPattern[];
    /** @default "heuristic" */
    readonly kind?: ClassifierKind;
    /** Skip control/context wrapper turns (subagent notifications, AGENTS.md, …). @default false */
    readonly skipControlText?: boolean;
    /** Override the evidence object. @default { user, previousAssistant, matched } */
    readonly evidence?: (window: EventWindow, matched: string) => Record<string, unknown>;
    /** "first" returns on the first matching pattern; "all" collects every match. @default "first" */
    readonly mode?: "first" | "all";
}

const defaultEvidence = (window: EventWindow, matched: string): Record<string, unknown> => ({
    user: window.userTurn.text,
    previousAssistant: window.previousAssistantTurn?.text ?? null,
    matched,
});

const dedupeOrdered = (values: readonly string[]): readonly string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
        if (!seen.has(value)) {
            seen.add(value);
            out.push(value);
        }
    }
    return out;
};

/**
 * Builds a heuristic {@link ClassifierDefinition} from a list of regex patterns,
 * collapsing the copy-pasted scaffold (trim → empty guard → optional control-text
 * guard → lowercase → first-match branches calling `label()`) into data.
 *
 * `labels` and `targets` are derived (deduped, stable order) from `patterns`, so
 * the declared-vs-emitted mismatch `validateResult` guards against is structurally
 * impossible. Delegates to {@link defineClassifier} so key/version validation and
 * the resulting shape stay identical to hand-written classifiers.
 */
export function definePatternClassifier(config: PatternClassifierConfig): ClassifierDefinition {
    const evidence = config.evidence ?? defaultEvidence;
    const skipControlText = config.skipControlText ?? false;
    const mode = config.mode ?? "first";

    const emit = (window: EventWindow, pattern: ClassifierPattern, lower: string): ClassifierResult => {
        const signals = typeof pattern.signals === "function"
            ? pattern.signals(window, lower)
            : pattern.signals;
        return label(window, {
            classifierKey: config.key,
            classifierVersion: config.version,
            label: pattern.label,
            target: pattern.target,
            polarity: pattern.polarity,
            durability: pattern.durability,
            confidence: typeof pattern.confidence === "function"
                ? pattern.confidence(window, lower)
                : pattern.confidence,
            evidence: evidence(window, pattern.matched),
            ...(signals !== undefined ? { signals } : {}),
        });
    };

    const classify = (window: EventWindow): readonly ClassifierResult[] => {
        const text = window.userTurn.text.trim();
        if (text.length === 0) return [];
        if (skipControlText && isControlOrContextText(text)) return [];
        const lower = text.toLowerCase();

        if (mode === "all") {
            const results: ClassifierResult[] = [];
            for (const pattern of config.patterns) {
                if (pattern.test.test(lower)) results.push(emit(window, pattern, lower));
            }
            return results;
        }

        for (const pattern of config.patterns) {
            if (pattern.test.test(lower)) return [emit(window, pattern, lower)];
        }
        return [];
    };

    return defineClassifier({
        key: config.key,
        version: config.version,
        kind: config.kind ?? "heuristic",
        description: config.description,
        input: "event_window",
        labels: dedupeOrdered(config.patterns.map((pattern) => pattern.label)),
        targets: dedupeOrdered(config.patterns.map((pattern) => pattern.target)),
        classify: (window) => Effect.succeed(classify(window)),
    });
}

const validateResult = (
    classifier: ClassifierDefinition,
    result: ClassifierResult,
): Effect.Effect<void, ClassifierInputError> =>
    Effect.suspend(() => {
        try {
        if (result.classifierKey !== classifier.key) {
            throw new Error(`result classifierKey ${result.classifierKey} did not match ${classifier.key}`);
        }
        if (result.classifierVersion !== classifier.version) {
            throw new Error(`result classifierVersion ${result.classifierVersion} did not match ${classifier.version}`);
        }
        if (!classifier.labels.includes(result.label)) {
            throw new Error(`classifier ${classifier.key} emitted undeclared label ${result.label}`);
        }
        if (!classifier.targets.includes(result.target)) {
            throw new Error(`classifier ${classifier.key} emitted undeclared target ${result.target}`);
        }
        if (!Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1) {
            throw new Error(`classifier ${classifier.key} emitted invalid confidence ${result.confidence}`);
        }
        // Option-based decode: the JSON document `null` is legal evidence
        // (evidence is typed `unknown`), only a *parse failure* is an error.
        if (Option.isNone(decodeJsonOption(result.evidenceJson))) {
            throw new Error(`classifier ${classifier.key} emitted evidenceJson that is not valid JSON`);
        }
            return Effect.void;
        } catch (error) {
            return Effect.fail(ClassifierInputError.make({
                classifierKey: classifier.key,
                message: error instanceof Error ? error.message : String(error),
            }));
        }
    });

export interface ClassifierRegistryShape {
    readonly all: () => readonly ClassifierDefinition[];
    readonly byKey: (key: string) => Option.Option<ClassifierDefinition>;
    readonly byKind: (kind: ClassifierKind) => readonly ClassifierDefinition[];
    readonly select: (keys: readonly string[]) => Effect.Effect<readonly ClassifierDefinition[], ClassifierNotFound>;
}

export class ClassifierRegistry extends Context.Service<ClassifierRegistry, ClassifierRegistryShape>()(
    "ax/ClassifierRegistry",
) {}

export const ClassifierRegistryLive = (
    classifiers: readonly ClassifierDefinition[],
): Layer.Layer<ClassifierRegistry> =>
    Layer.succeed(ClassifierRegistry, {
        all: () => classifiers,
        byKey: (key) => {
            const classifier = classifiers.find((candidate) => candidate.key === key);
            return classifier ? Option.some(classifier) : Option.none();
        },
        byKind: (kind) => classifiers.filter((classifier) => classifier.kind === kind),
        select: (keys) =>
            Effect.forEach(keys, (key) => {
                const classifier = classifiers.find((candidate) => candidate.key === key);
                return classifier
                    ? Effect.succeed(classifier)
                    : Effect.fail(ClassifierNotFound.make({ key }));
            }),
    });

export interface ClassifierRunnerShape {
    readonly runWindow: (input: {
        readonly window: EventWindow;
        readonly classifiers: readonly ClassifierDefinition[];
    }) => Effect.Effect<readonly ClassifierResult[], ClassifierInputError>;
    readonly runBatch: (input: {
        readonly windows: readonly EventWindow[];
        readonly classifiers: readonly ClassifierDefinition[];
    }) => Effect.Effect<readonly ClassifierResult[], ClassifierInputError>;
}

export class ClassifierRunner extends Context.Service<ClassifierRunner, ClassifierRunnerShape>()(
    "ax/ClassifierRunner",
) {}

const runWindowWith = (
    window: EventWindow,
    classifiers: readonly ClassifierDefinition[],
): Effect.Effect<readonly ClassifierResult[], ClassifierInputError> =>
    Effect.gen(function* () {
        const nested = yield* Effect.forEach(classifiers, (classifier) =>
            Effect.gen(function* () {
                const results = yield* classifier.classify(window);
                yield* Effect.forEach(results, (result) => validateResult(classifier, result), { discard: true });
                return results;
            }),
        );
        return nested.flat();
    });

export const ClassifierRunnerLive: Layer.Layer<ClassifierRunner> =
    Layer.succeed(ClassifierRunner, {
        runWindow: ({ window, classifiers }) => runWindowWith(window, classifiers),
        runBatch: ({ windows, classifiers }) =>
            Effect.gen(function* () {
                const nested = yield* Effect.forEach(windows, (window) =>
                    runWindowWith(window, classifiers),
                );
                return nested.flat();
            }),
    });
