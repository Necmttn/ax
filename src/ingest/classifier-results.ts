import { Effect, Schema } from "effect";
import {
    buildEventWindows,
    enrichEventWindowsWithToolCalls,
    type ClassifierToolCallRow,
    type ClassifierTurnRow,
} from "../classifiers/event-window.ts";
import { ClassifierRunnerLive, ClassifierRunner } from "../classifiers/core.ts";
import type { ClassifierResult } from "../classifiers/core.ts";
import {
    buildClassifierPersistenceStatements,
    classifierRunKey,
    type ClassifierEvidenceRef,
} from "../classifiers/repository.ts";
import { builtInClassifiers } from "../classifiers/registry.ts";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import { executeStatementsWith } from "../lib/shared/statement-exec.ts";
import { recordKeyPart } from "../lib/shared/derive-keys.ts";
import { BaseStageStats, IngestContext, sinceDaysFromCtx, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

export const ClassifierResultsKey = Schema.Literal("classifier-results");
export type ClassifierResultsKey = typeof ClassifierResultsKey.Type;

export interface ClassifierResultsDerive {
    readonly windows: ReturnType<typeof buildEventWindows>;
    readonly results: readonly ClassifierResult[];
}

export interface ClassifierEditedFileRow {
    readonly turn: unknown;
    readonly file: unknown;
    readonly session?: unknown;
    readonly seq?: number | null;
    readonly ts: Date | string;
}

const defaultClassifiers = builtInClassifiers;

export function classifierEvidenceRefsForWindows(
    windows: readonly ReturnType<typeof buildEventWindows>[number][],
    results: readonly ClassifierResult[],
    editedFiles: readonly ClassifierEditedFileRow[] = [],
): readonly ClassifierEvidenceRef[] {
    const windowBySubject = new Map(windows.map((window) => [window.subjectId, window]));
    const editedByTurn = new Map<string, Array<{ readonly fileKey: string; readonly ts: Date | string }>>();
    const editedBySession = new Map<string, Array<{ readonly fileKey: string; readonly seq: number; readonly ts: Date | string }>>();
    for (const row of editedFiles) {
        const turnKey = recordKeyPart(row.turn, "turn");
        const fileKey = recordKeyPart(row.file, "file");
        if (!turnKey || !fileKey) continue;
        const files = editedByTurn.get(turnKey) ?? [];
        files.push({ fileKey, ts: row.ts });
        editedByTurn.set(turnKey, files);
        const sessionKey = recordKeyPart(row.session, "session");
        if (sessionKey && typeof row.seq === "number" && Number.isFinite(row.seq)) {
            const sessionFiles = editedBySession.get(sessionKey) ?? [];
            sessionFiles.push({ fileKey, seq: row.seq, ts: row.ts });
            editedBySession.set(sessionKey, sessionFiles);
        }
    }
    for (const files of editedBySession.values()) {
        files.sort((a, b) => a.seq - b.seq);
    }
    const refs: ClassifierEvidenceRef[] = [];
    const seen = new Set<string>();
    const pushFileRefs = (resultKey: string, turnKey: string, kind: string, fallbackTs: Date | string) => {
        for (const edited of editedByTurn.get(turnKey) ?? []) {
            const dedupeKey = `${resultKey}:${kind}:${edited.fileKey}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);
            refs.push({
                resultKey,
                table: "file",
                key: edited.fileKey,
                kind,
                ts: edited.ts ?? fallbackTs,
            });
        }
    };
    const pushRecentFileRefs = (result: ClassifierResult, window: ReturnType<typeof buildEventWindows>[number]) => {
        if (!window.sessionId) return;
        const recent = (editedBySession.get(window.sessionId) ?? [])
            .filter((edited) => edited.seq <= window.userTurn.seq)
            .slice(-3);
        for (const edited of recent) {
            const dedupeKey = `${result.key}:recent_edited_file:${edited.fileKey}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);
            refs.push({
                resultKey: result.key,
                table: "file",
                key: edited.fileKey,
                kind: "recent_edited_file",
                ts: edited.ts ?? result.ts,
            });
        }
    };
    for (const result of results) {
        const window = windowBySubject.get(result.subjectId);
        if (!window) continue;
        if (window.previousAssistantTurn) {
            const previousKey = recordKeyPart(window.previousAssistantTurn.id, "turn") ?? window.previousAssistantTurn.id;
            refs.push({
                resultKey: result.key,
                table: "turn",
                key: previousKey,
                kind: "previous_assistant",
                ts: window.previousAssistantTurn.ts,
            });
            pushFileRefs(result.key, previousKey, "previous_assistant_file", window.previousAssistantTurn.ts);
        }
        for (const failure of window.recentToolFailures) {
            const failureTable = failure.sourceTable ?? "turn";
            const failureKey = recordKeyPart(failure.id, failureTable) ?? failure.id;
            refs.push({
                resultKey: result.key,
                table: failureTable,
                key: failureKey,
                kind: "recent_tool_failure",
                ts: failure.ts ?? result.ts,
            });
            if (failureTable === "turn") {
                pushFileRefs(result.key, failureKey, "recent_failure_file", failure.ts ?? result.ts);
            }
        }
        pushRecentFileRefs(result, window);
    }
    return refs;
}

