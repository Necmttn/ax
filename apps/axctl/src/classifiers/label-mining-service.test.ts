import { describe, expect, test } from "bun:test";
import { Effect, type FileSystem, Layer, type Path, Schema } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxConfigTest } from "@ax/lib/config";
import { CacheRead, CacheReadLayer } from "@ax/lib/duckdb/seam";
import { makeTestCacheRead } from "@ax/lib/testing/cache";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { EmptyJudgmentTestLayer, judgmentTestLayer } from "../testing/judgment-test-layer.ts";
import type { Judgment } from "@ax/lib/sqlite";
import {
    EXPORT_REVIEW_LIMIT,
    LabelMiningService,
    LabelMiningServiceLive,
    type LabelMiningGraphProjectionReport,
} from "./label-mining-service.ts";

/**
 * Persisted-turn fake rows. The service reads transcript windows from the
 * `turn` table; the projection shape is `{ window_key, subject_id, session_id,
 * user_turn_id, user_seq, user_role, user_message_kind, user_text,
 * user_evidence_path, prev_turn_id, prev_text, prev_evidence_path }`.
 */
interface FakeWindowRow {
    readonly window_key: string;
    readonly subject_id: string;
    readonly session_id: string | null;
    readonly user_turn_id: string;
    readonly user_seq?: number;
    readonly user_role?: string;
    readonly user_message_kind?: string | null;
    readonly user_text: string;
    readonly user_evidence_path?: string | null;
    readonly prev_turn_id?: string | null;
    readonly prev_text?: string | null;
    readonly prev_evidence_path?: string | null;
}

/**
 * All window fixtures below carry `prev_turn_id`/`prev_text` inline, which is
 * exactly the case `miningReport` treats as "already has a previous turn" (see
 * the merge loop's comment in label-mining-service.ts) - so the service never
 * fires the second (prev-turn batch) query, and one canned response is enough.
 */
function windowsCacheRead(rows: readonly FakeWindowRow[]) {
    return makeTestCacheRead({ fallback: rows });
}

const runWithDb = <A>(
    effect: Effect.Effect<
        A,
        unknown,
        LabelMiningService | CacheRead | Judgment | FileSystem.FileSystem | Path.Path
    >,
    cacheReadLayer: Layer.Layer<CacheRead>,
): Promise<A> =>
    Effect.runPromise(effect.pipe(Effect.provide(LabelMiningServiceLive.pipe(
        Layer.provideMerge(Layer.mergeAll(
            cacheReadLayer,
            EmptyJudgmentTestLayer,
            BunFileSystem.layer,
            BunPath.layer,
        )),
    ))) as Effect.Effect<A, unknown>);

const correctionWindow = (n: number): FakeWindowRow => ({
    window_key: `w-corr-${n}`,
    subject_id: `turn:c${n}`,
    session_id: `session:s${n}`,
    user_turn_id: `turn:c${n}`,
    user_seq: n,
    user_role: "user",
    user_message_kind: "task",
    user_text: "no, that's wrong, revert it",
    user_evidence_path: `transcript:/s${n}.jsonl#c${n}`,
    prev_turn_id: `turn:c${n}-prev`,
    prev_text: "I edited the config file.",
    prev_evidence_path: `transcript:/s${n}.jsonl#c${n}-prev`,
});

const directionWindow = (n: number): FakeWindowRow => ({
    window_key: `w-dir-${n}`,
    subject_id: `turn:d${n}`,
    session_id: `session:s${n}`,
    user_turn_id: `turn:d${n}`,
    user_seq: n,
    user_role: "user",
    user_message_kind: "task",
    user_text: "use uv for the python deps",
    user_evidence_path: `transcript:/s${n}.jsonl#d${n}`,
    prev_turn_id: `turn:d${n}-prev`,
    prev_text: "I ran pip install.",
    prev_evidence_path: `transcript:/s${n}.jsonl#d${n}-prev`,
});

const verificationWindow = (n: number): FakeWindowRow => ({
    window_key: `w-ver-${n}`,
    subject_id: `turn:v${n}`,
    session_id: `session:s${n}`,
    user_turn_id: `turn:v${n}`,
    user_seq: n,
    user_role: "user",
    user_message_kind: "task",
    user_text: "did you run the tests?",
    user_evidence_path: `transcript:/s${n}.jsonl#v${n}`,
});

