import { Array as Arr, Effect } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { bareSession, sessionTelemetryCost } from "../queries/telemetry-rollup.ts";
import { recordKeyPart } from "@ax/lib/shared/derive-keys";
import { localPathFileRecordKey, recordLiteral, stableDigest } from "@ax/lib/ids";
import { selectByIds } from "@ax/lib/shared/record-select";
import { surrealString } from "@ax/lib/shared/surql";
import { executeStatementsWith } from "@ax/lib/shared/statement-exec";
import { watermarkRecordKey } from "@ax/lib/shared/watermark";
import { isoMs } from "./util.ts";

export interface CascadeEdge {
    readonly origin: string; // session that produced a reverted commit touching a file
    readonly downstream: string; // a later session that edited the same file
    readonly weight: number; // distinct downstream fixers for this origin
    readonly downstream_cost_usd: number | null; // OTLP-sourced cost for the downstream session
    readonly downstream_tokens: number | null; // OTLP-sourced token count for the downstream session
}

/**
 * Hard bounds for the derive-time cascade computation. Live data has ~112k
 * `touched` edges on reverted commits (mass reverts touch hundreds of files
 * each), so every query below is anchored + capped - an unbounded fileRefs
 * set would reproduce the documented 87k-edge per-edge-deref hang.
 */
export interface FragilityLimits {
    /** Most-recent reverted commits considered (anchor of the whole derive). */
    readonly maxRevertedCommits: number;
    /** Commits touching more distinct files than this are SKIPPED entirely -
     *  mass reverts (merge/formatting rollbacks) implicate near-everyone and
     *  carry no per-file fragility signal. */
    readonly maxFilesPerCommit: number;
    /** Global cap on distinct fragile files (recent commits win). */
    readonly maxFragileFiles: number;
    /** IN-list size for the chunked touched/file/produced/edited lookups. */
    readonly chunkSize: number;
}

export const DEFAULT_FRAGILITY_LIMITS: FragilityLimits = {
    maxRevertedCommits: 400,
    maxFilesPerCommit: 50,
    maxFragileFiles: 1500,
    chunkSize: 100,
};

/** Bounded concurrency for the chunked lookups (each chunk is one indexed /
 *  primary-key read; serial chunks were a measurable slice of the reported
 *  ~46s live derive). */
const LOOKUP_CONCURRENCY = 6;

const ms = (iso: unknown): number => isoMs(iso) ?? 0;

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** Run one bounded query per chunk with {@link LOOKUP_CONCURRENCY}, flattening
 *  the per-chunk row arrays. Order across chunks is irrelevant to every caller
 *  (results key on row fields, first-wins folds are per-chunk-local). */
const chunkedQuery = (
    db: SurrealClientShape,
    items: readonly string[],
    size: number,
    sqlFor: (chunk: readonly string[]) => string,
): Effect.Effect<Array<Record<string, unknown>>, DbError> =>
    Effect.forEach(
        Arr.chunksOf(items, size),
        (chunk) => db.query<[Array<Record<string, unknown>>]>(sqlFor(chunk)),
        { concurrency: LOOKUP_CONCURRENCY },
    ).pipe(Effect.map((results) => results.flatMap((r) => r?.[0] ?? [])));

/** Bare file record keys (no `file:` prefix) of the local-path twins of one
 *  repo-relative path across the repo's checkout roots. Pure - mirrors what
 *  tool-call ingest writes for an edit at `<root>/<relPath>`. */
export const localPathTwinKeys = (
    relPath: string,
    checkoutRoots: readonly string[],
): string[] =>
    checkoutRoots.map((root) =>
        localPathFileRecordKey(root.endsWith("/") ? `${root}${relPath}` : `${root}/${relPath}`),
    );

export interface FragileTouch {
    readonly commit: string;
    readonly file: string; // bare file key
    readonly ts: number;
}

export interface FileEdit {
    readonly session: string;
    readonly ts: number;
}

