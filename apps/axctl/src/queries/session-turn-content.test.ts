/**
 * Tests for src/queries/session-turn-content.ts
 *
 * Regression guard for the iter-2 perf fix: full content resolution (share
 * export path) must fetch blocks/atoms via per-document INDEXED queries
 * (`document = <rid>`), never the `document IN [<all docs>]` membership scan
 * that scanned the whole 430k-block / 1.1M-atom tables (6s + 22s on a 318-doc
 * session). Also verifies blocks + atoms assemble onto the right turn.
 *
 * Issue #263 guards (fast inspector path): the speculative direct block/atom
 * ref fan-out must be chunked so no single SurrealQL query carries more than
 * DIRECT_REF_BUDGET_PER_QUERY refs, and past
 * MAX_SPECULATIVE_REFS_PER_REQUEST total refs the resolver must fall back to
 * the per-document indexed fan-out - asserted via the query-capture seam, not
 * wall-clock.
 */
import { describe, expect, test } from "bun:test";
import { Effect, type Layer } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { identityPart } from "@ax/lib/ids";
import { makeTestSurrealClient } from "@ax/lib/testing/surreal";
import {
    DIRECT_REF_BUDGET_PER_QUERY,
    MAX_SPECULATIVE_REFS_PER_REQUEST,
    resolveTurnContent,
    resolveTurnContentForSourceRefs,
} from "./session-turn-content.ts";

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

// ---------------------------------------------------------------------------
// Fast inspector path (resolveTurnContentForSourceRefs) - issue #263
// ---------------------------------------------------------------------------

/** Speculative refs the resolver builds per document / per block (must mirror
 *  the production constants in session-turn-content.ts). */
const BLOCK_REFS_PER_DOC = 20;
const ATOM_REFS_PER_BLOCK = 8 * 5; // 8 fast atom kinds x 5 per kind

const docKeyForSourceRef = (ref: string): string => `turn__${identityPart(ref, "source")}`;
const BLOCK_ONE_SUFFIX = "__block_000001";

/** Backticked record refs spliced into a record-list source - the speculative
 *  direct fan-out. Per-document fallback queries interpolate a bare
 *  (unbackticked) rid instead, so they intentionally count zero here. */
const directRefCount = (sql: string): number =>
    (sql.match(/content_(?:document|block|atom):`/g) ?? []).length;

const extractKeys = (sql: string, table: string): string[] =>
    [...sql.matchAll(new RegExp(`${table}:\`([^\`]+)\``, "g"))].map((m) => m[1]!);

/**
 * Mock DB for the fast path: every requested document exists (source_ref maps
 * back to the original input ref), each document has exactly one block (seq 0,
 * `__block_000001`), and that block has one `symbol_ref` atom. Direct
 * speculative refs beyond those dereference to nothing (rows omitted), exactly
 * like the production `.filter(|$o| $o != NONE)` drop.
 */
