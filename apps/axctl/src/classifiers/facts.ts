import { Context, Effect, Layer } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { recordKeyPart } from "@ax/lib/shared/derive-keys";
import { recordRef } from "@ax/lib/shared/surql";

export interface ClassifierEvidenceRow {
    readonly id?: unknown;
    readonly kind?: string | null;
    readonly evidence?: unknown;
    readonly evidence_table?: string | null;
    readonly ts?: Date | string | null;
}

export interface ClassifierFactRow {
    readonly id: unknown;
    readonly classifier_key: string;
    readonly classifier_version: string;
    readonly label: string;
    readonly target: string;
    readonly polarity: string;
    readonly durability: string;
    readonly confidence: number;
    readonly subject_type: string;
    readonly subject_id: string;
    readonly turn?: unknown;
    readonly user_seq?: number | null;
    readonly user_text?: string | null;
    readonly session?: unknown;
    readonly project?: string | null;
    readonly cwd?: string | null;
    readonly repository?: unknown;
    readonly evidence?: readonly ClassifierEvidenceRow[];
    readonly signals?: string | null;
    readonly ts: Date | string;
}

export interface ClassifierFactsServiceShape {
    readonly forTurn: (turnId: string) => Effect.Effect<readonly ClassifierFactRow[], DbError>;
    readonly forSession: (sessionId: string, limit: number) => Effect.Effect<readonly ClassifierFactRow[], DbError>;
    readonly forRepo: (repositoryKey: string, limit: number) => Effect.Effect<readonly ClassifierFactRow[], DbError>;
}

export class ClassifierFactsService extends Context.Service<ClassifierFactsService, ClassifierFactsServiceShape>()(
    "ax/ClassifierFactsService",
) {}

function checkedLimit(limit: number): number {
    if (!Number.isInteger(limit) || limit <= 0) {
        throw new RangeError(`limit must be a positive integer (got ${limit})`);
    }
    return limit;
}

const keyPart = (value: string, table: string): string =>
    recordKeyPart(value, table) ?? value;

const factProjection = `
    id,
    classifier_key,
    classifier_version,
    label,
    target,
    polarity,
    durability,
    confidence,
    subject_type,
    subject_id,
    turn,
    turn.seq AS user_seq,
    turn.text_excerpt AS user_text,
    session,
    session.project AS project,
    session.cwd AS cwd,
    session.repository AS repository,
    signals,
    ts,
    (
        SELECT
            id,
            kind,
            out AS evidence,
            type::table(out) AS evidence_table,
            ts
        FROM cites_evidence
        WHERE in = $parent.id
        ORDER BY ts DESC
        LIMIT 20
    ) AS evidence`;

const factsWhereSql = (where: string, limit: number): string => `
SELECT
${factProjection}
FROM classifier_result
WHERE ${where}
ORDER BY ts DESC, confidence DESC
LIMIT ${checkedLimit(limit)};`.trim();

export const ClassifierFactsServiceLive: Layer.Layer<ClassifierFactsService, never, SurrealClient> =
    Layer.effect(
        ClassifierFactsService,
        Effect.gen(function* () {
            const db = yield* SurrealClient;

            const queryFacts = (sql: string) =>
                Effect.gen(function* () {
                    const [rows] = yield* db.query<[ClassifierFactRow[]]>(sql);
                    return rows ?? [];
                });

            const forTurn = (turnId: string) =>
                queryFacts(factsWhereSql(`turn = ${recordRef("turn", keyPart(turnId, "turn"))}`, 50));

            const forSession = (sessionId: string, limit: number) =>
                queryFacts(factsWhereSql(`session = ${recordRef("session", keyPart(sessionId, "session"))}`, limit));

            const forRepo = (repositoryKey: string, limit: number) =>
                queryFacts(factsWhereSql(`session.repository = ${recordRef("repository", keyPart(repositoryKey, "repository"))}`, limit));

            return ClassifierFactsService.of({
                forTurn,
                forSession,
                forRepo,
            });
        }),
    );
