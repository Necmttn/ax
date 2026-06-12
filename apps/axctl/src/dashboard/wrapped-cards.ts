import { Effect, Schema } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { WrappedCardDto } from "@ax/lib/shared/dashboard-types";
import { surrealObject, surrealString } from "@ax/lib/shared/surql";

/**
 * Agent-authored Wrapped recap cards. `ax wrapped publish` replaces the
 * full set atomically (DELETE + CREATE) - the read side is a trivial
 * ordered select, deliberately uncached so a publish from the CLI shows
 * up on the next dashboard fetch (the daemon's in-memory TTL caches only
 * cover the expensive mechanical profile).
 */

const CardSchema = Schema.Struct({
    question: Schema.String,
    headline: Schema.String,
    body: Schema.String,
    sensitivity: Schema.optional(Schema.Literals(["public", "sensitive"])),
    /** real grounding data points, rendered as the card's bar strip */
    series: Schema.optional(Schema.Array(Schema.Number)),
    series_label: Schema.optional(Schema.String),
});

export const PublishInputSchema = Schema.Struct({
    cards: Schema.Array(CardSchema),
});

export type PublishInput = typeof PublishInputSchema.Type;

const MAX_CARDS = 24;

const CARDS_SQL = `SELECT question, headline, body, sensitivity, position, series, series_label FROM wrapped_card ORDER BY position ASC;`;

export const fetchWrappedCards = Effect.fn("dashboard.fetchWrappedCards")(
    function* () {
        const db = yield* SurrealClient;
        const result = yield* db.query<[Array<Record<string, unknown>>]>(CARDS_SQL);
        return (result[0] ?? []) as unknown as ReadonlyArray<WrappedCardDto>;
    },
);

/** Drop sensitive cards for the public preview. */
export const sanitizeWrappedCards = (
    cards: ReadonlyArray<WrappedCardDto>,
): ReadonlyArray<WrappedCardDto> =>
    cards.filter((c) => c.sensitivity !== "sensitive");

/** Pure: full-replace statement list. */
export const buildPublishStatements = (input: PublishInput): string[] => [
    "DELETE wrapped_card;",
    ...input.cards.map((card, index) =>
        `CREATE wrapped_card CONTENT ${surrealObject([
            ["question", surrealString(card.question)],
            ["headline", surrealString(card.headline)],
            ["body", surrealString(card.body)],
            ["sensitivity", surrealString(card.sensitivity ?? "public")],
            ["position", String(index)],
            // grounding series capped at 64 points - enough for daily/weekly shapes
            ["series", `[${(card.series ?? []).slice(0, 64).map((n) => String(Number(n) || 0)).join(", ")}]`],
            ...(card.series_label !== undefined
                ? ([["series_label", surrealString(card.series_label)]] as const)
                : []),
        ])};`,
    ),
];

export const runPublishCards = Effect.fn("dashboard.runPublishCards")(function* (
    raw: unknown,
) {
    const input = yield* Schema.decodeUnknownEffect(PublishInputSchema)(raw);
    if (input.cards.length === 0) {
        return yield* Effect.fail(new Error("publish needs at least 1 card"));
    }
    if (input.cards.length > MAX_CARDS) {
        return yield* Effect.fail(
            new Error(`publish accepts at most ${MAX_CARDS} cards (got ${input.cards.length})`),
        );
    }
    const db = yield* SurrealClient;
    for (const stmt of buildPublishStatements(input)) {
        yield* db.query(stmt);
    }
    return { status: "published" as const, count: input.cards.length };
});