export async function deriveClassifierResultsFromRows(
    rows: readonly ClassifierTurnRow[],
    toolCalls: readonly ClassifierToolCallRow[] = [],
): Promise<ClassifierResultsDerive> {
    const windows = enrichEventWindowsWithToolCalls(buildEventWindows(rows), toolCalls);
    const program = Effect.gen(function* () {
        const runner = yield* ClassifierRunner;
        const results = yield* runner.runBatch({ windows, classifiers: defaultClassifiers });
        return { windows, results };
    });
    return Effect.runPromise(program.pipe(Effect.provide(ClassifierRunnerLive)));
}

const fetchTurns = (sinceDays: number | undefined): Effect.Effect<ClassifierTurnRow[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const since = sinceDays && sinceDays > 0 ? `WHERE ts > time::now() - ${sinceDays}d` : "";
        const [rows] = yield* db.query<[ClassifierTurnRow[]]>(`
SELECT id, session, seq, role, message_kind, text, text_excerpt, type::string(ts) AS ts
FROM turn
${since}
ORDER BY session, seq;`);
        return rows ?? [];
    });

const fetchToolCalls = (sinceDays: number | undefined): Effect.Effect<ClassifierToolCallRow[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const since = sinceDays && sinceDays > 0 ? `WHERE ts > time::now() - ${sinceDays + 1}d` : "";
        const [rows] = yield* db.query<[ClassifierToolCallRow[]]>(`
SELECT id, session, seq, name, command_norm, command_text, output_excerpt, error_text, has_error, type::string(ts) AS ts
FROM tool_call
${since}
ORDER BY session, ts;`);
        return rows ?? [];
    });

const fetchEditedFiles = (sinceDays: number | undefined): Effect.Effect<ClassifierEditedFileRow[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const since = sinceDays && sinceDays > 0 ? `WHERE ts > time::now() - ${sinceDays + 1}d` : "";
        const [rows] = yield* db.query<[ClassifierEditedFileRow[]]>(`
SELECT type::string(in) AS turn, type::string(out) AS file, in.session AS session, in.seq AS seq, type::string(ts) AS ts
FROM edited
${since}
ORDER BY ts;`);
        return rows ?? [];
    });

export interface ClassifierResultsStats {
    readonly windows: number;
    readonly results: number;
    readonly classifiers: number;
}

export const deriveAndPersistClassifierResults = (
    opts: { readonly sinceDays: number | undefined } = { sinceDays: undefined },
): Effect.Effect<ClassifierResultsStats, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const [rows, toolCalls, editedFiles] = yield* Effect.all([
            fetchTurns(opts.sinceDays),
            fetchToolCalls(opts.sinceDays),
            fetchEditedFiles(opts.sinceDays),
        ], { concurrency: 2 });
        const startedAt = new Date();
        const { windows, results } = yield* Effect.promise(() => deriveClassifierResultsFromRows(rows, toolCalls));
        const finishedAt = new Date();
        const runKey = classifierRunKey(startedAt, defaultClassifiers);
        if (opts.sinceDays === undefined) {
            yield* db.query('DELETE cites_evidence WHERE type::string(in) CONTAINS "classifier_result:"; DELETE has_classification; DELETE classifier_result; DELETE classifier_run;');
        }
        yield* executeStatementsWith(db, buildClassifierPersistenceStatements({
            runKey,
            startedAt,
            finishedAt,
            classifiers: defaultClassifiers,
            results,
            evidenceRefs: classifierEvidenceRefsForWindows(windows, results, editedFiles),
            sinceDays: opts.sinceDays,
        }), { chunkSize: 250 });
        return {
            windows: windows.length,
            results: results.length,
            classifiers: defaultClassifiers.length,
        };
    });

export class ClassifierResultsStageStats extends BaseStageStats.extend<ClassifierResultsStageStats>("ClassifierResultsStageStats")({
    windows: Schema.Number,
    results: Schema.Number,
    classifiers: Schema.Number,
}) {}

export const classifierResultsStage: StageDef<ClassifierResultsStageStats, SurrealClient> = {
    meta: StageMeta.make({ key: "classifier-results", deps: ["turn-analysis"], tags: ["derive"] }),
    run: (ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const result = yield* deriveAndPersistClassifierResults({ sinceDays: sinceDaysFromCtx(ctx) });
            return ClassifierResultsStageStats.make({
                durationMs: Date.now() - t0,
                summary: `classified ${result.windows} event windows into ${result.results} results with ${result.classifiers} classifiers`,
                ...result,
            });
        }),
};
