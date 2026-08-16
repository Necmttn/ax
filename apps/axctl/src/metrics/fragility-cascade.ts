import { Array as Arr, Effect, Schema } from "effect";
import { NumberFromBigIntColumn, TimestampColumn } from "@ax/lib/duckdb/columns";
import { inClause } from "@ax/lib/duckdb/clause";
import type { CacheReadError, CacheReadService, CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { WATERMARK_TABLE, watermarkRow } from "@ax/lib/duckdb/watermark";
import { localPathFileRecordKey, stableDigest } from "@ax/lib/ids";
import { enrichRowsWithTelemetryCost } from "../queries/telemetry-rollup.ts";

export interface CascadeEdge {
    readonly origin: string;
    readonly downstream: string;
    readonly weight: number;
    readonly downstream_cost_usd: number | null;
    readonly downstream_tokens: number | null;
}

export interface FragilityLimits {
    readonly maxRevertedCommits: number;
    readonly maxFilesPerCommit: number;
    readonly maxFragileFiles: number;
    readonly chunkSize: number;
}

export const DEFAULT_FRAGILITY_LIMITS: FragilityLimits = {
    maxRevertedCommits: 400,
    maxFilesPerCommit: 50,
    maxFragileFiles: 1500,
    chunkSize: 100,
};

const LOOKUP_CONCURRENCY = 6;
const WATERMARK_SOURCE = "metrics:fragility_cascade";
const WATERMARK_PATH = "__fragility_cascade__";

const CommitIdRow = Schema.Struct({ id: Schema.String });
const CheckoutRow = Schema.Struct({ repository: Schema.String, path: Schema.String });
const TouchedRow = Schema.Struct({ commit: Schema.String, file: Schema.String, ts: Schema.NullOr(TimestampColumn) });
const FileRow = Schema.Struct({ id: Schema.String, path: Schema.String, repository: Schema.NullOr(Schema.String) });
const ProducedRow = Schema.Struct({ commit: Schema.String, session: Schema.String });
const EditedRow = Schema.Struct({ file: Schema.String, turn: Schema.String, ts: TimestampColumn });
const TurnRow = Schema.Struct({ id: Schema.String, session: Schema.String });
const StoredRow = Schema.Struct({ sha: Schema.NullOr(Schema.String) });
const CountRow = Schema.Struct({ count: NumberFromBigIntColumn });
const CascadeRow = Schema.Struct({
    origin: Schema.String,
    downstream: Schema.String,
    weight: NumberFromBigIntColumn,
});

export const localPathTwinKeys = (relPath: string, checkoutRoots: readonly string[]): string[] =>
    checkoutRoots.map((root) =>
        localPathFileRecordKey(root.endsWith("/") ? `${root}${relPath}` : `${root}/${relPath}`),
    );

export interface FragileTouch {
    readonly commit: string;
    readonly file: string;
    readonly ts: number;
}

export interface FileEdit {
    readonly session: string;
    readonly ts: number;
}

export const joinCascadeEdges = (
    touched: readonly FragileTouch[],
    originByCommit: ReadonlyMap<string, string>,
    editsByFile: ReadonlyMap<string, readonly FileEdit[]>,
): CascadeEdge[] => {
    const pairs = new Set<string>();
    const downstreamByOrigin = new Map<string, Set<string>>();
    for (const touch of touched) {
        const origin = originByCommit.get(touch.commit);
        if (origin === undefined) continue;
        for (const edit of editsByFile.get(touch.file) ?? []) {
            if (edit.session === origin || edit.ts <= touch.ts) continue;
            pairs.add(`${origin}\u0000${edit.session}`);
            const downstream = downstreamByOrigin.get(origin) ?? new Set<string>();
            downstream.add(edit.session);
            downstreamByOrigin.set(origin, downstream);
        }
    }
    return [...pairs].map((pair) => {
        const [origin = "", downstream = ""] = pair.split("\u0000");
        return {
            origin,
            downstream,
            weight: downstreamByOrigin.get(origin)?.size ?? 0,
            downstream_cost_usd: null,
            downstream_tokens: null,
        };
    });
};

const anchorRevertedCommitKeys = (
    read: CacheReadService,
    limits: FragilityLimits,
): Effect.Effect<string[], CacheReadError> =>
    read.rows(
        CommitIdRow,
        `SELECT id FROM "commit" WHERE reverted = true ORDER BY ts DESC LIMIT ?`,
        [limits.maxRevertedCommits],
    ).pipe(Effect.map((rows) => [...new Set(rows.map((row) => row.id))]));

const anchorFingerprint = (commitKeys: readonly string[]): string =>
    stableDigest(`${commitKeys.length}|${[...commitKeys].sort().join("\n")}`, 32);

export const computeFragilityCascade = (
    read: CacheReadService,
    limits: FragilityLimits = DEFAULT_FRAGILITY_LIMITS,
    anchorCommitKeys?: readonly string[],
): Effect.Effect<CascadeEdge[], CacheReadError> =>
    Effect.gen(function* () {
        const commitKeys = anchorCommitKeys === undefined
            ? yield* anchorRevertedCommitKeys(read, limits)
            : [...anchorCommitKeys];
        if (commitKeys.length === 0) return [];

        const checkoutRows = yield* read.rows(
            CheckoutRow,
            `SELECT repository, path FROM checkout WHERE repository IS NOT NULL`,
        );
        const rootsByRepo = new Map<string, string[]>();
        for (const row of checkoutRows) {
            const roots = rootsByRepo.get(row.repository) ?? [];
            roots.push(row.path);
            rootsByRepo.set(row.repository, roots);
        }

        const touchedRows = (yield* Effect.forEach(
            Arr.chunksOf(commitKeys, limits.chunkSize),
            (chunk) => {
                const clause = inClause("in_id", chunk);
                return read.rows(
                    TouchedRow,
                    `SELECT in_id AS commit, out_id AS file, ts FROM touched WHERE true ${clause.sql}`,
                    clause.params,
                );
            },
            { concurrency: LOOKUP_CONCURRENCY },
        )).flat();

        const filesByCommit = new Map<string, Map<string, number>>();
        for (const row of touchedRows) {
            const files = filesByCommit.get(row.commit) ?? new Map<string, number>();
            if (!files.has(row.file)) files.set(row.file, row.ts?.getTime() ?? 0);
            filesByCommit.set(row.commit, files);
        }

        const touches: FragileTouch[] = [];
        const fragileFiles = new Set<string>();
        const survivingCommits = new Set<string>();
        for (const [commit, files] of filesByCommit) {
            if (files.size > limits.maxFilesPerCommit) continue;
            for (const [file, ts] of files) {
                if (!fragileFiles.has(file) && fragileFiles.size >= limits.maxFragileFiles) continue;
                fragileFiles.add(file);
                survivingCommits.add(commit);
                touches.push({ commit, file, ts });
            }
        }
        if (touches.length === 0) return [];

        const fileRows = (yield* Effect.forEach(
            Arr.chunksOf([...fragileFiles], limits.chunkSize),
            (chunk) => {
                const clause = inClause("id", chunk);
                return read.rows(
                    FileRow,
                    `SELECT id, path, repository FROM file WHERE true ${clause.sql}`,
                    clause.params,
                );
            },
            { concurrency: LOOKUP_CONCURRENCY },
        )).flat();
        const fileInfo = new Map(fileRows.map((row) => [row.id, row]));

        const producedRows = (yield* Effect.forEach(
            Arr.chunksOf([...survivingCommits], limits.chunkSize),
            (chunk) => {
                const clause = inClause("out_id", chunk);
                return read.rows(
                    ProducedRow,
                    `SELECT out_id AS commit, in_id AS session FROM produced WHERE true ${clause.sql}`,
                    clause.params,
                );
            },
            { concurrency: LOOKUP_CONCURRENCY },
        )).flat();
        const originByCommit = new Map(producedRows.map((row) => [row.commit, row.session]));
        if (originByCommit.size === 0) return [];

        const canonicalByCandidate = new Map<string, string>();
        for (const file of fragileFiles) {
            canonicalByCandidate.set(file, file);
            const info = fileInfo.get(file);
            if (info?.repository === null || info === undefined) continue;
            for (const twin of localPathTwinKeys(info.path, rootsByRepo.get(info.repository) ?? [])) {
                canonicalByCandidate.set(twin, file);
            }
        }

        const editedRows = (yield* Effect.forEach(
            Arr.chunksOf([...canonicalByCandidate.keys()], limits.chunkSize),
            (chunk) => {
                const clause = inClause("out_id", chunk);
                return read.rows(
                    EditedRow,
                    `SELECT out_id AS file, in_id AS turn, ts FROM edited WHERE true ${clause.sql}`,
                    clause.params,
                );
            },
            { concurrency: LOOKUP_CONCURRENCY },
        )).flat();
        const rawEdits = editedRows.flatMap((row) => {
            const canonical = canonicalByCandidate.get(row.file);
            return canonical === undefined ? [] : [{ canonical, turn: row.turn, ts: row.ts.getTime() }];
        });

        const turnIds = [...new Set(rawEdits.map((row) => row.turn))];
        const turnRows = (yield* Effect.forEach(
            Arr.chunksOf(turnIds, limits.chunkSize),
            (chunk) => {
                const clause = inClause("id", chunk);
                return read.rows(
                    TurnRow,
                    `SELECT id, session FROM turn WHERE true ${clause.sql}`,
                    clause.params,
                );
            },
            { concurrency: LOOKUP_CONCURRENCY },
        )).flat();
        const sessionByTurn = new Map(turnRows.map((row) => [row.id, row.session]));
        const editsByFile = new Map<string, FileEdit[]>();
        for (const edit of rawEdits) {
            const session = sessionByTurn.get(edit.turn);
            if (session === undefined) continue;
            const edits = editsByFile.get(edit.canonical) ?? [];
            edits.push({ session, ts: edit.ts });
            editsByFile.set(edit.canonical, edits);
        }
        return joinCascadeEdges(touches, originByCommit, editsByFile);
    });

export const persistFragilityCascade = (
    write: CacheWriteService,
    edges: readonly CascadeEdge[],
): Effect.Effect<number, CacheWriteError> =>
    Effect.gen(function* () {
        yield* write.exec(`DELETE FROM fragility_cascade`);
        if (edges.length === 0) return 0;
        yield* write.putMany(
            "fragility_cascade",
            edges.map((edge) => ({
                id: stableDigest(`${edge.origin}|${edge.downstream}`),
                origin: edge.origin,
                downstream: edge.downstream,
                weight: Math.trunc(edge.weight),
            })),
        );
        return edges.length;
    });

export const deriveFragilityCascade = (
    write: CacheWriteService,
    limits: FragilityLimits = DEFAULT_FRAGILITY_LIMITS,
): Effect.Effect<number, CacheWriteError> =>
    Effect.gen(function* () {
        const commitKeys = yield* anchorRevertedCommitKeys(write, limits);
        const fingerprint = anchorFingerprint(commitKeys);
        if (process.env.AX_REDERIVE_METRICS !== "1") {
            const stored = yield* write.rows(
                StoredRow,
                `SELECT sha FROM ingest_file_state WHERE source_kind = ? AND path = ? LIMIT 1`,
                [WATERMARK_SOURCE, WATERMARK_PATH],
            );
            if (stored[0]?.sha === fingerprint) {
                const rows = yield* write.rows(CountRow, `SELECT count(*) AS count FROM fragility_cascade`);
                return rows[0]?.count ?? 0;
            }
        }
        const edges = yield* computeFragilityCascade(write, limits, commitKeys);
        const written = yield* persistFragilityCascade(write, edges);
        yield* write.put(
            WATERMARK_TABLE,
            watermarkRow(WATERMARK_SOURCE, WATERMARK_PATH, { sha: fingerprint }),
        );
        return written;
    });

export const readFragilityCascade = (
    read: CacheReadService,
): Effect.Effect<CascadeEdge[], CacheReadError> =>
    Effect.gen(function* () {
        const rows = yield* read.rows(
            CascadeRow,
            `SELECT origin, downstream, weight FROM fragility_cascade`,
        );
        const edges: CascadeEdge[] = rows.map((row) => ({
            ...row,
            downstream_cost_usd: null,
            downstream_tokens: null,
        }));
        return yield* enrichRowsWithTelemetryCost(read, edges, (edge) => edge.downstream, (edge, cost) => ({
            ...edge,
            downstream_cost_usd: cost?.cost_usd ?? null,
            downstream_tokens: cost?.tokens ?? null,
        }));
    });
