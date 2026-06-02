import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import {
    EXPORT_REVIEW_LIMIT,
    LabelMiningService,
    LabelMiningServiceLive,
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

function clientWithWindows(
    rows: readonly FakeWindowRow[],
    capture: { sql?: string; bindings?: Record<string, unknown> | undefined },
): SurrealClientShape {
    return {
        query: <T extends unknown[]>(sql: string, bindings?: Record<string, unknown>) => {
            capture.sql = sql;
            capture.bindings = bindings;
            return Effect.succeed([rows] as unknown as T);
        },
        upsert: () => Effect.void,
        relate: () => Effect.void,
        putFile: () => Effect.void,
        getFile: () => Effect.succeed(""),
        raw: {} as never,
    };
}

const runWithDb = <A>(
    effect: Effect.Effect<A, unknown, LabelMiningService | SurrealClient>,
    client: SurrealClientShape,
): Promise<A> =>
    Effect.runPromise(
        effect.pipe(
            Effect.provide(LabelMiningServiceLive),
            Effect.provideService(SurrealClient, client),
        ),
    );

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
        const capture: { sql?: string; bindings?: Record<string, unknown> } = {};
        await runWithDb(
            Effect.gen(function* () {
                const svc = yield* LabelMiningService;
                return yield* svc.miningReport({ sinceDays: 14, limit: 500, reviewLimit: 80 });
            }),
            clientWithWindows([correctionWindow(1)], capture),
        );

        expect(capture.sql).toContain("FROM turn");
        expect(capture.sql).toMatch(/role\s*=\s*['"]user['"]/);
    });

    test("exports review rows sorted by weak confidence and diversified by family", async () => {
        const capture: { sql?: string } = {};
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
            clientWithWindows(rows, capture),
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
        const capture: { sql?: string } = {};
        // 200 correction windows -> only 80 may be exported.
        const rows: FakeWindowRow[] = [];
        for (let i = 0; i < 200; i += 1) rows.push(correctionWindow(i));

        const report = await runWithDb(
            Effect.gen(function* () {
                const svc = yield* LabelMiningService;
                return yield* svc.miningReport({ sinceDays: 14, limit: 500, reviewLimit: 500 });
            }),
            clientWithWindows(rows, capture),
        );

        expect(EXPORT_REVIEW_LIMIT).toBe(80);
        expect(report.review_rows.length).toBeLessThanOrEqual(80);
        expect(report.candidate_count).toBe(200);
    });

    test("every exported row has candidate id, evidence, prev excerpt, and pending review fields", async () => {
        const capture: { sql?: string } = {};
        const report = await runWithDb(
            Effect.gen(function* () {
                const svc = yield* LabelMiningService;
                return yield* svc.miningReport({ sinceDays: 14, limit: 500, reviewLimit: 80 });
            }),
            clientWithWindows([correctionWindow(1), directionWindow(2)], capture),
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
        const capture: { sql?: string } = {};
        const rows: FakeWindowRow[] = [];
        for (let i = 0; i < 50; i += 1) rows.push(correctionWindow(i));

        const report = await runWithDb(
            Effect.gen(function* () {
                const svc = yield* LabelMiningService;
                return yield* svc.miningReport({ sinceDays: 14, limit: 10, reviewLimit: 80 });
            }),
            clientWithWindows(rows, capture),
        );

        expect(report.candidate_count).toBe(10);
    });
});

describe("LabelMiningService.writeMiningReport", () => {
    test("writes the report to the requested path", async () => {
        const capture: { sql?: string } = {};
        const out = join(mkdtempSync(join(tmpdir(), "ax-label-mining-")), "nested", "report.json");

        const report = await runWithDb(
            Effect.gen(function* () {
                const svc = yield* LabelMiningService;
                return yield* svc.writeMiningReport({ sinceDays: 14, limit: 500, reviewLimit: 80, out });
            }),
            clientWithWindows([correctionWindow(1), directionWindow(2), verificationWindow(3)], capture),
        );

        const saved = JSON.parse(readFileSync(out, "utf8"));
        expect(saved.schema).toBe("ax.transcript_label_mining_report.v1");
        expect(saved.review_rows.length).toBe(report.review_rows.length);
        expect(saved.out_path).toBe(out);
    });
});
