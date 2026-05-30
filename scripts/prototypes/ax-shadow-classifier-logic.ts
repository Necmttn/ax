export type ShadowPolarity = "accept" | "reject" | "revise" | "explore" | "none";

export interface TurnLabelRow {
    readonly row_type: "turn_label_row";
    readonly turn_id: string;
    readonly session_id: string;
    readonly seq: number;
    readonly source: string | null;
    readonly role: string;
    readonly message_kind: string | null;
    readonly intent_kind: string | null;
    readonly text_excerpt: string;
    readonly text: string;
    readonly previous_assistant_turn_id: string | null;
    readonly previous_assistant_text: string | null;
    readonly act: string;
    readonly sentiment: string;
    readonly polarity: ShadowPolarity;
    readonly confidence: number;
    readonly signals: readonly string[];
    readonly semantic_kind: string | null;
    readonly semantic_label: string | null;
    readonly canonical_text: string | null;
    readonly ts: string | null;
    readonly session_started_at: string | null;
    readonly cwd: string | null;
}

export interface ReactionPairRow {
    readonly row_type: "reaction_pair_row";
    readonly reacts_to_id: string;
    readonly user_turn_id: string;
    readonly assistant_turn_id: string;
    readonly session_id: string;
    readonly source: string | null;
    readonly user_text: string;
    readonly assistant_text: string;
    readonly polarity: ShadowPolarity;
    readonly act: string;
    readonly semantic_label: string | null;
    readonly confidence: number;
    readonly seq_distance: number | null;
    readonly time_delta_seconds: number | null;
}

export type ShadowRow = TurnLabelRow | ReactionPairRow;

export const FEATURE_NAMES = [
    "bias",
    "char_len",
    "word_count",
    "has_no",
    "has_yes",
    "has_but",
    "has_instead",
    "has_wrong",
    "has_keep",
    "has_question",
    "has_negation",
    "has_approval",
    "has_revision",
    "confidence",
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];
export type FeatureVector = Record<FeatureName, number>;

const safeText = (value: unknown): string =>
    typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);

export function parseSignals(raw: unknown): readonly string[] {
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw !== "string" || raw.trim() === "") return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
        return [];
    }
}

export function reactionLabelFor(row: Pick<TurnLabelRow, "polarity">): 0 | 1 {
    return row.polarity === "accept" || row.polarity === "reject" || row.polarity === "revise" ? 1 : 0;
}

export function polarityLabelFor(row: Pick<TurnLabelRow, "polarity">): 0 | 1 | 2 | null {
    if (row.polarity === "accept") return 0;
    if (row.polarity === "reject") return 1;
    if (row.polarity === "revise") return 2;
    return null;
}

