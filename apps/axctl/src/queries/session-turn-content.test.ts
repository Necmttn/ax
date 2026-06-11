/**
 * Tests for src/queries/session-turn-content.ts
 *
 * Regression guard for the iter-2 perf fix: full content resolution (share
 * export path) must fetch blocks/atoms via per-document INDEXED queries
 * (`document = <rid>`), never the `document IN [<all docs>]` membership scan
 * that scanned the whole 430k-block / 1.1M-atom tables (6s + 22s on a 318-doc
 * session). Also verifies blocks + atoms assemble onto the right turn.
 */
import { describe, expect, test } from "bun:test";
import { Effect, type Layer } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { makeTestSurrealClient } from "@ax/lib/testing/surreal";
import { resolveTurnContent } from "./session-turn-content.ts";

const DOC_ID = "content_document:turn__s1_seq_000001__abc";

// Route a mock query by the table/clause it targets, recording every SQL seen.
function makeMockDb(): { layer: Layer.Layer<SurrealClient>; captured: string[] } {
    const tc = makeTestSurrealClient({
        denyWrites: true,
        fallback: (sql) => {
            const rows = (() => {
                if (sql.includes("FROM content_document")) {
                    return [{
                        source_ref: "ref-1",
                        document_id: DOC_ID,
                        parser_id: "p",
                        parser_version: "1",
                        blockset_hash: "h",
                        turn_seq: 1,
                    }];
                }
                if (sql.includes("FROM content_block")) {
                    return [{
                        id: "content_block:blk1",
                        document_id: DOC_ID,
                        seq: 0,
                        parent_seq: null,
                        kind: "paragraph",
                        role: "assistant",
                        heading: null,
                        text: "hello",
                        text_excerpt: "hello",
                        start_offset: 0,
                        end_offset: 5,
                        confidence: 1,
                    }];
                }
                if (sql.includes("FROM content_atom")) {
                    return [{
                        document_id: DOC_ID,
                        block_seq: 0,
                        kind: "symbol_ref",
                        value: "foo",
                        normalized: "foo",
                        confidence: 1,
                        raw: null,
                    }];
                }
                return [];
            })();
            return [rows];
        },
    });
    return { layer: tc.layer, captured: tc.captured };
}

describe("resolveTurnContent (full content / share export)", () => {
    test("fetches blocks + atoms per-document with `document =`, never `document IN`", async () => {
        const { layer, captured } = makeMockDb();

        const byTurn = await Effect.runPromise(
            resolveTurnContent("session:`s1`").pipe(Effect.provide(layer)),
        );

        // Regression: the membership-scan form must be gone entirely.
        for (const sql of captured) {
            expect(sql).not.toContain("document IN");
        }
        // Block + atom fetches are per-document indexed lookups.
        const blockSql = captured.find((s) => s.includes("FROM content_block"));
        const atomSql = captured.find((s) => s.includes("FROM content_atom"));
        expect(blockSql).toBeDefined();
        expect(blockSql!).toContain(`document = ${DOC_ID}`);
        expect(atomSql).toBeDefined();
        expect(atomSql!).toContain(`document = ${DOC_ID}`);

        // Content assembled onto the right turn (seq 1), with the atom attached
        // to its block.
        const content = byTurn.get(1);
        expect(content).toBeDefined();
        expect(content!.blocks).toHaveLength(1);
        expect(content!.blocks[0]!.text).toBe("hello");
        expect(content!.blocks[0]!.atoms).toHaveLength(1);
        expect(content!.blocks[0]!.atoms[0]!.value).toBe("foo");
    });

    test("empty session (no documents) returns an empty map without block/atom queries", async () => {
        const tc = makeTestSurrealClient({ denyWrites: true });
        const byTurn = await Effect.runPromise(
            resolveTurnContent("session:`empty`").pipe(Effect.provide(tc.layer)),
        );
        expect(byTurn.size).toBe(0);
        // Short-circuits after the document query - no block/atom fan-out.
        expect(tc.captured.some((s) => s.includes("FROM content_block"))).toBe(false);
        expect(tc.captured.some((s) => s.includes("FROM content_atom"))).toBe(false);
    });
});
