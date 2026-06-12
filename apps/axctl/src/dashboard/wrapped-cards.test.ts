import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import {
    buildPublishStatements,
    fetchWrappedCards,
    runPublishCards,
    sanitizeWrappedCards,
} from "./wrapped-cards.ts";

const card = (n: number, sensitivity = "public") => ({
    question: `Q${n}?`,
    headline: `Headline ${n}`,
    body: `Body ${n}.`,
    sensitivity,
    position: n,
});

const makeDb = (rows: Array<Record<string, unknown>>, log: string[] = []) => {
    const stub: SurrealClientShape = {
        query: (sql: string) => {
            log.push(sql);
            return Effect.succeed([rows]);
        },
    } as unknown as SurrealClientShape;
    return Layer.succeed(SurrealClient, stub);
};

describe("fetchWrappedCards", () => {
    test("returns ordered rows", async () => {
        const rows = await Effect.runPromise(
            fetchWrappedCards().pipe(Effect.provide(makeDb([card(0), card(1)]))),
        );
        expect(rows).toHaveLength(2);
        expect(rows[0]?.headline).toBe("Headline 0");
    });
});

describe("sanitizeWrappedCards", () => {
    test("drops sensitive cards", () => {
        const out = sanitizeWrappedCards([card(0), card(1, "sensitive"), card(2)]);
        expect(out.map((c) => c.position)).toEqual([0, 2]);
    });
});

describe("buildPublishStatements", () => {
    test("full replace: DELETE first, CREATE per card with index positions", () => {
        const stmts = buildPublishStatements({
            cards: [
                { question: "Q?", headline: "Big", body: "b", sensitivity: "sensitive" },
                { question: "Q2?", headline: "Bigger", body: "b2" },
            ],
        });
        expect(stmts[0]).toBe("DELETE wrapped_card;");
        expect(stmts).toHaveLength(3);
        expect(stmts[1]).toContain('sensitivity: "sensitive"');
        expect(stmts[1]).toContain("position: 0");
        expect(stmts[2]).toContain('sensitivity: "public"');
        expect(stmts[2]).toContain("position: 1");
    });
});

describe("runPublishCards", () => {
    test("publishes valid input", async () => {
        const log: string[] = [];
        const res = await Effect.runPromise(
            runPublishCards({ cards: [{ question: "Q?", headline: "H", body: "b" }] }).pipe(
                Effect.provide(makeDb([], log)),
            ),
        );
        expect(res).toEqual({ status: "published", count: 1 });
        expect(log[0]).toBe("DELETE wrapped_card;");
        expect(log[1]).toContain("CREATE wrapped_card CONTENT");
    });

    test("rejects empty card list", async () => {
        await expect(
            Effect.runPromise(
                runPublishCards({ cards: [] }).pipe(Effect.provide(makeDb([]))),
            ),
        ).rejects.toThrow("at least 1 card");
    });

    test("rejects more than 24 cards", async () => {
        const cards = Array.from({ length: 25 }, (_, i) => ({
            question: `Q${i}?`,
            headline: `H${i}`,
            body: "b",
        }));
        await expect(
            Effect.runPromise(
                runPublishCards({ cards }).pipe(Effect.provide(makeDb([]))),
            ),
        ).rejects.toThrow("at most 24");
    });

    test("rejects bad sensitivity", async () => {
        await expect(
            Effect.runPromise(
                runPublishCards({
                    cards: [{ question: "Q?", headline: "H", body: "b", sensitivity: "secret" }],
                }).pipe(Effect.provide(makeDb([]))),
            ),
        ).rejects.toThrow();
    });
});
