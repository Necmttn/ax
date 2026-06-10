/**
 * Query-param decode helpers backed by Effect Schema, per the repo norm in
 * docs/effect-json-boundaries.md / packages/lib/src/decode.ts. The helpers
 * preserve the if-chain's lenient semantics: a missing or non-finite numeric
 * param silently falls back instead of producing a 400.
 */
import { Option, Schema } from "effect";

const finiteFromString = Schema.decodeUnknownOption(Schema.FiniteFromString);

/** Numeric query param with fallback (legacy `Number.isFinite(x) ? x : d`). */
export const numberParam = (url: URL, name: string, fallback: number): number => {
    const raw = url.searchParams.get(name);
    if (raw === null) return fallback;
    return Option.getOrElse(finiteFromString(raw), () => fallback);
};

/** Numeric query param; undefined when absent or non-finite. */
export const optionalNumberParam = (url: URL, name: string): number | undefined => {
    const raw = url.searchParams.get(name);
    if (raw === null) return undefined;
    if (raw === "") return undefined;
    return Option.getOrUndefined(finiteFromString(raw));
};

/** Comma-separated values: split, trim, drop empties. */
export const csvParam = (url: URL, name: string): ReadonlyArray<string> =>
    (url.searchParams.get(name) ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