function makeFastPathDb(sourceRefs: readonly string[]): {
    layer: Layer.Layer<SurrealClient>;
    captured: string[];
} {
    const sourceRefByDocKey = new Map(sourceRefs.map((ref) => [docKeyForSourceRef(ref), ref]));
    const turnSeqByDocKey = new Map(sourceRefs.map((ref, i) => [docKeyForSourceRef(ref), i + 1]));
    const docRow = (docKey: string) => ({
        source_ref: sourceRefByDocKey.get(docKey) ?? null,
        document_id: `content_document:${docKey}`,
        parser_id: "p",
        parser_version: "1",
        blockset_hash: "h",
        turn_seq: turnSeqByDocKey.get(docKey) ?? null,
    });
    const blockRow = (docKey: string) => ({
        id: `content_block:${docKey}${BLOCK_ONE_SUFFIX}`,
        document_id: `content_document:${docKey}`,
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
    });
    const atomRow = (docKey: string) => ({
        document_id: `content_document:${docKey}`,
        block_seq: 0,
        kind: "symbol_ref",
        value: "foo",
        normalized: "foo",
        confidence: 1,
        raw: null,
    });
    const docKeyFromRid = (sql: string): string | null =>
        sql.match(/document = content_document:([A-Za-z0-9_:-]+)/)?.[1] ?? null;
    const tc = makeTestSurrealClient({
        denyWrites: true,
        fallback: (sql) => {
            // Direct (record-list) fetches - keys parsed from the spliced refs.
            if (sql.includes("content_block:`")) {
                const rows = extractKeys(sql, "content_block")
                    .filter((key) => key.endsWith(BLOCK_ONE_SUFFIX))
                    .map((key) => blockRow(key.slice(0, -BLOCK_ONE_SUFFIX.length)));
                return [rows];
            }
            if (sql.includes("content_atom:`")) {
                const symbolRefPart = identityPart("symbol_ref", "atom");
                const rows = extractKeys(sql, "content_atom")
                    .filter((key) => key.endsWith(`__${symbolRefPart}__0001`))
                    .map((key) => {
                        const blockKey = key.slice(0, -`__${symbolRefPart}__0001`.length);
                        return atomRow(blockKey.slice(0, -BLOCK_ONE_SUFFIX.length));
                    })
                    .filter((row) => sourceRefByDocKey.has(row.document_id.slice("content_document:".length)));
                return [rows];
            }
            // Per-document indexed fallbacks (`document = <bare rid>`).
            if (sql.includes("FROM content_block")) {
                const docKey = docKeyFromRid(sql);
                return [docKey && sourceRefByDocKey.has(docKey) ? [blockRow(docKey)] : []];
            }
            if (sql.includes("FROM content_atom")) {
                const docKey = docKeyFromRid(sql);
                return [docKey && sourceRefByDocKey.has(docKey) ? [atomRow(docKey)] : []];
            }
            // Direct (record-list) document fetch.
            if (sql.includes("content_document:`")) {
                return [extractKeys(sql, "content_document").map(docRow)];
            }
            return [[]];
        },
    });
    return { layer: tc.layer, captured: tc.captured };
}

const runFastPath = (sourceRefs: readonly string[]) => {
    const { layer, captured } = makeFastPathDb(sourceRefs);
    return Effect.runPromise(
        resolveTurnContentForSourceRefs(sourceRefs).pipe(Effect.provide(layer)),
    ).then((byTurn) => ({ byTurn, captured }));
};

