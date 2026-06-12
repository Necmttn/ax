/**
 * Query-param decode helpers backed by Effect Schema, per the repo norm in
 * docs/effect-json-boundaries.md / packages/lib/src/decode.ts. The helpers
 * preserve the if-chain's lenient semantics: a missing or non-finite numeric
 * param silently falls back instead of producing a 400.
 *
 * Only `optionalNumberParam` survives the contract migration (graph-explorer
 * is the last legacy decoder); `numberParam`/`csvParam` went with the rows
 * they served - contract endpoints decode via their query schemas.
 */
import { Option, Schema } from "effect";

const finiteFromString = Schema.decodeUnknownOption(Schema.FiniteFromString);

/** Numeric query param; undefined when absent or non-finite. */
export const optionalNumberParam = (url: URL, name: string): number | undefined => {
    const raw = url.searchParams.get(name);
    if (raw === null) return undefined;
    if (raw === "") return undefined;
    return Option.getOrUndefined(finiteFromString(raw));
};
