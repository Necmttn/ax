import { safeKeyPart } from "../lib/shared/derive-keys.ts";
import {
    recordRef,
    surrealDate,
    surrealJsonText,
    surrealJsonTextOption,
    surrealObject,
    surrealOptionInt,
    surrealOptionRecord,
    surrealString,
} from "../lib/shared/surql.ts";
import type { ClassifierDefinition, ClassifierResult } from "./core.ts";

export interface ClassifierEvidenceRef {
    readonly resultKey: string;
    readonly table: "turn" | "tool_call" | "file";
    readonly key: string;
    readonly kind: string;
    readonly ts: Date | string;
}

export interface ClassifierPersistenceInput {
    readonly runKey: string;
    readonly startedAt: Date;
    readonly finishedAt: Date;
    readonly classifiers: readonly ClassifierDefinition[];
    readonly results: readonly ClassifierResult[];
    readonly evidenceRefs?: readonly ClassifierEvidenceRef[];
    readonly sinceDays?: number | undefined;
}

export const classifierDefinitionKey = (classifier: Pick<ClassifierDefinition, "key" | "version">): string =>
    `${safeKeyPart(classifier.key)}__${safeKeyPart(classifier.version)}`;

export const classifierRunKey = (
    startedAt: Date,
    classifiers: readonly Pick<ClassifierDefinition, "key" | "version">[],
): string => {
    const signature = classifiers.map((classifier) => `${classifier.key}@${classifier.version}`).sort().join("|");
    return `${startedAt.toISOString().replace(/[^0-9]/g, "").slice(0, 14)}__${Bun.hash(signature).toString(16).slice(0, 12)}`;
};

const buildClassifierDefinitionStatement = (classifier: ClassifierDefinition): string =>
    `UPSERT ${recordRef("classifier_definition", classifierDefinitionKey(classifier))} CONTENT ${surrealObject([
        ["classifier_key", surrealString(classifier.key)],
        ["version", surrealString(classifier.version)],
        ["kind", surrealString(classifier.kind)],
        ["description", surrealString(classifier.description)],
        ["input", surrealString(classifier.input)],
        ["labels", surrealJsonText(classifier.labels)],
        ["targets", surrealJsonText(classifier.targets)],
        ["updated_at", "time::now()"],
    ])};`;

const buildClassifierRunStatement = (input: ClassifierPersistenceInput): string =>
    `UPSERT ${recordRef("classifier_run", input.runKey)} CONTENT ${surrealObject([
        ["started_at", surrealDate(input.startedAt)],
        ["finished_at", surrealDate(input.finishedAt)],
        ["status", surrealString("completed")],
        ["classifier_keys", surrealJsonText(input.classifiers.map((classifier) => `${classifier.key}@${classifier.version}`))],
        ["since_days", surrealOptionInt(input.sinceDays)],
        ["window_count", String(new Set(input.results.map((result) => result.subjectId)).size)],
        ["result_count", String(input.results.length)],
    ])};`;

const resultEvidenceKey = (result: ClassifierResult): string =>
    `classifier_evidence__${safeKeyPart(Bun.hash(`${result.key}|turn`).toString(16))}`;

const evidenceEdgeKey = (ref: ClassifierEvidenceRef): string =>
    `classifier_evidence__${safeKeyPart(Bun.hash([
        ref.resultKey,
        ref.kind,
        ref.table,
        ref.key,
    ].join("|")).toString(16))}`;

const buildClassifierResultStatements = (
    runKey: string,
    result: ClassifierResult,
    evidenceRefs: readonly ClassifierEvidenceRef[],
): string[] => {
    const resultRef = recordRef("classifier_result", result.key);
    const resultStatement = `UPSERT ${resultRef} CONTENT ${surrealObject([
        ["classifier_definition", recordRef("classifier_definition", classifierDefinitionKey({ key: result.classifierKey, version: result.classifierVersion }))],
        ["classifier_run", recordRef("classifier_run", runKey)],
        ["classifier_key", surrealString(result.classifierKey)],
        ["classifier_version", surrealString(result.classifierVersion)],
        ["subject_type", surrealString(result.subjectType)],
        ["subject_id", surrealString(result.subjectId)],
        ["session", surrealOptionRecord("session", result.sessionId)],
        ["turn", surrealOptionRecord("turn", result.turnId)],
        ["label", surrealString(result.label)],
        ["target", surrealString(result.target)],
        ["polarity", surrealString(result.polarity)],
        ["durability", surrealString(result.durability)],
        ["confidence", result.confidence.toString()],
        ["method", surrealString(result.method)],
        ["evidence_json", surrealString(result.evidenceJson)],
        ["signals", surrealJsonTextOption(result.signals)],
        ["ts", surrealDate(result.ts)],
        ["updated_at", "time::now()"],
    ])};`;
    const statements = [resultStatement];
    statements.push(`DELETE cites_evidence WHERE in = ${resultRef};`);
    if (result.turnId) {
        const edgeKey = `${safeKeyPart(result.turnId)}__${safeKeyPart(result.key)}`;
        statements.push(
            `RELATE ${recordRef("turn", result.turnId)}->has_classification:\`${edgeKey}\`->${resultRef} SET classifier_key = ${surrealString(result.classifierKey)}, label = ${surrealString(result.label)}, target = ${surrealString(result.target)}, confidence = ${result.confidence.toString()}, ts = ${surrealDate(result.ts)};`,
            `RELATE ${resultRef}->cites_evidence:\`${resultEvidenceKey(result)}\`->${recordRef("turn", result.turnId)} SET count = 1, kind = ${surrealString("classified_turn")}, ts = ${surrealDate(result.ts)};`,
        );
    }
    for (const ref of evidenceRefs) {
        statements.push(
            `RELATE ${resultRef}->cites_evidence:\`${evidenceEdgeKey(ref)}\`->${recordRef(ref.table, ref.key)} SET count = 1, kind = ${surrealString(ref.kind)}, ts = ${surrealDate(ref.ts)};`,
        );
    }
    return statements;
};

export function buildClassifierPersistenceStatements(input: ClassifierPersistenceInput): string[] {
    const evidenceByResult = new Map<string, ClassifierEvidenceRef[]>();
    for (const ref of input.evidenceRefs ?? []) {
        const refs = evidenceByResult.get(ref.resultKey) ?? [];
        refs.push(ref);
        evidenceByResult.set(ref.resultKey, refs);
    }
    return [
        ...input.classifiers.map(buildClassifierDefinitionStatement),
        buildClassifierRunStatement(input),
        ...input.results.flatMap((result) => buildClassifierResultStatements(
            input.runKey,
            result,
            evidenceByResult.get(result.key) ?? [],
        )),
    ];
}
