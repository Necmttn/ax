import { Effect, Schema } from "effect";
import { CacheRead, type CacheReadError } from "@ax/lib/duckdb";
import { NumberFromBigIntColumn, TimestampColumn } from "@ax/lib/duckdb/columns";
import { recordKeyPart } from "@ax/lib/shared/derive-keys";

export interface ClassifierExplainTurn {
    readonly id: string;
    readonly session?: string;
    readonly seq?: number | null;
    readonly role?: string | null;
    readonly text?: string | null;
    readonly text_excerpt?: string | null;
    readonly ts?: string | null;
}

export interface ClassifierExplainResult {
    readonly id: string;
    readonly classifier_key: string;
    readonly classifier_version: string;
    readonly label: string;
    readonly target: string;
    readonly polarity: string;
    readonly durability: string;
    readonly confidence: number;
    readonly method: string;
    readonly evidence_json: string;
    readonly signals?: string | null;
    readonly ts?: string | null;
}

export interface ClassifierExplainPayload {
    readonly turn: ClassifierExplainTurn | null;
    readonly results: readonly ClassifierExplainResult[];
}

export const turnRecordRefFromInput = (turnId: string): string => {
    return recordKeyPart(turnId, "turn") ?? turnId;
};

export const classifierExplainSql = (): string => `
SELECT id, session, seq, role, text, text_excerpt, ts
FROM turn WHERE id = ? LIMIT 1`.trim();

export const classifierResultsSql = (): string => `
SELECT id, classifier_key, classifier_version, label, target, polarity,
       durability, confidence, method, evidence_json, signals, ts
FROM classifier_result
WHERE turn = ?
ORDER BY classifier_key, label, target, ts DESC`.trim();

const TurnRow = Schema.Struct({
    id: Schema.String,
    session: Schema.String,
    seq: Schema.NullOr(NumberFromBigIntColumn),
    role: Schema.NullOr(Schema.String),
    text: Schema.NullOr(Schema.String),
    text_excerpt: Schema.NullOr(Schema.String),
    ts: Schema.NullOr(TimestampColumn),
});

const ResultRow = Schema.Struct({
    id: Schema.String,
    classifier_key: Schema.String,
    classifier_version: Schema.String,
    label: Schema.String,
    target: Schema.String,
    polarity: Schema.String,
    durability: Schema.String,
    confidence: Schema.Number,
    method: Schema.String,
    evidence_json: Schema.String,
    signals: Schema.NullOr(Schema.String),
    ts: Schema.NullOr(TimestampColumn),
});

export const fetchClassifierExplain = (
    turnId: string,
): Effect.Effect<ClassifierExplainPayload, CacheReadError, CacheRead> =>
    Effect.gen(function* () {
        const db = yield* CacheRead;
        const turnKey = turnRecordRefFromInput(turnId);
        const [turnRows, resultRows] = yield* Effect.all([
            db.rows(TurnRow, classifierExplainSql(), [turnKey]),
            db.rows(ResultRow, classifierResultsSql(), [turnKey]),
        ]);
        return {
            turn: turnRows[0] ? { ...turnRows[0], ts: turnRows[0].ts?.toISOString() ?? null } : null,
            results: resultRows.map((row) => ({ ...row, ts: row.ts?.toISOString() ?? null })),
        };
    });
