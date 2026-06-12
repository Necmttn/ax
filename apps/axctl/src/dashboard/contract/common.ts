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
