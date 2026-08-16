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
    classifierPersistenceRows,
    classifierRunKey,
    type ClassifierEvidenceRef,
} from "../classifiers/repository.ts";
import { builtInClassifiers } from "../classifiers/registry.ts";
import { TimestampColumn } from "@ax/lib/duckdb/columns";
import type { CacheReadError, CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { recordKeyPart } from "@ax/lib/shared/derive-keys";
import { BaseStageStats, IngestContext, sinceDaysFromCtx, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

export const ClassifierResultsKey = Schema.Literal("classifier-results");
export type ClassifierResultsKey = typeof ClassifierResultsKey.Type;

export interface ClassifierResultsDerive {
    readonly windows: ReturnType<typeof buildEventWindows>;
    readonly results: readonly ClassifierResult[];
}

export interface ClassifierEditedFileRow {
    readonly turn: string;
    readonly file: string;
    readonly session?: string | null;
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
        const turnKey = recordKeyPart(row.turn, "turn") ?? row.turn;
        const fileKey = recordKeyPart(row.file, "file") ?? row.file;
        if (!turnKey || !fileKey) continue;
        const files = editedByTurn.get(turnKey) ?? [];
        files.push({ fileKey, ts: row.ts });
        editedByTurn.set(turnKey, files);
        const sessionKey = row.session ? recordKeyPart(row.session, "session") ?? row.session : null;
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

const fetchTurns = (write: CacheWriteService, sinceDays: number | undefined): Effect.Effect<readonly ClassifierTurnRow[], CacheReadError> =>
    Effect.gen(function* () {
        return yield* write.rows(Schema.Struct({
            id: Schema.String, session: Schema.String, seq: Schema.Number, role: Schema.String,
            message_kind: Schema.NullOr(Schema.String), text: Schema.NullOr(Schema.String),
            text_excerpt: Schema.NullOr(Schema.String), ts: TimestampColumn,
        }), `SELECT id, session, CAST(seq AS DOUBLE) AS seq, role, message_kind, text, text_excerpt, ts
FROM turn
${sinceDays === undefined ? "" : "WHERE ts >= CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - (CAST(? AS INTEGER) * INTERVAL '1 day')"}
ORDER BY session, seq`, sinceDays === undefined ? [] : [sinceDays]);
    });

const fetchToolCalls = (write: CacheWriteService, sinceDays: number | undefined): Effect.Effect<readonly ClassifierToolCallRow[], CacheReadError> =>
    Effect.gen(function* () {
        return yield* write.rows(Schema.Struct({
            id: Schema.String, session: Schema.String, seq: Schema.Number, name: Schema.String,
            command_norm: Schema.NullOr(Schema.String), command_text: Schema.NullOr(Schema.String),
            output_excerpt: Schema.NullOr(Schema.String), error_text: Schema.NullOr(Schema.String),
            has_error: Schema.Boolean, ts: TimestampColumn,
        }), `SELECT id, session, CAST(seq AS DOUBLE) AS seq, name, command_norm, command_text, output_excerpt, error_text, has_error, ts
FROM tool_call
${sinceDays === undefined ? "" : "WHERE ts >= CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - (CAST(? AS INTEGER) * INTERVAL '1 day')"}
ORDER BY session, ts`, sinceDays === undefined ? [] : [sinceDays + 1]);
    });

const fetchEditedFiles = (write: CacheWriteService, sinceDays: number | undefined): Effect.Effect<readonly ClassifierEditedFileRow[], CacheReadError> =>
    Effect.gen(function* () {
        return yield* write.rows(Schema.Struct({
            turn: Schema.String, file: Schema.String, session: Schema.NullOr(Schema.String),
            seq: Schema.NullOr(Schema.Number), ts: TimestampColumn,
        }), `SELECT e.in_id AS turn, e.out_id AS file, e.session, CAST(t.seq AS DOUBLE) AS seq, e.ts
             FROM edited e LEFT JOIN turn t ON t.id = e.in_id
             ${sinceDays === undefined ? "" : "WHERE e.ts >= CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - (CAST(? AS INTEGER) * INTERVAL '1 day')"}
             ORDER BY e.ts`, sinceDays === undefined ? [] : [sinceDays + 1]);
    });

export interface ClassifierResultsStats {
    readonly windows: number;
    readonly results: number;
    readonly classifiers: number;
}

export const deriveAndPersistClassifierResults = (
    write: CacheWriteService,
    opts: { readonly sinceDays: number | undefined } = { sinceDays: undefined },
): Effect.Effect<ClassifierResultsStats, CacheReadError | CacheWriteError> =>
    Effect.gen(function* () {
        const [rows, toolCalls, editedFiles] = yield* Effect.all([
            fetchTurns(write, opts.sinceDays),
            fetchToolCalls(write, opts.sinceDays),
            fetchEditedFiles(write, opts.sinceDays),
        ], { concurrency: 2 });
        const startedAt = new Date();
        const { windows, results } = yield* Effect.promise(() => deriveClassifierResultsFromRows(rows, toolCalls));
        const finishedAt = new Date();
        const runKey = classifierRunKey(startedAt, defaultClassifiers);
        if (opts.sinceDays === undefined) {
            yield* write.exec("DELETE FROM cites_evidence WHERE in_table = 'classifier_result'");
            yield* write.exec("DELETE FROM has_classification");
            yield* write.exec("DELETE FROM classifier_result");
            yield* write.exec("DELETE FROM classifier_run");
        }
        const persisted = classifierPersistenceRows({
            runKey,
            startedAt,
            finishedAt,
            classifiers: defaultClassifiers,
            results,
            evidenceRefs: classifierEvidenceRefsForWindows(windows, results, editedFiles),
            sinceDays: opts.sinceDays,
        });
        yield* write.putMany("classifier_definition", persisted.definitions);
        yield* write.put("classifier_run", persisted.run);
        for (const result of results) yield* write.exec("DELETE FROM cites_evidence WHERE in_table = 'classifier_result' AND in_id = ?", [result.key]);
        yield* write.putMany("classifier_result", persisted.results);
        yield* write.putMany("has_classification", persisted.classifications);
        yield* write.putMany("cites_evidence", persisted.citations);
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

export const classifierResultsStage: StageDef<ClassifierResultsStageStats, never, import("./stage/registry.ts").IngestStageError> = {
    meta: StageMeta.make({ key: "classifier-results", deps: ["turn-analysis"], tags: ["derive"] }),
    run: (ctx: IngestContext, write) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const result = yield* deriveAndPersistClassifierResults(write, { sinceDays: sinceDaysFromCtx(ctx) });
            return ClassifierResultsStageStats.make({
                durationMs: Date.now() - t0,
                summary: `classified ${result.windows} event windows into ${result.results} results with ${result.classifiers} classifiers`,
                ...result,
            });
        }),
};
