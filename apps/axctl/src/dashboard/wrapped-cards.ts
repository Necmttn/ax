import { Effect, Schema } from "effect";
import { CacheRead, type CacheWriteService } from "@ax/lib/duckdb/seam";
import { cacheRow, jsonParam } from "@ax/lib/duckdb/row";
import type { DuckDbParam } from "@ax/lib/duckdb/types";
import type { WrappedCardDto } from "@ax/lib/shared/dashboard-types";

/**
 * Agent-authored Wrapped recap cards. `ax wrapped publish` replaces the
 * full set atomically (DELETE + INSERT) - the read side is a trivial
 * ordered select, deliberately uncached so a publish from the CLI shows
 * up on the next dashboard fetch (the daemon's in-memory TTL caches only
 * cover the expensive mechanical profile).
 *
 * BOTH HALVES ARE ON THE DUCKDB SEAM (wave 3, `c-ingest-cutover`). The publish
 * used to emit `DELETE wrapped_card;` + one `CREATE ... CONTENT` per card as
 * SurrealQL text; it now writes through `CacheWriteService`, which means it
 * only runs under the ingest lock (`withConfigWrite` at the CLI call site).
 * The reader moved WITH it in the same commit on purpose: a ported writer left
 * beside a SurrealQL reader is not a half-done port, it is a silently EMPTY
 * feature - `ax wrapped publish` would report "published 12 cards" while the
 * dashboard queried a write-frozen engine and rendered none, with no error on
 * either side.
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

export class WrappedPublishInputError extends Schema.TaggedErrorClass<WrappedPublishInputError>(
    "WrappedPublishInputError",
)("WrappedPublishInputError", {
    message: Schema.String,
}) {}

/**
 * `position` is a reserved word in SQL, so it is quoted here as the seam quotes
 * every identifier it emits. `series` is JSON text, not a native list (the DDL
 * says so).
 */
const CARDS_SQL =
    `SELECT question, headline, body, sensitivity, "position", series, series_label `
    + `FROM wrapped_card ORDER BY "position" ASC`;

/**
 * The deck is read through `raw` rather than a `Schema`, and the reason is the
 * BIGINT trap: `"position"` is a BIGINT column, and `Schema.Number` over a
 * BIGINT yields ZERO ROWS instead of raising. `raw` hands back the driver's own
 * value and the coercion below is explicit and total, so a stored deck can
 * never decode to an empty one.
 */
export const fetchWrappedCards = Effect.fn("dashboard.fetchWrappedCards")(
    function* () {
        const read = yield* CacheRead;
        const rows = yield* read.raw(CARDS_SQL);
        return rows.rows.map((row): WrappedCardDto => ({
            question: String(row.question ?? ""),
            headline: String(row.headline ?? ""),
            body: String(row.body ?? ""),
            sensitivity: row.sensitivity === "sensitive" ? "sensitive" : "public",
            position: Number(row.position ?? 0),
            series: parseSeries(row.series),
            ...(typeof row.series_label === "string" ? { series_label: row.series_label } : {}),
        })) as ReadonlyArray<WrappedCardDto>;
    },
);

/** Stored `series` is JSON text. Anything unparseable degrades to no strip
 *  rather than failing the whole deck - a decorative sparkline is not worth a
 *  500 on the landing page. */
const parseSeries = (raw: unknown): ReadonlyArray<number> => {
    if (typeof raw !== "string" || raw.length === 0) return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map((n) => Number(n) || 0) : [];
    } catch {
        return [];
    }
};

/** Drop sensitive cards for the public preview. */
export const sanitizeWrappedCards = (
    cards: ReadonlyArray<WrappedCardDto>,
): ReadonlyArray<WrappedCardDto> =>
    cards.filter((c) => c.sensitivity !== "sensitive");

/**
 * Pure: the full-replace row set, in deck order.
 *
 * Ids are POSITIONAL (`card-0`, `card-1`, …) rather than random, so a publish
 * of the same deck is idempotent and the preceding DELETE is belt-and-braces
 * for a shrinking deck rather than the only thing keeping duplicates out.
 */
export const buildPublishRows = (
    input: PublishInput,
): ReadonlyArray<Record<string, DuckDbParam>> =>
    input.cards.map((card, index) =>
        cacheRow({
            id: `card-${index}`,
            question: card.question,
            headline: card.headline,
            body: card.body,
            sensitivity: card.sensitivity ?? "public",
            position: index,
            // grounding series capped at 64 points - enough for daily/weekly shapes
            series: jsonParam((card.series ?? []).slice(0, 64).map((n) => Number(n) || 0)),
            series_label: card.series_label ?? null,
            generated_at: new Date(),
        }),
    );

export const runPublishCards = Effect.fn("dashboard.runPublishCards")(function* (
    write: CacheWriteService,
    raw: unknown,
) {
    const input = yield* Schema.decodeUnknownEffect(PublishInputSchema)(raw);
    if (input.cards.length === 0) {
        return yield* new WrappedPublishInputError({ message: "publish needs at least 1 card" });
    }
    if (input.cards.length > MAX_CARDS) {
        return yield* new WrappedPublishInputError({
            message: `publish accepts at most ${MAX_CARDS} cards (got ${input.cards.length})`,
        });
    }
    // Full replace: the deck is authored as a whole, so a card the new deck
    // dropped must not survive as a stale row with a high `position`.
    yield* write.exec("DELETE FROM wrapped_card");
    yield* write.putMany("wrapped_card", buildPublishRows(input));
    return { status: "published" as const, count: input.cards.length };
});
