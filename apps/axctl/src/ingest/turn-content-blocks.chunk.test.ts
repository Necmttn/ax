/**
 * `deriveAndPersistTurnContentBlocks` now fetches turns one fixed ROW CHUNK at a
 * time and writes each chunk's content documents before fetching the next
 * (#917): a single unbounded `SELECT ... FROM turn` (full `text` column) was
 * one of the fetches behind the ~14 GB RSS segfault on a full
 * `--reparse=claude` backfill. This suite pins the properties that MUST
 * survive chunking against a REAL DuckDB, using an injected small `batchSize`
 * so the fixture cheaply crosses more than one chunk boundary:
 *
 *  - one session can cross a row boundary and every turn is counted once
 *  - the persisted `content_document`/`content_block`/`content_atom` rows are
 *    byte-for-byte the same whether derived in one chunk or many
 *  - a second (incremental) run over the same store is a no-op (idempotence)
 */
import { describe, expect } from "bun:test";
import { Effect, Schema } from "effect";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { deriveAndPersistTurnContentBlocks, type TurnContentBlocksStats } from "./turn-content-blocks.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("turn content blocks chunking", { requireFts: true });

// Small injected batch size splits each two-turn session across boundaries.
const BATCH_SIZE = 3;
const SESSION_COUNT = 7;
const TURNS_PER_SESSION = 2;
const RECENT = new Date();

const seedSessionsAndTurns = (write: CacheWriteService) =>
    Effect.gen(function* () {
        const sessions = Array.from({ length: SESSION_COUNT }, (_, i) => ({
            id: `s${String(i).padStart(4, "0")}`,
            source: "claude",
            started_at: RECENT,
        }));
        yield* write.putMany("session", sessions);
        const turns = sessions.flatMap((s) =>
            Array.from({ length: TURNS_PER_SESSION }, (_, seq) => ({
                id: `${s.id}-t${seq}`,
                session: s.id,
                agent_event: null,
                seq: BigInt(seq + 1),
                ts: RECENT,
                role: seq === 0 ? "user" : "assistant",
                text: `${s.id} turn ${seq} talks about src/${s.id}/${seq}.ts`,
                text_excerpt: `${s.id} turn ${seq}`,
            })));
        yield* write.putMany("turn", turns);
    });

const DocumentRow = Schema.Struct({
    id: Schema.String, source_ref: Schema.NullOr(Schema.String), content_hash: Schema.String,
    blockset_hash: Schema.NullOr(Schema.String), title: Schema.NullOr(Schema.String),
});
const BlockRow = Schema.Struct({
    id: Schema.String, document: Schema.String, kind: Schema.String, block_hash: Schema.String,
    text_excerpt: Schema.NullOr(Schema.String),
});
const AtomRow = Schema.Struct({
    id: Schema.String, block: Schema.String, document: Schema.String, kind: Schema.String,
    value: Schema.String, normalized: Schema.NullOr(Schema.String),
});

const projectContentRows = (write: CacheWriteService) =>
    Effect.gen(function* () {
        const documents = yield* write.rows(DocumentRow, "SELECT id, source_ref, content_hash, blockset_hash, title FROM content_document WHERE source_kind = 'turn' ORDER BY id");
        const blocks = yield* write.rows(BlockRow, "SELECT id, document, kind, block_hash, text_excerpt FROM content_block WHERE source_kind = 'turn' ORDER BY id");
        const atoms = yield* write.rows(AtomRow, "SELECT id, block, document, kind, value, normalized FROM content_atom WHERE source_kind = 'turn' ORDER BY id");
        return { documents, blocks, atoms };
    });

interface ContentRows {
    readonly documents: readonly Schema.Schema.Type<typeof DocumentRow>[];
    readonly blocks: readonly Schema.Schema.Type<typeof BlockRow>[];
    readonly atoms: readonly Schema.Schema.Type<typeof AtomRow>[];
}

interface Run {
    readonly stats: TurnContentBlocksStats;
    readonly rows: ContentRows;
}

const runFixture = (dirPrefix: string, batchSize: number): Promise<Run> =>
    runWithPlatform(Effect.gen(function* () {
        let result: Run | undefined;
        yield* publishCacheFixture(tempDir(dirPrefix), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* seedSessionsAndTurns(write);
                const stats = yield* deriveAndPersistTurnContentBlocks(write, { sinceDays: undefined, batchSize });
                const rows = yield* projectContentRows(write);
                result = { stats, rows };
            }));
        if (result === undefined) return yield* Effect.die("fixture body did not run");
        return result;
    }));

describe("deriveAndPersistTurnContentBlocks session chunking (#917)", () => {
    dtest("visits every session and sums every turn across chunk boundaries", async () => {
        const run = await runFixture("ax-turn-content-blocks-chunk-", BATCH_SIZE);
        expect(run.stats.turns).toBe(SESSION_COUNT * TURNS_PER_SESSION);
        expect(run.stats.documents).toBe(SESSION_COUNT * TURNS_PER_SESSION);
        expect(run.rows.documents).toHaveLength(SESSION_COUNT * TURNS_PER_SESSION);
    });

    dtest("chunked and single-batch derives persist byte-identical content rows", async () => {
        const chunked = await runFixture("ax-turn-content-blocks-chunked-", BATCH_SIZE);
        const single = await runFixture("ax-turn-content-blocks-single-", SESSION_COUNT * 10);

        expect(chunked.stats).toEqual(single.stats);
        expect(chunked.rows.documents).toEqual(single.rows.documents);
        expect(chunked.rows.blocks).toEqual(single.rows.blocks);
        expect(chunked.rows.atoms).toEqual(single.rows.atoms);
    });

    dtest("a second incremental run over the same store is a no-op", async () => {
        const dir = tempDir("ax-turn-content-blocks-idempotent-");
        const runs = await runWithPlatform(Effect.gen(function* () {
            let first: TurnContentBlocksStats | undefined;
            let second: TurnContentBlocksStats | undefined;
            yield* publishCacheFixture(dir, dylibPath, (write) =>
                Effect.gen(function* () {
                    yield* seedSessionsAndTurns(write);
                    first = yield* deriveAndPersistTurnContentBlocks(write, { sinceDays: undefined, batchSize: BATCH_SIZE });
                    second = yield* deriveAndPersistTurnContentBlocks(write, { sinceDays: undefined, batchSize: BATCH_SIZE });
                }));
            if (first === undefined || second === undefined) return yield* Effect.die("fixture body did not run");
            return { first, second };
        }));

        expect(runs.first.documents).toBe(SESSION_COUNT * TURNS_PER_SESSION);
        expect(runs.second.turns).toBe(SESSION_COUNT * TURNS_PER_SESSION);
        expect(runs.second.documents).toBe(0);
        expect(runs.second.blocks).toBe(0);
        expect(runs.second.atoms).toBe(0);
    });
});