describe("resolveTurnContentForSourceRefs (fast inspector path)", () => {
    test("small session: direct record-list fetches, content assembled, no per-document fallback", async () => {
        const sourceRefs = ["ref-a", "ref-b", "ref-c"];
        const { byTurn, captured } = await runFastPath(sourceRefs);

        // Direct path used end-to-end: no per-document indexed fallback fired.
        expect(captured.some((s) => s.includes("document = content_document:"))).toBe(false);
        // One chunk each for docs (3 refs), blocks (60 refs), atoms (120 refs).
        expect(captured.filter((s) => s.includes("content_document:`"))).toHaveLength(1);
        const blockQueries = captured.filter((s) => s.includes("content_block:`"));
        const atomQueries = captured.filter((s) => s.includes("content_atom:`"));
        expect(blockQueries).toHaveLength(1);
        expect(directRefCount(blockQueries[0]!)).toBe(sourceRefs.length * BLOCK_REFS_PER_DOC);
        expect(atomQueries).toHaveLength(1);
        expect(directRefCount(atomQueries[0]!)).toBe(sourceRefs.length * ATOM_REFS_PER_BLOCK);

        // Content assembled onto the right turns, atom attached to its block.
        expect(byTurn.size).toBe(3);
        for (const seq of [1, 2, 3]) {
            const content = byTurn.get(seq);
            expect(content).toBeDefined();
            expect(content!.blocks).toHaveLength(1);
            expect(content!.blocks[0]!.text).toBe("hello");
            expect(content!.blocks[0]!.atoms).toHaveLength(1);
            expect(content!.blocks[0]!.atoms[0]!.value).toBe("foo");
        }
    });

    test("chunking: no single query carries more refs than the budget, all refs covered", async () => {
        // 30 docs -> 600 speculative block refs -> 3 chunks; 30 blocks -> 1200
        // atom refs -> 6 chunks. Well under the request ceiling, so the direct
        // path stays engaged.
        const sourceRefs = Array.from({ length: 30 }, (_, i) => `ref-${i}`);
        const { byTurn, captured } = await runFastPath(sourceRefs);

        for (const sql of captured) {
            expect(directRefCount(sql)).toBeLessThanOrEqual(DIRECT_REF_BUDGET_PER_QUERY);
        }
        const blockQueries = captured.filter((s) => s.includes("content_block:`"));
        const atomQueries = captured.filter((s) => s.includes("content_atom:`"));
        const totalBlockRefs = sourceRefs.length * BLOCK_REFS_PER_DOC;
        const totalAtomRefs = sourceRefs.length * ATOM_REFS_PER_BLOCK;
        expect(blockQueries).toHaveLength(Math.ceil(totalBlockRefs / DIRECT_REF_BUDGET_PER_QUERY));
        expect(atomQueries).toHaveLength(Math.ceil(totalAtomRefs / DIRECT_REF_BUDGET_PER_QUERY));
        // Coverage: chunking must not drop refs.
        expect(blockQueries.reduce((n, s) => n + directRefCount(s), 0)).toBe(totalBlockRefs);
        expect(atomQueries.reduce((n, s) => n + directRefCount(s), 0)).toBe(totalAtomRefs);
        // No fallback engaged, full content returned.
        expect(captured.some((s) => s.includes("document = content_document:"))).toBe(false);
        expect(byTurn.size).toBe(30);
    });

    test("at the pagination cap, the speculative fan-out exceeds the ceiling and falls back to per-document indexed fetches", async () => {
        // Fan-out math at the inspect pagination cap (2000 turns): 2000 docs x
        // 20 block refs = 40k > MAX_SPECULATIVE_REFS_PER_REQUEST, which
        // unbounded would have compounded to 40k x 40 = 1.6M atom refs in one
        // statement. The ceiling must reroute blocks AND atoms to the
        // per-document indexed path.
        const sourceRefs = Array.from({ length: 2000 }, (_, i) => `ref-${i}`);
        expect(sourceRefs.length * BLOCK_REFS_PER_DOC).toBeGreaterThan(MAX_SPECULATIVE_REFS_PER_REQUEST);
        const { byTurn, captured } = await runFastPath(sourceRefs);

        // No speculative block/atom record-list query at all past the ceiling.
        expect(captured.some((s) => s.includes("content_block:`"))).toBe(false);
        expect(captured.some((s) => s.includes("content_atom:`"))).toBe(false);
        // Per-document indexed fan-out instead - one block + one atom query per doc.
        const perDocBlocks = captured.filter(
            (s) => s.includes("FROM content_block") && s.includes("document = content_document:"),
        );
        const perDocAtoms = captured.filter(
            (s) => s.includes("FROM content_atom") && s.includes("document = content_document:"),
        );
        expect(perDocBlocks).toHaveLength(2000);
        expect(perDocAtoms).toHaveLength(2000);
        // Document resolution itself stays chunked within the budget.
        for (const sql of captured) {
            expect(directRefCount(sql)).toBeLessThanOrEqual(DIRECT_REF_BUDGET_PER_QUERY);
        }
        expect(captured.filter((s) => s.includes("content_document:`"))).toHaveLength(
            Math.ceil(sourceRefs.length / DIRECT_REF_BUDGET_PER_QUERY),
        );

        // Fallback still returns correct content, atoms included.
        expect(byTurn.size).toBe(2000);
        const first = byTurn.get(1);
        const last = byTurn.get(2000);
        expect(first?.blocks[0]?.text).toBe("hello");
        expect(first?.blocks[0]?.atoms[0]?.value).toBe("foo");
        expect(last?.blocks[0]?.text).toBe("hello");
        expect(last?.blocks[0]?.atoms).toHaveLength(1);
    });
});
