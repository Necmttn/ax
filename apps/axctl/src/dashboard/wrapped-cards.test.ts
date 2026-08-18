import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { CacheReadLayer, type CacheWriteService } from "@ax/lib/duckdb/seam";
import {
    buildPublishRows,
    fetchWrappedCards,
    runPublishCards,
    sanitizeWrappedCards,
} from "./wrapped-cards.ts";
import type { WrappedCardDto } from "@ax/lib/shared/dashboard-types";

/**
 * Runs against a REAL temp DuckDB, not a route-table fake.
 *
 * A stub that logs statement text and asserts on the strings passes whichever
 * engine the writer actually talks to, which is exactly how a writer and its
 * reader can end up on different databases with a green suite. Here the
 * writer WRITES and the reader READS BACK, so the two halves are checked
 * against each other.
 */
const { dylibPath, dtest, tempDir } = await duckdbTestSetup("wrapped cards", { requireFts: true });

const card = (n: number, sensitivity = "public"): WrappedCardDto => ({
    question: `Q${n}?`,
    headline: `Headline ${n}`,
    body: `Body ${n}.`,
    sensitivity,
    position: n,
});

describe("sanitizeWrappedCards", () => {
    dtest("drops sensitive cards", () => {
        const out = sanitizeWrappedCards([card(0), card(1, "sensitive"), card(2)]);
        expect(out.map((c) => c.position)).toEqual([0, 2]);
    });
});

describe("buildPublishRows", () => {
    dtest("assigns positional ids and 0-based positions, defaulting sensitivity", () => {
        const rows = buildPublishRows({
            cards: [
                { question: "Q?", headline: "Big", body: "b", sensitivity: "sensitive" },
                { question: "Q2?", headline: "Bigger", body: "b2" },
            ],
        });
        expect(rows.map((r) => r["id"])).toEqual(["card-0", "card-1"]);
        expect(rows.map((r) => r["position"])).toEqual([0, 1]);
        expect(rows.map((r) => r["sensitivity"])).toEqual(["sensitive", "public"]);
        // series is JSON TEXT, never a native list (the DDL bans those).
        expect(rows[0]?.["series"]).toBe("[]");
    });
});

/** Publish `cards` into a fresh cache, then read the deck back through
 *  `CacheRead` over the published snapshot - the same path the dashboard uses. */
const publishThenRead = async (
    label: string,
    body: (write: CacheWriteService) => Effect.Effect<unknown, unknown, never>,
): Promise<ReadonlyArray<WrappedCardDto>> => {
    const fixture = await runWithPlatform(
        publishCacheFixture(tempDir(label), dylibPath, body),
    );
    return runWithPlatform(
        fetchWrappedCards().pipe(
            Effect.provide(
                CacheReadLayer({
                    snapshotPath: fixture.snapshotPath,
                    ...(dylibPath === null ? {} : { assetPath: dylibPath }),
                }),
            ),
        ),
    ) as Promise<ReadonlyArray<WrappedCardDto>>;
};

describe("runPublishCards", () => {
    dtest("writes a deck the reader can read back, in position order", async () => {
        const deck = await publishThenRead("wrapped-publish-", (write) =>
            runPublishCards(write, {
                cards: [
                    { question: "Q0?", headline: "H0", body: "b0", series: [1, 2, 3] },
                    { question: "Q1?", headline: "H1", body: "b1", sensitivity: "sensitive" },
                ],
            }) as Effect.Effect<unknown, unknown, never>);

        expect(deck).toHaveLength(2);
        expect(deck.map((c) => c.headline)).toEqual(["H0", "H1"]);
        expect(deck.map((c) => c.position)).toEqual([0, 1]);
        expect(deck[0]?.series).toEqual([1, 2, 3]);
        expect(deck[1]?.sensitivity).toBe("sensitive");
    }, 60_000);

    dtest("a republish REPLACES the deck rather than appending to it", async () => {
        const deck = await publishThenRead("wrapped-republish-", (write) =>
            Effect.gen(function* () {
                yield* runPublishCards(write, {
                    cards: [
                        { question: "old0", headline: "OLD0", body: "b" },
                        { question: "old1", headline: "OLD1", body: "b" },
                        { question: "old2", headline: "OLD2", body: "b" },
                    ],
                });
                yield* runPublishCards(write, {
                    cards: [{ question: "new0", headline: "NEW0", body: "b" }],
                });
            }) as Effect.Effect<unknown, unknown, never>);

        expect(deck.map((c) => c.headline)).toEqual(["NEW0"]);
    }, 60_000);

    dtest("rejects an empty deck", async () => {
        await expect(
            publishThenRead("wrapped-empty-", (write) =>
                runPublishCards(write, { cards: [] }) as Effect.Effect<unknown, unknown, never>),
        ).rejects.toThrow("at least 1 card");
    }, 60_000);

    dtest("rejects more than 24 cards", async () => {
        const cards = Array.from({ length: 25 }, (_, i) => ({
            question: `Q${i}?`,
            headline: `H${i}`,
            body: "b",
        }));
        await expect(
            publishThenRead("wrapped-toomany-", (write) =>
                runPublishCards(write, { cards }) as Effect.Effect<unknown, unknown, never>),
        ).rejects.toThrow("at most 24");
    }, 60_000);

    dtest("rejects an unknown sensitivity", async () => {
        await expect(
            publishThenRead("wrapped-badsens-", (write) =>
                runPublishCards(write, {
                    cards: [{ question: "Q?", headline: "H", body: "b", sensitivity: "secret" }],
                }) as Effect.Effect<unknown, unknown, never>),
        ).rejects.toThrow();
    }, 60_000);
});
