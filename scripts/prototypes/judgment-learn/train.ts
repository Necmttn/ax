/**
 * Phase 5 prototype (#895), step 2: train the tiny model and run the ship
 * gate. Loads population.ndjson + labels/batch-*.labels.json, trains a
 * hand-rolled L2 logistic regression on a seeded 70/30 split, and reports
 * held-out accuracy/precision/recall/F1 for THREE detectors on the SAME
 * held-out set:
 *   regex       JUDGMENT_GUARD_RE on the turn's own text (the raw baseline)
 *   regex+carry regex on own text OR the previous assistant prose (the
 *               production judgmentSticky semantics, approximated)
 *   learned     the logistic model (regex features included - "regexes
 *               become features, never deleted first")
 * Also reports inter-labeler agreement (raw + Cohen's kappa) over the
 * double-labeled batches (labels/batch-N.labels-b.json).
 *
 * Run: bun scripts/prototypes/judgment-learn/train.ts
 */
import { readdirSync } from "node:fs";
import type { PopRow } from "./extract.ts";

const DIR = new URL(".", import.meta.url).pathname;

interface LabelRow { id: string; label: "judgment" | "routable"; confidence: number }

const popText = await Bun.file(`${DIR}population.ndjson`).text();
const pop = new Map<string, PopRow>();
for (const line of popText.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as PopRow;
    pop.set(row.id, row);
}

const labelFiles = readdirSync(`${DIR}labels`).filter((f) => /^batch-\d+\.labels\.json$/.test(f));
const labels = new Map<string, LabelRow>();
for (const f of labelFiles) {
    for (const l of (await Bun.file(`${DIR}labels/${f}`).json()) as LabelRow[]) labels.set(l.id, l);
}

// Inter-labeler agreement over the -b double-labeled batches.
const bFiles = readdirSync(`${DIR}labels`).filter((f) => /labels-b\.json$/.test(f));
let agree = 0, total = 0, bothJ = 0, aJ = 0, bJ = 0;
for (const f of bFiles) {
    for (const l of (await Bun.file(`${DIR}labels/${f}`).json()) as LabelRow[]) {
        const a = labels.get(l.id);
        if (!a) continue;
        total++;
        if (a.label === l.label) agree++;
        if (a.label === "judgment") aJ++;
        if (l.label === "judgment") bJ++;
        if (a.label === "judgment" && l.label === "judgment") bothJ++;
    }
}
const po = total > 0 ? agree / total : 0;
const pe = total > 0 ? (aJ / total) * (bJ / total) + ((total - aJ) / total) * ((total - bJ) / total) : 0;
const kappa = pe < 1 ? (po - pe) / (1 - pe) : 0;

// Feature vector. Regex hits are FEATURES (the plan: never deleted first).
const featurize = (r: PopRow): number[] => [
    1,
    Math.min(r.editCount, 8),
    Math.min(r.readCount, 8),
    Math.min(r.researchCount, 8),
    Math.min(r.otherToolCount, 8),
    Math.log1p(r.textLen) / 10,
    r.regexOwn ? 1 : 0,
    r.regexPrev ? 1 : 0,
    Math.min(r.questionMarks, 5),
    Math.min(r.codeFences, 5),
    r.toolNames.length > 0 ? 1 : 0,
    r.editCount + r.readCount + r.researchCount > 0
        ? r.editCount / (r.editCount + r.readCount + r.researchCount)
        : 0,
];
export const FEATURE_NAMES = [
    "bias", "editCount", "readCount", "researchCount", "otherToolCount",
    "logTextLen", "regexOwn", "regexPrev", "questionMarks", "codeFences",
    "hasTools", "editShare",
];

interface Example { x: number[]; y: number; row: PopRow }
const examples: Example[] = [];
for (const [id, l] of labels) {
    const row = pop.get(id);
    if (!row) continue;
    examples.push({ x: featurize(row), y: l.label === "judgment" ? 1 : 0, row });
}

// Seeded shuffle -> 70/30 split.
let seed = 0xc0ffee;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
for (let i = examples.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [examples[i], examples[j]] = [examples[j]!, examples[i]!];
}
const cut = Math.floor(examples.length * 0.7);
const train = examples.slice(0, cut);
const test = examples.slice(cut);

// L2 logistic regression, full-batch gradient descent. CPU milliseconds.
const dim = FEATURE_NAMES.length;
const w = new Array<number>(dim).fill(0);
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i]!, 0);
const L2 = 0.01, LR = 0.5, EPOCHS = 3000;
for (let e = 0; e < EPOCHS; e++) {
    const grad = new Array<number>(dim).fill(0);
    for (const ex of train) {
        const err = sigmoid(dot(w, ex.x)) - ex.y;
        for (let i = 0; i < dim; i++) grad[i]! += err * ex.x[i]!;
    }
    for (let i = 0; i < dim; i++) {
        w[i]! -= (LR / train.length) * (grad[i]! + L2 * (i === 0 ? 0 : w[i]!));
    }
}