export function featuresForText(textInput: string, confidenceInput: number): FeatureVector {
    const text = safeText(textInput);
    const lower = text.toLowerCase();
    const words = lower.match(/[a-z0-9_']+/g) ?? [];
    const has = (pattern: RegExp): number => pattern.test(lower) ? 1 : 0;
    return {
        bias: 1,
        char_len: Math.min(text.length, 1200) / 1200,
        word_count: Math.min(words.length, 220) / 220,
        has_no: has(/\b(no|nope|nah)\b/),
        has_yes: has(/\b(yes|yeah|yep|correct|right|good|works|ship)\b/),
        has_but: has(/\bbut\b/),
        has_instead: has(/\b(instead|rather|more like)\b/),
        has_wrong: has(/\b(wrong|not that|not this|mistake|incorrect)\b/),
        has_keep: has(/\b(keep|sidecar|prototype|do not touch|don't touch)\b/),
        has_question: has(/\?/),
        has_negation: has(/\b(no|not|don't|do not|never|without|stop)\b/),
        has_approval: has(/\b(yes|exactly|perfect|ship|great|nice|works)\b/),
        has_revision: has(/\b(instead|change|revise|should|need|missing|include|make it|keep)\b/),
        confidence: Number.isFinite(confidenceInput) ? Math.max(0, Math.min(1, confidenceInput)) : 0,
    };
}

export function featureArray(features: FeatureVector): number[] {
    return FEATURE_NAMES.map((name) => features[name]);
}

export interface EvalExample {
    readonly session_id: string;
    readonly text: string;
    readonly confidence: number;
    readonly label: number;
}

export interface ClassifierModel {
    readonly labels: readonly number[];
    readonly centroids: ReadonlyMap<number, readonly number[]>;
    readonly majority: number;
}

export interface EvaluationResult {
    readonly rows: number;
    readonly trainRows: number;
    readonly testRows: number;
    readonly majorityLabel: number;
    readonly majorityMacroF1: number;
    readonly classifierMacroF1: number;
    readonly improvement: number;
}

function dotDistance(a: readonly number[], b: readonly number[]): number {
    let sum = 0;
    for (let i = 0; i < a.length; i += 1) {
        const delta = (a[i] ?? 0) - (b[i] ?? 0);
        sum += delta * delta;
    }
    return sum;
}

export function trainCentroidClassifier(examples: readonly EvalExample[]): ClassifierModel {
    const grouped = new Map<number, number[][]>();
    for (const example of examples) {
        const vector = featureArray(featuresForText(example.text, example.confidence));
        const rows = grouped.get(example.label) ?? [];
        rows.push(vector);
        grouped.set(example.label, rows);
    }
    const labels = [...grouped.keys()].sort((a, b) => a - b);
    const centroids = new Map<number, readonly number[]>();
    let majority = labels[0] ?? 0;
    let majorityCount = -1;
    for (const label of labels) {
        const rows = grouped.get(label) ?? [];
        if (rows.length > majorityCount) {
            majority = label;
            majorityCount = rows.length;
        }
        centroids.set(label, FEATURE_NAMES.map((_, index) =>
            rows.reduce((sum, row) => sum + (row[index] ?? 0), 0) / Math.max(1, rows.length),
        ));
    }
    return { labels, centroids, majority };
}

export function predictCentroid(model: ClassifierModel, text: string, confidence: number): number {
    const vector = featureArray(featuresForText(text, confidence));
    let bestLabel = model.majority;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const label of model.labels) {
        const centroid = model.centroids.get(label);
        if (!centroid) continue;
        const distance = dotDistance(vector, centroid);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestLabel = label;
        }
    }
    return bestLabel;
}

export function macroF1(labels: readonly number[], predictions: readonly number[], allLabels: readonly number[]): number {
    if (labels.length !== predictions.length) throw new Error("labels and predictions length mismatch");
    if (labels.length === 0) return 0;
    const scores = allLabels.map((label) => {
        let tp = 0;
        let fp = 0;
        let fn = 0;
        for (let i = 0; i < labels.length; i += 1) {
            const actual = labels[i];
            const predicted = predictions[i];
            if (actual === label && predicted === label) tp += 1;
            if (actual !== label && predicted === label) fp += 1;
            if (actual === label && predicted !== label) fn += 1;
        }
        const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
        const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
        return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    });
    return scores.reduce((sum, score) => sum + score, 0) / Math.max(1, scores.length);
}

export function sessionHeldOutSplit(
    examples: readonly EvalExample[],
    testRatio = 0.25,
): { readonly train: readonly EvalExample[]; readonly test: readonly EvalExample[] } {
    const sessions = [...new Set(examples.map((example) => example.session_id))].sort();
    const testCount = Math.max(1, Math.floor(sessions.length * testRatio));
    const testSessions = new Set(sessions.filter((_, index) => index % Math.max(1, Math.floor(sessions.length / testCount)) === 0).slice(0, testCount));
    const test = examples.filter((example) => testSessions.has(example.session_id));
    const train = examples.filter((example) => !testSessions.has(example.session_id));
    return test.length === 0 || train.length === 0
        ? { train: examples.slice(0, Math.max(1, examples.length - 1)), test: examples.slice(Math.max(1, examples.length - 1)) }
        : { train, test };
}

export function evaluateCentroid(examples: readonly EvalExample[], allLabels: readonly number[]): EvaluationResult {
    const { train, test } = sessionHeldOutSplit(examples);
    const model = trainCentroidClassifier(train);
    const labels = test.map((example) => example.label);
    const majorityPredictions = test.map(() => model.majority);
    const classifierPredictions = test.map((example) => predictCentroid(model, example.text, example.confidence));
    const majorityMacroF1 = macroF1(labels, majorityPredictions, allLabels);
    const classifierMacroF1 = macroF1(labels, classifierPredictions, allLabels);
    return {
        rows: examples.length,
        trainRows: train.length,
        testRows: test.length,
        majorityLabel: model.majority,
        majorityMacroF1,
        classifierMacroF1,
        improvement: classifierMacroF1 - majorityMacroF1,
    };
}

export function toEvalExamples(rows: readonly TurnLabelRow[], task: "reaction" | "polarity"): EvalExample[] {
    return rows.flatMap((row) => {
        if (row.role !== "user") return [];
        if (task === "reaction") {
            return [{
                session_id: row.session_id,
                text: row.text || row.text_excerpt,
                confidence: row.confidence,
                label: reactionLabelFor(row),
            }];
        }
        const label = polarityLabelFor(row);
        if (label === null) return [];
        return [{
            session_id: row.session_id,
            text: row.text || row.text_excerpt,
            confidence: row.confidence,
            label,
        }];
    });
}
