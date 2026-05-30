import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import { recordKeyPart } from "../lib/shared/derive-keys.ts";
import { recordRef } from "../lib/shared/surql.ts";

export interface ClassifierExplainTurn {
    readonly id: unknown;
    readonly session?: unknown;
    readonly seq?: number | null;
    readonly role?: string | null;
    readonly text?: string | null;
    readonly text_excerpt?: string | null;
    readonly ts?: string | Date | null;
}

export interface ClassifierExplainResult {
    readonly id: unknown;
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
    readonly ts?: string | Date | null;
}

export interface ClassifierExplainPayload {
    readonly turn: ClassifierExplainTurn | null;
    readonly results: readonly ClassifierExplainResult[];
}

export const turnRecordRefFromInput = (turnId: string): string => {
    const key = recordKeyPart(turnId, "turn") ?? turnId;
    return recordRef("turn", key);
};

export const classifierExplainSql = (turnId: string): string => {
    const turnRef = turnRecordRefFromInput(turnId);
    return `
SELECT id, session, seq, role, text, text_excerpt, type::string(ts) AS ts
FROM ${turnRef};

SELECT
    id,
    classifier_key,
    classifier_version,
    label,
    target,
    polarity,
    durability,
    confidence,
    method,
    evidence_json,
    signals,
    type::string(ts) AS ts
FROM classifier_result
WHERE turn = ${turnRef}
ORDER BY classifier_key, label, target, ts DESC;`.trim();
};

export const fetchClassifierExplain = (
    turnId: string,
): Effect.Effect<ClassifierExplainPayload, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const [turnRows, resultRows] = yield* db.query<[
            ClassifierExplainTurn[],
            ClassifierExplainResult[],
        ]>(classifierExplainSql(turnId));
        return {
            turn: turnRows?.[0] ?? null,
            results: resultRows ?? [],
        };
    });
