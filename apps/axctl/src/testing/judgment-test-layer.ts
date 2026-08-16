import { Effect, Layer, Option } from "effect";
import { Judgment, type JudgmentService, type SidecarParam } from "@ax/lib/sqlite";
import { CacheRead } from "@ax/lib/duckdb/seam";
import type { DuckDbParam } from "@ax/lib/duckdb";

export const judgmentTestLayer = (
    rowsFor: (sql: string, params: ReadonlyArray<SidecarParam>) => ReadonlyArray<unknown> = () => [],
    execFor: (sql: string, params: ReadonlyArray<SidecarParam>) => number = () => 0,
    putFor: (table: string, row: Readonly<Record<string, SidecarParam>>) => void = () => undefined,
): Layer.Layer<Judgment> => {
    const service: JudgmentService = {
        rows: (_schema, sql, params = []) => Effect.succeed(rowsFor(sql, params) as never),
        first: (_schema, sql, params = []) => Effect.succeed((rowsFor(sql, params)[0] ?? null) as never),
        raw: (sql, params = []) => Effect.succeed(rowsFor(sql, params) as never),
        exec: (sql, params = []) => Effect.succeed(execFor(sql, params)),
        put: (table, row) => Effect.sync(() => putFor(table, row)),
        putMany: () => Effect.void,
        transaction: (body) => body(service),
        path: ":memory:",
    };
    return Layer.succeed(Judgment, service);
};

export const EmptyJudgmentTestLayer = judgmentTestLayer();

export const cacheReadTestLayer = (
    rowsFor: (sql: string, params: ReadonlyArray<DuckDbParam>) => ReadonlyArray<Record<string, unknown>> = () => [],
): Layer.Layer<CacheRead> => Layer.succeed(CacheRead, {
    rows: (_schema: never, sql: string, params: ReadonlyArray<DuckDbParam> = []) =>
        Effect.succeed(rowsFor(sql, params) as never),
    first: (_schema: never, sql: string, params: ReadonlyArray<DuckDbParam> = []) =>
        Effect.succeed((rowsFor(sql, params)[0] === undefined
            ? Option.none()
            : Option.some(rowsFor(sql, params)[0])) as never),
    raw: (sql: string, params: ReadonlyArray<DuckDbParam> = []) => Effect.succeed({
        columns: [],
        rows: rowsFor(sql, params) as never,
        rowsChanged: 0,
    }),
    snapshotPath: ":memory:",
} as never);

export const EmptyCacheReadTestLayer = cacheReadTestLayer();