/**
 * Pure join: origin (produced a reverted commit touching a file) → downstream
 * (a DIFFERENT session that edited the same file LATER). Weight = distinct
 * downstream sessions per origin. Exported for unit tests.
 */
export const joinCascadeEdges = (
    touched: readonly FragileTouch[],
    originByCommit: ReadonlyMap<string, string>,
    editsByFile: ReadonlyMap<string, readonly FileEdit[]>,
): CascadeEdge[] => {
    const pairs = new Set<string>();
    const downstreamByOrigin = new Map<string, Set<string>>();
    for (const t of touched) {
        const origin = originByCommit.get(t.commit);
        if (origin === undefined) continue;
        for (const e of editsByFile.get(t.file) ?? []) {
            if (e.session === origin || e.ts <= t.ts) continue;
            pairs.add(`${origin} ${e.session}`);
            let set = downstreamByOrigin.get(origin);
            if (!set) { set = new Set(); downstreamByOrigin.set(origin, set); }
            set.add(e.session);
        }
    }
    return [...pairs].map((p) => {
        const [origin, downstream] = p.split(" ");
        return { origin, downstream, weight: downstreamByOrigin.get(origin)!.size, downstream_cost_usd: null, downstream_tokens: null };
    });
};

// ---------------------------------------------------------------------------
// Reverted-set fingerprint gate (issue #171 follow-up)
// ---------------------------------------------------------------------------

const WATERMARK_SOURCE = "metrics:fragility_cascade";
const WATERMARK_PATH = "__fragility_cascade__";
const watermarkId = (): string =>
    recordLiteral("ingest_file_state", watermarkRecordKey(WATERMARK_SOURCE, WATERMARK_PATH));

/** Bounded anchor: bare keys of the most recent reverted commits
 *  (commit_reverted index). `ts` must appear in the selection for ORDER BY
 *  under SurrealDB 3.x. */
