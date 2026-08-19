/**
 * Phase 5 landed slice (#911) - the committed constants for the learned
 * judgment classifier, follow-up to the #895 prototype (GATE PASSED at
 * matched recall - scripts/prototypes/judgment-learn/README.md). DARK: only
 * `classifyTurn`'s `learned` parameter reads these, gated behind
 * `AX_JUDGMENT_MODEL=learned` in `fetchRoutability` (routability.ts). The
 * default path never touches this module.
 *
 * PROVENANCE. The #895 prototype's own gitignored population/label files
 * (`scripts/prototypes/judgment-learn/{population.ndjson,labels/}`) are
 * LOCAL artifacts that did not exist on the machine this landed slice was
 * built on - the prototype's PR (#896) never committed them, by design (the
 * README says "regenerate with extract.ts and re-label to reproduce"). So
 * rather than invent numbers, this seed is a FRESH end-to-end re-run of the
 * exact same pipeline against the live published snapshot on 2026-08-20:
 *
 *   1. `extract.ts` (READ-ONLY against the published DuckDB snapshot):
 *      47,263 decision-population turns, 120d window, stratified 360-turn
 *      sample (9 batches of 40: regexJudgment/toolRoutable/proseOther).
 *   2. Fresh LLM labeling: 9 parallel single-pass labelers (one per batch),
 *      same rubric as the original ("judge the WORK, not the vocabulary").
 *      UNLIKE the original study this pass was NOT double-labeled, so no
 *      fresh kappa figure exists - a real deviation from the original's
 *      93.8%/kappa=0.818 inter-labeler check, disclosed here rather than
 *      re-asserting the old number against new labels.
 *   3. `train.ts`, unmodified: seed 0xc0ffee, L2 logistic regression, 70/30
 *      split (251 train / 109 held out), 3000 epochs.
 *
 * HELD-OUT METRICS (this run, single canonical split):
 *   JUDGMENT_GUARD_RE      acc 0.743  precision 0.811  recall 0.588  F1 0.682
 *   learned @ matched recall (threshold 0.50)
 *                          acc 0.771  precision 0.825  recall 0.647  F1 0.725
 * Matched-recall search (lowest recall the regex already guarantees, highest
 * threshold that still clears it) landed at **0.50** for this fit - NOT the
 * original prototype's 0.35. Different labels are a different classifier;
 * pinning the old README's threshold against these weights would not
 * correspond to the same operating point, so this constant is the number
 * THIS fit's own matched-recall search produced, not a copied literal.
 *
 * Stability check (20 random 70/30 re-splits + re-fit + per-split matched-
 * recall search, mirroring the original's protocol): precision gap
 * **+8.3 points mean (sd 4.8), positive in 20/20 splits**, +7.1 points mean
 * extra recall. Smaller margin than the original prototype's +15.0pt/sd7.0
 * figure (expected - single-pass labels are noisier than the original's
 * double-labeled, independently-reviewed batches, and the live population
 * has moved since #895's run two days earlier) but the gate's own criterion
 * - positive in every one of 20 splits - still holds outright.
 *
 * `regexOwn` fit to a near-zero weight (-0.004) in this run, versus +0.43 in
 * the original prototype - a real difference worth a human's attention
 * before the operator flips AX_JUDGMENT_MODEL=learned; see the verdict
 * package on issue #911 for the full discussion. `regexPrev` (-0.378) and
 * the tool-composition/text-shape features otherwise read the same
 * direction as the original ("long prose / non-read tools / code fences
 * push toward judgment; edit-heavy composition pushes routable").
 *
 * Re-fit: bump `version` and re-run this file's provenance block. The
 * seeding function DELETE+INSERTs by (model_id, version) so a stale fit
 * never lingers next to a fresh one.
 */

/** Mirrors `FEATURE_NAMES` in scripts/prototypes/judgment-learn/train.ts -
 *  the feature vector order/shape the weights below were fit against. Kept
 *  here (not imported from the prototype dir) because a prototype is
 *  throwaway; this landed copy is the one production code depends on. */
export const JUDGMENT_FEATURE_NAMES = [
    "bias",
    "editCount",
    "readCount",
    "researchCount",
    "otherToolCount",
    "logTextLen",
    "regexOwn",
    "regexPrev",
    "questionMarks",
    "codeFences",
    "hasTools",
    "editShare",
] as const;

export interface JudgmentModelSeed {
    readonly modelId: string;
    readonly version: string;
    /** ISO date this fit was trained - stamped onto `classifier_weights.trained_at`. */
    readonly trainedAt: string;
    readonly threshold: number;
    readonly weights: Readonly<Record<string, number>>;
}

export const JUDGMENT_MODEL_SEED: JudgmentModelSeed = {
    modelId: "judgment-v1",
    version: "2026-08-20-seed0xc0ffee-refit1",
    trainedAt: "2026-08-20T00:00:00Z",
    threshold: 0.5,
    weights: {
        bias: -3.473,
        editCount: -0.782,
        readCount: 0,
        researchCount: 0,
        otherToolCount: 1.34,
        logTextLen: 7.336,
        regexOwn: -0.004,
        regexPrev: -0.378,
        questionMarks: -0.099,
        codeFences: 1.065,
        hasTools: 0.558,
        editShare: -0.782,
    },
};