interface Metrics { acc: number; precision: number; recall: number; f1: number; tp: number; fp: number; fn: number; tn: number }
const evaluate = (predict: (r: PopRow) => boolean, set: Example[]): Metrics => {
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const ex of set) {
        const p = predict(ex.row);
        if (p && ex.y === 1) tp++;
        else if (p && ex.y === 0) fp++;
        else if (!p && ex.y === 1) fn++;
        else tn++;
    }
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    return {
        acc: (tp + tn) / set.length,
        precision, recall,
        f1: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0,
        tp, fp, fn, tn,
    };
};

const learned = (r: PopRow) => sigmoid(dot(w, featurize(r))) >= 0.5;
const regex = (r: PopRow) => r.regexOwn;
const regexCarry = (r: PopRow) => r.regexOwn || r.regexPrev;

// One split is thin evidence at n=109. Repeat the whole train+matched-recall
// comparison over R random 70/30 splits and report the mean/sd of the
// precision gap at matched recall - the number the gate actually turns on.
const trainWeights = (set: Example[]): number[] => {
    const wr = new Array<number>(dim).fill(0);
    for (let e = 0; e < EPOCHS; e++) {
        const grad = new Array<number>(dim).fill(0);
        for (const ex of set) {
            const err = sigmoid(dot(wr, ex.x)) - ex.y;
            for (let i = 0; i < dim; i++) grad[i]! += err * ex.x[i]!;
        }
        for (let i = 0; i < dim; i++) {
            wr[i]! -= (LR / set.length) * (grad[i]! + L2 * (i === 0 ? 0 : wr[i]!));
        }
    }
    return wr;
};
const repeatedSplits = (repeats: number) => {
    const gaps: number[] = [];
    const recalls: number[] = [];
    for (let rep = 0; rep < repeats; rep++) {
        const shuffled = [...examples];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
        }
        const c = Math.floor(shuffled.length * 0.7);
        const tr = shuffled.slice(0, c);
        const te = shuffled.slice(c);
        const wr = trainWeights(tr);
        const target = evaluate((r) => r.regexOwn, te).recall;
        const regexPrecision = evaluate((r) => r.regexOwn, te).precision;
        let best: Metrics | null = null;
        for (let t = 0.95; t >= 0.05; t -= 0.05) {
            const m = evaluate((r) => sigmoid(dot(wr, featurize(r))) >= t, te);
            if (m.recall >= target) { best = m; break; }
        }
        if (best) { gaps.push(best.precision - regexPrecision); recalls.push(best.recall - target); }
    }
    const mean = gaps.reduce((s, v) => s + v, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((s, v) => s + (v - mean) ** 2, 0) / gaps.length);
    return {
        repeats: gaps.length,
        precisionGapMean: Math.round(mean * 1000) / 1000,
        precisionGapSd: Math.round(sd * 1000) / 1000,
        splitsWherePositive: gaps.filter((g) => g > 0).length,
        meanExtraRecall: Math.round((recalls.reduce((s, v) => s + v, 0) / recalls.length) * 1000) / 1000,
    };
};

const round = (m: Metrics) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === "number" ? Math.round(v * 1000) / 1000 : v]));

// The regex is a GUARD: it must over-flag (judgment misrouted to a cheap
// model is the expensive mistake), so the deciding comparison is not the
// default 0.5 threshold but the learned model AT THE REGEX'S RECALL: sweep
// the threshold, find the lowest one whose held-out recall >= the regex's,
// and compare precision there. Also report the sweep so the tradeoff is
// visible.
const sweep = (set: Example[]): { threshold: number; m: Metrics }[] => {
    const out: { threshold: number; m: Metrics }[] = [];
    for (let t = 0.05; t <= 0.95; t += 0.05) {
        const th = Math.round(t * 100) / 100;
        out.push({ threshold: th, m: evaluate((r) => sigmoid(dot(w, featurize(r))) >= th, set) });
    }
    return out;
};

console.log(JSON.stringify({
    labeled: examples.length,
    judgmentShare: Math.round((examples.filter((e) => e.y === 1).length / examples.length) * 1000) / 1000,
    train: train.length,
    test: test.length,
    labelerAgreement: { pairs: total, raw: Math.round(po * 1000) / 1000, kappa: Math.round(kappa * 1000) / 1000 },
    heldOut: {
        regex: round(evaluate(regex, test)),
        regexCarry: round(evaluate(regexCarry, test)),
        learned: round(evaluate(learned, test)),
    },
    heldOutSweep: sweep(test).map((s) => ({ t: s.threshold, ...round(s.m) })),
    matchedRecall: (() => {
        const target = evaluate(regex, test).recall;
        const candidates = sweep(test).filter((s) => s.m.recall >= target);
        const best = candidates.sort((a, b) => b.threshold - a.threshold)[0];
        return best ? { regexRecall: Math.round(target * 1000) / 1000, atThreshold: best.threshold, learned: round(best.m) } : null;
    })(),
    repeatedMatchedRecall: repeatedSplits(20),
    trainSet: {
        regex: round(evaluate(regex, train)),
        learned: round(evaluate(learned, train)),
    },
    weights: Object.fromEntries(FEATURE_NAMES.map((n, i) => [n, Math.round(w[i]! * 1000) / 1000])),
}, null, 1));