const anchorRevertedCommitKeys = (
    db: SurrealClientShape,
    limits: FragilityLimits,
): Effect.Effect<string[], DbError> =>
    Effect.gen(function* () {
        const commitRows = (yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT type::string(id) AS id, ts FROM commit WHERE reverted = true`
            + ` ORDER BY ts DESC LIMIT ${limits.maxRevertedCommits};`,
        ))?.[0] ?? [];
        return [...new Set(
            commitRows.map((r) => recordKeyPart(r.id, "commit")).filter((k): k is string => k !== null),
        )];
    });

/** Fingerprint of the anchor set - the cascade only changes when the
 *  reverted-commit anchor changes, so an unchanged fingerprint skips the whole
 *  recompute (the daemon's `--since=1` path otherwise pays it on every
 *  transcript change). Trade-off: NEW downstream edits on an unchanged
 *  reverted set stay invisible until the set moves; acceptable staleness for
 *  a signal keyed on reverts. */
const anchorFingerprint = (commitKeys: readonly string[]): string =>
    stableDigest(`${commitKeys.length}|${[...commitKeys].sort().join("\n")}`, 32);

/**
 * Cross-session fragility cascade, computed BOUNDED for the derive stage.
 *
 * Every query is anchored: reverted commits via the `commit_reverted` index
 * (capped + most-recent-first), `touched` via `touched_in` per commit chunk
 * (NO derefs - file path/repository come from a separate primary-key fetch),
 * `produced` via `produced_out_ts`, `edited` via `edited_out` per candidate
 * chunk (raw `in` only - the turn→session hop is a separate primary-key
 * record-list fetch on `turn`, NEVER an `in.session` per-edge deref). Chunked
 * lookups run with bounded concurrency ({@link LOOKUP_CONCURRENCY}).
 *
 * File-key namespace bridge (issue #171): `touched` points at git-ingested
 * files (`file:remote_*`, repo-relative `path`), while `edited` points at
 * tool-call files (`file:repository__*`, ABSOLUTE path). The two namespaces
 * are 100% disjoint, so the join recomputes each fragile file's local-path
 * twin keys from `checkout.path + "/" + relPath` (same derivation tool-call
 * ingest uses) and folds twin edits back onto the canonical git file.
 */
export const computeFragilityCascade = (
    limits: FragilityLimits = DEFAULT_FRAGILITY_LIMITS,
    anchorCommitKeys?: readonly string[],
): Effect.Effect<CascadeEdge[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;

        // 1. Bounded anchor: most recent reverted commits (precomputed by the
        //    derive gate when available).
        const commitKeys = anchorCommitKeys !== undefined
            ? [...anchorCommitKeys]
            : yield* anchorRevertedCommitKeys(db, limits);
        if (commitKeys.length === 0) return [];

        // 2. Checkout roots per repository (small table, ~tens of rows).
        const checkoutRows = (yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT type::string(repository) AS repository, path FROM checkout;`,
        ))?.[0] ?? [];
        const rootsByRepo = new Map<string, string[]>();
        for (const c of checkoutRows) {
            const repo = str(c.repository);
            const root = str(c.path);
            if (repo === null || root === null) continue;
            const roots = rootsByRepo.get(repo) ?? [];
            roots.push(root);
            rootsByRepo.set(repo, roots);
        }

        // 3. touched edges anchored on the commit chunk (touched_in index, no
        //    derefs). Deduped per (commit, file) - one row per checkout exists.
        const filesByCommit = new Map<string, Map<string, number>>(); // commit → file → ts
        const touchedRows = yield* chunkedQuery(db, commitKeys, limits.chunkSize, (chunk) =>
            `SELECT type::string(in) AS commit, type::string(out) AS file, type::string(ts) AS ts`
            + ` FROM touched WHERE in IN [${chunk.map((k) => recordLiteral("commit", k)).join(", ")}];`);
        for (const r of touchedRows) {
            const commit = str(r.commit);
            const file = recordKeyPart(r.file, "file");
            if (commit === null || file === null) continue;
            let files = filesByCommit.get(commit);
            if (!files) { files = new Map(); filesByCommit.set(commit, files); }
            if (!files.has(file)) files.set(file, ms(r.ts));
        }

        // 3b. Apply limits: drop mass reverts entirely; cap global fragile set.
        const touches: FragileTouch[] = [];
        const fragileFiles = new Set<string>();
        const survivingCommits = new Set<string>();
        for (const [commit, files] of filesByCommit) {
            if (files.size > limits.maxFilesPerCommit) continue; // mass revert = noise
            for (const [file, ts] of files) {
                if (!fragileFiles.has(file) && fragileFiles.size >= limits.maxFragileFiles) continue;
                fragileFiles.add(file);
                survivingCommits.add(commit);
                touches.push({ commit, file, ts });
            }
        }
        if (touches.length === 0) return [];

        // 4. File rows by primary id - path + repository for the fragile set
        //    only (instead of an out.path deref on every touched edge).
        //    Record-list selection is load-bearing: `WHERE id IN [refs]`
        //    silently matches NOTHING on some tables (invariant + live
        //    verification: @ax/lib/shared/record-select).
        const fileInfo = new Map<string, { path: string; repository: string | null }>();
        const fileRows = yield* chunkedQuery(db, [...fragileFiles], limits.chunkSize, (chunk) =>
            selectByIds("type::string(id) AS id, path, type::string(repository) AS repository", "file", chunk, ["id", "path", "repository"]));
        for (const r of fileRows) {
            const key = recordKeyPart(r.id, "file");
            const path = str(r.path);
            if (key === null || path === null) continue;
            fileInfo.set(key, { path, repository: str(r.repository) });
        }

        // 5. commit → origin session, anchored on the surviving commits
        //    (produced_out_ts index).
        const originByCommit = new Map<string, string>();
        const survivingKeys = [...survivingCommits]
            .map((c) => recordKeyPart(c, "commit"))
            .filter((k): k is string => k !== null && k.length > 0);
        const producedRows = yield* chunkedQuery(db, survivingKeys, limits.chunkSize, (chunk) =>
            `SELECT type::string(out) AS commit, type::string(in) AS session FROM produced`
            + ` WHERE out IN [${chunk.map((k) => recordLiteral("commit", k)).join(", ")}];`);
        for (const r of producedRows) {
            const commit = str(r.commit);
            const session = str(r.session);
            if (commit !== null && session !== null) originByCommit.set(commit, session);
        }
        if (originByCommit.size === 0) return [];

        // 6. Namespace bridge: every fragile file joins under its own key PLUS
        //    the local-path twin keys across its repo's checkout roots.
        const canonicalByCandidate = new Map<string, string>(); // candidate bare key → canonical bare key
        for (const file of fragileFiles) {
            canonicalByCandidate.set(file, file);
            const info = fileInfo.get(file);
            if (!info || info.repository === null) continue;
            const roots = rootsByRepo.get(info.repository) ?? [];
            for (const twin of localPathTwinKeys(info.path, roots)) {
                canonicalByCandidate.set(twin, file);
            }
        }

        // 7. Edits on the candidate keys (edited_out index), selecting the RAW
        //    `in` (turn) ref - a per-edge `in.session` deref over `edited` is
        //    the documented hang shape and was the bulk of the live ~46s.
        const rawEdits: Array<{ canonical: string; turn: string; ts: number }> = [];
        const editedRows = yield* chunkedQuery(db, [...canonicalByCandidate.keys()], limits.chunkSize, (chunk) =>
            `SELECT type::string(out) AS file, type::string(in) AS turn, type::string(ts) AS ts`
            + ` FROM edited WHERE out IN [${chunk.map((k) => recordLiteral("file", k)).join(", ")}];`);
        for (const r of editedRows) {
            const candidate = recordKeyPart(r.file, "file");
            const turn = str(r.turn);
            if (candidate === null || turn === null) continue;
            const canonical = canonicalByCandidate.get(candidate);
            if (canonical === undefined) continue;
            rawEdits.push({ canonical, turn, ts: ms(r.ts) });
        }

        // 7b. Batch-resolve turn → session via primary-key record-list
        //     selection on `turn` (`turn.session` is a direct column; same
        //     WHERE-id-IN footgun as step 4 - see @ax/lib/shared/record-select).
        const sessionByTurn = new Map<string, string>();
        const turnKeys = [...new Set(
            rawEdits.map((e) => recordKeyPart(e.turn, "turn")).filter((k): k is string => k !== null),
        )];
        const turnRows = yield* chunkedQuery(db, turnKeys, limits.chunkSize, (chunk) =>
            // pick: turn rows carry full message text - materialize only the
            // two fields this projection reads.
            selectByIds("type::string(id) AS id, type::string(session) AS session", "turn", chunk, ["id", "session"]));
        for (const r of turnRows) {
            const id = str(r.id);
            const session = str(r.session);
            if (id !== null && session !== null) sessionByTurn.set(id, session);
        }

        const editsByFile = new Map<string, FileEdit[]>(); // canonical bare key → edits
        for (const e of rawEdits) {
            const session = sessionByTurn.get(e.turn);
            if (session === undefined) continue;
            const arr = editsByFile.get(e.canonical) ?? [];
            arr.push({ session, ts: e.ts });
            editsByFile.set(e.canonical, arr);
        }

        // 8. Join + weight by distinct downstream sessions per origin.
        return joinCascadeEdges(touches, originByCommit, editsByFile);
    });

