import { cacheRow, jsonParam, tsParam } from "@ax/lib/duckdb/row";
import { stableId } from "@ax/lib/stable-id";
import type { ClassifierDefinition, ClassifierResult } from "./core.ts";

export interface ClassifierEvidenceRef {
    readonly resultKey: string;
    readonly table: "turn" | "tool_call" | "file";
    readonly key: string;
    readonly kind: string;
    readonly ts: Date | string;
}
export interface ClassifierPersistenceInput {
    readonly runKey: string; readonly startedAt: Date; readonly finishedAt: Date;
    readonly classifiers: readonly ClassifierDefinition[]; readonly results: readonly ClassifierResult[];
    readonly evidenceRefs?: readonly ClassifierEvidenceRef[]; readonly sinceDays?: number | undefined;
}

export const classifierDefinitionKey = (classifier: Pick<ClassifierDefinition, "key" | "version">): string =>
    stableId("classifier_definition", [classifier.key, classifier.version]);
export const classifierRunKey = (
    startedAt: Date,
    classifiers: readonly Pick<ClassifierDefinition, "key" | "version">[],
): string => stableId("classifier_run", [
    startedAt.toISOString(),
    classifiers.map((classifier) => `${classifier.key}@${classifier.version}`).sort().join("|"),
]);

export function classifierPersistenceRows(input: ClassifierPersistenceInput) {
    const evidenceByResult = new Map<string, ClassifierEvidenceRef[]>();
    for (const ref of input.evidenceRefs ?? []) {
        const refs = evidenceByResult.get(ref.resultKey) ?? [];
        refs.push(ref);
        evidenceByResult.set(ref.resultKey, refs);
    }
    const definitions = input.classifiers.map((classifier) => cacheRow({
        id: classifierDefinitionKey(classifier), classifier_key: classifier.key, version: classifier.version,
        kind: classifier.kind, description: classifier.description, input: classifier.input,
        labels: jsonParam(classifier.labels), targets: jsonParam(classifier.targets), updated_at: new Date(),
    }));
    const run = cacheRow({
        id: input.runKey, started_at: input.startedAt, finished_at: input.finishedAt, status: "completed",
        classifier_keys: jsonParam(input.classifiers.map((classifier) => `${classifier.key}@${classifier.version}`)),
        since_days: input.sinceDays ?? null,
        window_count: new Set(input.results.map((result) => result.subjectId)).size,
        result_count: input.results.length,
    });
    const results = input.results.map((result) => cacheRow({
        id: result.key,
        classifier_definition: classifierDefinitionKey({ key: result.classifierKey, version: result.classifierVersion }),
        classifier_run: input.runKey, classifier_key: result.classifierKey,
        classifier_version: result.classifierVersion, subject_type: result.subjectType,
        subject_id: result.subjectId, session: result.sessionId, turn: result.turnId,
        label: result.label, target: result.target, polarity: result.polarity,
        durability: result.durability, confidence: result.confidence, method: result.method,
        evidence_json: result.evidenceJson, signals: jsonParam(result.signals),
        ts: tsParam(result.ts), updated_at: new Date(),
    }));
    const classifications = input.results.flatMap((result) => result.turnId ? [cacheRow({
        id: stableId("has_classification", [result.turnId, result.key]), in_id: result.turnId,
        out_id: result.key, classifier_key: result.classifierKey, label: result.label,
        target: result.target, confidence: result.confidence, ts: tsParam(result.ts),
    })] : []);
    const citations = input.results.flatMap((result) => {
        const refs = [...(evidenceByResult.get(result.key) ?? [])];
        if (result.turnId) refs.unshift({
            resultKey: result.key, table: "turn", key: result.turnId,
            kind: "classified_turn", ts: result.ts,
        });
        return refs.map((ref) => cacheRow({
            id: stableId("cites_evidence", [result.key, ref.kind, ref.table, ref.key]),
            in_id: result.key, out_id: ref.key, in_table: "classifier_result", out_table: ref.table,
            count: 1, kind: ref.kind, ts: tsParam(ref.ts),
        }));
    });
    return { definitions, run, results, classifications, citations };
}
