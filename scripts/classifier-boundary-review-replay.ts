#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { Effect } from "effect";
import { ClassifierRunner, ClassifierRunnerLive, type ClassifierResult } from "../src/classifiers/core.ts";
import { correctionEventClassifier } from "../src/classifiers/correction-event/index.ts";
import { windowFixture } from "../src/classifiers/test-fixtures.ts";

interface BoundaryReviewItem {
    readonly id?: unknown;
    readonly actual?: unknown;
    readonly current_label?: unknown;
    readonly target?: unknown;
    readonly text_excerpt?: unknown;
}

interface BoundaryReview {
    readonly schema?: unknown;
    readonly source_analysis_decision?: unknown;
    readonly items?: unknown;
}

export interface BoundaryReplayRow {
    readonly id: string;
    readonly actual: string;
    readonly current_label: string;
    readonly target: string;
    readonly text_excerpt: string;
    readonly deterministic_results: readonly {
        readonly classifier_key: string;
        readonly label: string;
        readonly target: string;
        readonly confidence: number;
        readonly signals: readonly string[];
    }[];
    readonly covered_by_deterministic: boolean;
}

export interface BoundaryReplayReport {
    readonly schema: "ax.boundary_review_deterministic_replay.v1";
    readonly review_path: string;
    readonly source_schema?: string;
    readonly source_analysis_decision?: string;
    readonly classifier_key: "correction-event";
    readonly items: number;
    readonly covered_by_deterministic: number;
    readonly uncovered: number;
    readonly coverage_rate: number;
    readonly rows: readonly BoundaryReplayRow[];
    readonly decision: "deterministic_boundary_replay_complete" | "deterministic_boundary_replay_has_gaps";
}

const stringValue = (value: unknown): string =>
    typeof value === "string" ? value : "";

const itemRows = (review: BoundaryReview): BoundaryReviewItem[] =>
    Array.isArray(review.items) ? review.items.filter((item): item is BoundaryReviewItem => typeof item === "object" && item !== null) : [];

const resultSummary = (result: ClassifierResult) => ({
    classifier_key: result.classifierKey,
    label: result.label,
    target: result.target,
    confidence: result.confidence,
    signals: result.signals,
});

const expectedCoarse = (item: BoundaryReviewItem): string =>
    stringValue(item.current_label) === "correction" || stringValue(item.actual) === "correction_or_rejection_signal"
        ? "correction"
        : stringValue(item.current_label);

export async function buildBoundaryReplayReport(input: {
    readonly reviewPath: string;
    readonly review: BoundaryReview;
}): Promise<BoundaryReplayReport> {
    const rows: BoundaryReplayRow[] = [];
    for (const item of itemRows(input.review)) {
        const id = stringValue(item.id);
        const text = stringValue(item.text_excerpt);
        const results = await Effect.runPromise(Effect.gen(function* () {
            const runner = yield* ClassifierRunner;
            return yield* runner.runWindow({
                window: windowFixture({ user: text }),
                classifiers: [correctionEventClassifier],
            });
        }).pipe(Effect.provide(ClassifierRunnerLive)));
        const expectedLabel = expectedCoarse(item);
        const expectedTarget = stringValue(item.target);
        const covered = results.some((result) =>
            result.classifierKey === "correction-event" &&
            result.label === expectedLabel &&
            (expectedTarget.length === 0 || result.target === expectedTarget)
        );
        rows.push({
            id,
            actual: stringValue(item.actual),
            current_label: stringValue(item.current_label),
            target: stringValue(item.target),
            text_excerpt: text,
            deterministic_results: results.map(resultSummary),
            covered_by_deterministic: covered,
        });
    }
    const covered = rows.filter((row) => row.covered_by_deterministic).length;
    const coverageRate = rows.length === 0 ? 0 : Number((covered / rows.length).toFixed(4));
    return {
        schema: "ax.boundary_review_deterministic_replay.v1",
        review_path: input.reviewPath,
        ...(typeof input.review.schema === "string" ? { source_schema: input.review.schema } : {}),
        ...(typeof input.review.source_analysis_decision === "string" ? { source_analysis_decision: input.review.source_analysis_decision } : {}),
        classifier_key: "correction-event",
        items: rows.length,
        covered_by_deterministic: covered,
        uncovered: rows.length - covered,
        coverage_rate: coverageRate,
        rows,
        decision: covered === rows.length ? "deterministic_boundary_replay_complete" : "deterministic_boundary_replay_has_gaps",
    };
}

const main = async (): Promise<number> => {
    const args = parseArgs({
        options: {
            review: { type: "string" },
            out: { type: "string" },
            json: { type: "boolean", default: false },
        },
    });
    const reviewPath = args.values.review ?? ".ax/experiments/boundary-miss-review-workflow-candidate-current.json";
    const out = args.values.out ?? ".ax/experiments/boundary-review-deterministic-replay-current.json";
    const review = JSON.parse(readFileSync(reviewPath, "utf8")) as BoundaryReview;
    const report = await buildBoundaryReplayReport({ reviewPath, review });
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    if (args.values.json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        console.log("boundary review deterministic replay");
        console.log(`items: ${report.items}`);
        console.log(`covered: ${report.covered_by_deterministic}`);
        console.log(`uncovered: ${report.uncovered}`);
        console.log(`decision: ${report.decision}`);
    }
    return report.uncovered === 0 ? 0 : 1;
};

if (import.meta.main) {
    const code = await main();
    process.exit(code);
}