/**
 * Persist the cascade as `fragility_cascade` rows. Full rewrite each run:
 * DELETE the whole (small, bounded) table by table-name - NOT a WHERE on an
 * indexed field (see surreal-delete-where-index-drift) - then UPSERT one row
 * per (origin, downstream) pair under a stable digest key.
 */
export const persistFragilityCascade = (
    edges: readonly CascadeEdge[],
): Effect.Effect<number, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const stmts: string[] = ["DELETE fragility_cascade;"];
        let written = 0;
        for (const e of edges) {
            const originKey = recordKeyPart(e.origin, "session");
            const downstreamKey = recordKeyPart(e.downstream, "session");
            if (originKey === null || downstreamKey === null) continue;
            const key = stableDigest(`${originKey}|${downstreamKey}`);
            stmts.push(
                `UPSERT ${recordLiteral("fragility_cascade", key)} CONTENT { `
                + `origin: ${recordLiteral("session", originKey)}, `
                + `downstream: ${recordLiteral("session", downstreamKey)}, `
                + `weight: ${Math.trunc(e.weight)}, ts: time::now() };`,
            );
            written += 1;
        }
        yield* executeStatementsWith(db, stmts, { chunkSize: 500 });
        return written;
    });

/**
 * Derive-stage entry: compute (bounded) + persist. Returns edges written (or
 * the stored row count when the recompute is skipped).
 *
 * Gated on the reverted-anchor fingerprint: when the set of (capped,
 * most-recent) reverted commits is unchanged since the last persisted run, the
 * whole recompute is skipped - this is what keeps the daemon's per-transcript
 * `--since=1` ingest off the ~46s path. `AX_REDERIVE_METRICS=1` forces.
 * Crash-safe ordering mirrors the other metric watermarks: the fingerprint
 * advances only AFTER the rows are persisted.
 */