const approvalWindow = (n: number): FakeWindowRow => ({
    window_key: `w-app-${n}`,
    subject_id: `turn:a${n}`,
    session_id: `session:s${n}`,
    user_turn_id: `turn:a${n}`,
    user_seq: n,
    user_role: "user",
    user_message_kind: "task",
    user_text: "lgtm ship it",
    user_evidence_path: `transcript:/s${n}.jsonl#a${n}`,
});

describe("LabelMiningService.miningReport", () => {
    test("reads transcript windows from persisted turns", async () => {
        const tc = windowsCacheRead([correctionWindow(1)]);
        await runWithDb(
            Effect.gen(function* () {
                const svc = yield* LabelMiningService;
                return yield* svc.miningReport({ sinceDays: 14, limit: 500, reviewLimit: 80 });
            }),
            tc.layer,
        );

        expect(tc.captured.at(-1)).toContain("FROM turn");
        expect(tc.captured.at(-1)).toMatch(/role\s*=\s*['"]user['"]/);
    });

    test("exports review rows sorted by weak confidence and diversified by family", async () => {
        const rows = [
            // approval has lower confidence than correction/direction/verification
            approvalWindow(1),
            correctionWindow(2),
            verificationWindow(3),
            directionWindow(4),
        ];

        const report = await runWithDb(
            Effect.gen(function* () {
                const svc = yield* LabelMiningService;
                return yield* svc.miningReport({ sinceDays: 14, limit: 500, reviewLimit: 80 });
            }),
            windowsCacheRead(rows).layer,
        );

        expect(report.schema).toBe("ax.transcript_label_mining_report.v1");
        // First row is the highest-confidence family (verification 0.84).
        expect(report.review_rows[0]?.label_family).toBe("verification");
        // Confidence is non-increasing within the first occurrence of each family.
        const confidences = report.review_rows.map((row) => row.weak_confidence);
        // At least 4 distinct families present.
        const families = new Set(report.review_rows.map((row) => row.label_family));
        expect(families.size).toBeGreaterThanOrEqual(4);
        // Diversity ordering: every family appears within the first N rows
        // before any family repeats (round-robin by confidence).
        expect(report.review_diversity.label_family_count).toBeGreaterThanOrEqual(4);
        // Confidence is globally sane (all > 0).
        expect(confidences.every((c) => c > 0)).toBe(true);
    });

    test("caps exported review rows at 80", async () => {
        // 200 correction windows -> only 80 may be exported.
        const rows: FakeWindowRow[] = [];
        for (let i = 0; i < 200; i += 1) rows.push(correctionWindow(i));

        const report = await runWithDb(
            Effect.gen(function* () {
                const svc = yield* LabelMiningService;
                return yield* svc.miningReport({ sinceDays: 14, limit: 500, reviewLimit: 500 });
            }),
            windowsCacheRead(rows).layer,
        );

        expect(EXPORT_REVIEW_LIMIT).toBe(80);
        expect(report.review_rows.length).toBeLessThanOrEqual(80);
        expect(report.candidate_count).toBe(200);
    });

    test("every exported row has candidate id, evidence, prev excerpt, and pending review fields", async () => {
        const report = await runWithDb(
            Effect.gen(function* () {
                const svc = yield* LabelMiningService;
                return yield* svc.miningReport({ sinceDays: 14, limit: 500, reviewLimit: 80 });
            }),
            windowsCacheRead([correctionWindow(1), directionWindow(2)]).layer,
        );

        expect(report.review_rows.length).toBeGreaterThan(0);
        for (const row of report.review_rows) {
            expect(typeof row.candidate_id).toBe("string");
            expect(row.candidate_id.length).toBeGreaterThan(0);
            expect(row.evidence_paths.length).toBeGreaterThan(0);
            expect(typeof row.previous_assistant_excerpt).toBe("string");
            expect((row.previous_assistant_excerpt ?? "").length).toBeGreaterThan(0);
            expect(row.review_status).toBe("pending");
            expect(row.reviewed_label).toBeUndefined();
            expect(row.reviewer).toBe("");
        }
    });

    test("limits the candidate mine to the requested limit before review cap", async () => {
        const rows: FakeWindowRow[] = [];
        for (let i = 0; i < 50; i += 1) rows.push(correctionWindow(i));

        const report = await runWithDb(
            Effect.gen(function* () {
                const svc = yield* LabelMiningService;
                return yield* svc.miningReport({ sinceDays: 14, limit: 10, reviewLimit: 80 });
            }),
            windowsCacheRead(rows).layer,
        );

        expect(report.candidate_count).toBe(10);
    });
});

describe("LabelMiningService.writeMiningReport", () => {
    test("writes the report to the requested path", async () => {
        const out = join(mkdtempSync(join(tmpdir(), "ax-label-mining-")), "nested", "report.json");

        const report = await runWithDb(
            Effect.gen(function* () {
                const svc = yield* LabelMiningService;
                return yield* svc.writeMiningReport({ sinceDays: 14, limit: 500, reviewLimit: 80, out });
            }),
            windowsCacheRead([correctionWindow(1), directionWindow(2), verificationWindow(3)]).layer,
        );

        const saved = JSON.parse(readFileSync(out, "utf8"));
        expect(saved.schema).toBe("ax.transcript_label_mining_report.v1");
        expect(saved.review_rows.length).toBe(report.review_rows.length);
        expect(saved.out_path).toBe(out);
    });
});

// `projectReviewed({ apply: true })` writes through `withConfigWrite` (the
// real DuckDB seam), so its round trip needs a working libduckdb - the review
// + vector inputs come from fakes (judgment/CacheRead), since only the WRITE
// path is what this chunk ported.
const { dylibPath: labelMiningDylibPath, dtest: labelMiningDuckdbTest, tempDir: labelMiningTempDir } =
    await duckdbTestSetup("label mining service projectReviewed apply", { requireFts: true });


describe("LabelMiningService.projectReviewed", () => {
    labelMiningDuckdbTest(
        "applies an accepted review, round-tripping graph facts into DuckDB",
        async () => {
            const dataDir = labelMiningTempDir("ax-label-mining-apply-");
            const snapshotPath = join(dataDir, "test-snapshot.duckdb");
            const previousSnapshotEnv = process.env.AX_DUCKDB_SNAPSHOT;
            process.env.AX_DUCKDB_SNAPSHOT = snapshotPath;
            try {
                const reviewRow = {
                    candidate_id: "c1",
                    graph_fact_id: null,
                    label_family: "correction",
                    review_status: "accepted",
                    promotion_safe: true,
                    reviewed_label: "correction",
                    reviewed_target: null,
                    reviewer: "test-reviewer",
                    rationale: "looks right",
                    evidence_paths_json: JSON.stringify(["transcript:/s1.jsonl#c1"]),
                    updated_at: new Date("2026-01-01T00:00:00Z"),
                };
                const fakeJudgment = judgmentTestLayer(() => [reviewRow]);
                const fakeCacheRead = makeTestCacheRead({ fallback: [] });

                const program = Effect.gen(function* () {
                    const svc = yield* LabelMiningService;
                    return yield* svc.projectReviewed({ apply: true });
                }).pipe(
                    Effect.provide(LabelMiningServiceLive.pipe(
                        Layer.provideMerge(Layer.mergeAll(
                            fakeCacheRead.layer,
                            fakeJudgment,
                            BunFileSystem.layer,
                            BunPath.layer,
                        )),
                    )),
                    Effect.provide(AxConfigTest({ paths: { dataDir } })),
                    // AxConfigTest itself needs FileSystem - the copy merged
                    // into LabelMiningServiceLive above is consumed entirely by
                    // that layer's own construction, so it does not propagate
                    // outward to satisfy this later stage.
                    Effect.provide(BunFileSystem.layer),
                );
                const report = await Effect.runPromise(
                    program as Effect.Effect<LabelMiningGraphProjectionReport, unknown>,
                );

                expect(report.applied).toBe(true);
                expect(report.accepted_count).toBe(1);
                expect(report.node_count).toBeGreaterThanOrEqual(1);

                const readLayer = CacheReadLayer({
                    snapshotPath,
                    ...(labelMiningDylibPath === null ? {} : { assetPath: labelMiningDylibPath }),
                });
                const nodes = await Effect.runPromise(Effect.gen(function* () {
                    const read = yield* CacheRead;
                    return yield* read.rows(
                        Schema.Struct({ id: Schema.String, source_kind: Schema.String }),
                        "SELECT id, source_kind FROM classifier_graph_node WHERE source_kind = ?",
                        ["transcript_label_mining_reviewed"],
                    );
                }).pipe(Effect.provide(readLayer)) as Effect.Effect<
                    ReadonlyArray<{ readonly id: string; readonly source_kind: string }>,
                    unknown
                >);
                expect(nodes.length).toBeGreaterThanOrEqual(1);
                expect(nodes.every((row) => row.source_kind === "transcript_label_mining_reviewed")).toBe(true);
            } finally {
                if (previousSnapshotEnv === undefined) delete process.env.AX_DUCKDB_SNAPSHOT;
                else process.env.AX_DUCKDB_SNAPSHOT = previousSnapshotEnv;
            }
        },
    );
});
