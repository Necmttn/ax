/** Shared helpers for contract group handlers. */
import { Effect } from "effect";
import { InternalError } from "@ax/lib/shared/api-contract";

export const errorText = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);

/** Legacy read-endpoint failure parity: `{ error }` body with HTTP 500. */
export const internal = (err: unknown): InternalError => new InternalError({ error: errorText(err) });

/** Map an effect's failures to the 500 InternalError contract. */
export const orInternal = <A, R>(effect: Effect.Effect<A, unknown, R>): Effect.Effect<A, InternalError, R> =>
    effect.pipe(Effect.mapError(internal));

/**
 * Force a payload to plain JSON data. `Schema.Unknown`'s JSON codec REJECTS
 * class instances on encode (empty 400 HttpApiSchemaError), and raw
 * SurrealDB rows carry `RecordId` instances. The legacy route table
 * serialized responses with `JSON.stringify`, so a stringify round-trip is
 * byte-identical to the legacy wire. Use on any handler that returns raw
 * query rows rather than JS-mapped plain objects.
 */
export const asJsonValue = <A>(value: A): unknown => JSON.parse(JSON.stringify(value));