export const deriveFragilityCascade = (
    limits: FragilityLimits = DEFAULT_FRAGILITY_LIMITS,
): Effect.Effect<number, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const commitKeys = yield* anchorRevertedCommitKeys(db, limits);
        const fingerprint = anchorFingerprint(commitKeys);

        const forced = process.env.AX_REDERIVE_METRICS === "1";
        if (!forced) {
            const stored = (yield* db.query<[Array<{ sha?: string }>]>(
                `SELECT sha FROM ingest_file_state WHERE source_kind = ${surrealString(WATERMARK_SOURCE)};`,
            ))?.[0]?.[0]?.sha;
            if (typeof stored === "string" && stored === fingerprint) {
                const n = (yield* db.query<[Array<{ n?: number }>]>(
                    `SELECT count() AS n FROM fragility_cascade GROUP ALL;`,
                ))?.[0]?.[0]?.n ?? 0;
                return Number(n);
            }
        }

        const edges = yield* computeFragilityCascade(limits, commitKeys);
        const written = yield* persistFragilityCascade(edges);
        // Advance the fingerprint only now that the rows are persisted.
        yield* executeStatementsWith(
            db,
            [
                `UPSERT ${watermarkId()} CONTENT { path: ${surrealString(WATERMARK_PATH)},`
                + ` source_kind: ${surrealString(WATERMARK_SOURCE)}, sha: ${surrealString(fingerprint)},`
                + ` ingested_at: time::now() };`,
            ],
            { chunkSize: 1 },
        );
        return written;
    });

/**
 * Read the precomputed rows - what `ax signals show fragility_cascade` renders.
 * A single small-table scan; NO live edge derefs on the read path.
 */
export const readFragilityCascade = (): Effect.Effect<CascadeEdge[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const rows = (yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT type::string(origin) AS origin, type::string(downstream) AS downstream, weight FROM fragility_cascade;`,
        ))?.[0] ?? [];
        const partialEdges: CascadeEdge[] = [];
        for (const r of rows) {
            const origin = str(r.origin);
            const downstream = str(r.downstream);
            const weight = typeof r.weight === "number" && Number.isFinite(r.weight) ? r.weight : 0;
            if (origin !== null && downstream !== null) {
                partialEdges.push({ origin, downstream, weight, downstream_cost_usd: null, downstream_tokens: null });
            }
        }
        // ONE batched OTLP cost lookup over deduped downstream ids.
        const ids = [...new Set(partialEdges.map((e) => e.downstream))];
        const cost = yield* sessionTelemetryCost(ids);
        return partialEdges.map((e) => ({
            ...e,
            downstream_cost_usd: cost.get(bareSession(e.downstream))?.cost_usd ?? null,
            downstream_tokens: cost.get(bareSession(e.downstream))?.tokens ?? null,
        }));
    });
