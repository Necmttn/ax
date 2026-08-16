/**
 * Tests for src/queries/session-turn-content.ts against a REAL published
 * DuckDB snapshot.
 *
 * The SurrealDB version of this file carried a large "speculative record-id
 * fan-out" (deterministic content_block/content_atom id guessing, chunked to
 * a ref budget, capped and falling back to a per-document scan past a
 * ceiling) built specifically to route around a real SurrealDB weakness: a
 * `document IN [<all docs>]` membership scan was a multi-second full-table
 * scan on the 430k-block / 1.1M-atom production tables. None of that applies
 * to DuckDB - `content_block_document_seq` and `content_atom_document_kind`
 * are real indexes, so a chunked `document IN (...)` IS the fast indexed
 * lookup; there is no separate slow path to route around, and no
 * deterministic record ids to guess (DuckDB ids are opaque VARCHARs, not
 * SurrealDB's colon-delimited table:key literals). See session-turn-content.ts
 * for the full rationale.
 *
 * The old testing/surreal.ts-backed test asserted exact SurrealQL text
 * (record-list ref counts, direct-vs-per-document query shapes) that no
 * longer describes the implementation at all, so per the migration's rule
 * against fake-backed tests on a ported reader, it is replaced here with a
 * real-DuckDB fixture test: seed a real snapshot, read through the real
 * CacheRead seam, assert blocks + atoms land on the right turn.
 */
import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { publishCacheFixture, readFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import {
    resolveTurnContent,
    resolveTurnContentForSourceRefs,
    resolveTurnContentForTurnSeqs,
} from "./session-turn-content.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("session turn content", { requireFts: true });

const SID = "019e2531-b552-7b53-a029-c780adbb6560";
const TURN1 = "019e2531-b552-7b53-a029-c780adbb6561";
const TURN2 = "019e2531-b552-7b53-a029-c780adbb6562";
const DOC1 = "content_document:turn1";
const DOC2 = "content_document:turn2";
const BLOCK1 = "content_block:turn1-b0";
const BLOCK2 = "content_block:turn2-b0";

/** Two turns, each with one content_document/content_block; only turn 1's
 *  block has an atom - lets the tests distinguish "no atoms" from "wrong join". */
const seedTwoTurns = (write: Parameters<Parameters<typeof publishCacheFixture>[2]>[0]) =>
    Effect.gen(function* () {
        yield* write.put("session", { id: SID, source: "claude" });
        yield* write.put("turn", { id: TURN1, session: SID, seq: 1n, ts: new Date(), role: "assistant" });
        yield* write.put("turn", { id: TURN2, session: SID, seq: 2n, ts: new Date(), role: "assistant" });
        yield* write.put("content_document", {
            id: DOC1, source_kind: "turn", source_ref: "ref-1", turn: TURN1, session: SID,
            content_hash: "h1", parse_fingerprint: "f1", registry_version: "v1",
            parser_id: "p", parser_version: "1", blockset_hash: "bs1",
        });
        yield* write.put("content_document", {
            id: DOC2, source_kind: "turn", source_ref: "ref-2", turn: TURN2, session: SID,
            content_hash: "h2", parse_fingerprint: "f1", registry_version: "v1",
            parser_id: "p", parser_version: "1", blockset_hash: "bs2",
        });
        yield* write.put("content_block", {
            id: BLOCK1, document: DOC1, source_kind: "turn", kind: "paragraph", seq: 0n,
            text: "hello", text_excerpt: "hello", block_hash: "bh1", parser: "p",
        });
        yield* write.put("content_block", {
            id: BLOCK2, document: DOC2, source_kind: "turn", kind: "paragraph", seq: 0n,
            text: "world", text_excerpt: "world", block_hash: "bh2", parser: "p",
        });
        yield* write.put("content_atom", {
            id: "content_atom:1", block: BLOCK1, document: DOC1, source_kind: "turn",
            kind: "symbol_ref", value: "foo", normalized: "foo",
        });
    });

describe("session-turn-content over a published snapshot", () => {
    dtest("resolveTurnContent: blocks + atoms assembled onto the right turn", async () => {
        const dir = tempDir("session-turn-content");
        const fixture = await runWithPlatform(publishCacheFixture(dir, dylibPath, seedTwoTurns));
        const layer = readFixture(fixture.snapshotPath, dylibPath);

        const byTurn = await Effect.runPromise(resolveTurnContent(SID).pipe(Effect.provide(layer)));

        expect(byTurn.size).toBe(2);
        const t1 = byTurn.get(1);
        expect(t1?.blocks).toHaveLength(1);
        expect(t1?.blocks[0]?.text).toBe("hello");
        expect(t1?.blocks[0]?.atoms).toHaveLength(1);
        expect(t1?.blocks[0]?.atoms[0]?.value).toBe("foo");
        const t2 = byTurn.get(2);
        expect(t2?.blocks[0]?.text).toBe("world");
        expect(t2?.blocks[0]?.atoms).toHaveLength(0);
    });

    dtest("resolveTurnContentForTurnSeqs: scopes to the requested seqs only", async () => {
        const dir = tempDir("session-turn-content-seqs");
        const fixture = await runWithPlatform(publishCacheFixture(dir, dylibPath, seedTwoTurns));
        const layer = readFixture(fixture.snapshotPath, dylibPath);

        const byTurn = await Effect.runPromise(
            resolveTurnContentForTurnSeqs(SID, [1]).pipe(Effect.provide(layer)),
        );

        expect(byTurn.size).toBe(1);
        expect(byTurn.get(1)?.blocks[0]?.text).toBe("hello");
        expect(byTurn.has(2)).toBe(false);
    });

    dtest("resolveTurnContentForSourceRefs: resolves by source_ref, not the whole session", async () => {
        const dir = tempDir("session-turn-content-refs");
        const fixture = await runWithPlatform(publishCacheFixture(dir, dylibPath, seedTwoTurns));
        const layer = readFixture(fixture.snapshotPath, dylibPath);

        const byTurn = await Effect.runPromise(
            resolveTurnContentForSourceRefs(["ref-2"]).pipe(Effect.provide(layer)),
        );

        expect(byTurn.size).toBe(1);
        expect(byTurn.get(2)?.blocks[0]?.text).toBe("world");
    });

    dtest("empty session: no documents, resolves to an empty map", async () => {
        const dir = tempDir("session-turn-content-empty");
        const fixture = await runWithPlatform(publishCacheFixture(dir, dylibPath, () => Effect.void));
        const layer = readFixture(fixture.snapshotPath, dylibPath);

        const byTurn = await Effect.runPromise(
            resolveTurnContent("no-such-session").pipe(Effect.provide(layer)),
        );
        expect(byTurn.size).toBe(0);
    });
});
