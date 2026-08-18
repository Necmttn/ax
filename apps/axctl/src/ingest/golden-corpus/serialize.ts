/**
 * Deterministic serialization of a NormalizedTranscriptBatch for the golden
 * transcript corpus (#876).
 *
 * The golden files are the parser CONTRACT: fixture in, exactly these rows
 * out. Serialization therefore has to be byte-stable across machines and
 * runs - object keys are sorted, Dates become ISO strings, undefined values
 * are dropped (JSON cannot carry them, and `{a: undefined}` must equal `{}`).
 * No field is filtered: if a parser emits something nondeterministic, the
 * right fix is in the parser (or an explicit, commented normalization here),
 * never a silent projection that hides part of the contract.
 */
import type { NormalizedTranscriptBatch } from "../normalized/transcripts.ts";

const toJsonValue = (value: unknown): unknown => {
    if (value === undefined) return undefined;
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return value;
    }
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "bigint") return value.toString();
    if (Array.isArray(value)) return value.map((item) => toJsonValue(item) ?? null);
    if (typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>)
            .map(([key, nested]) => [key, toJsonValue(nested)] as const)
            .filter(([, nested]) => nested !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return Object.fromEntries(entries);
    }
    // Functions/symbols have no place in a normalized batch.
    throw new Error(`golden-corpus: unserializable ${typeof value} in batch`);
};

/** The batch as a plain, key-sorted, Date-free JSON value. */
export const projectBatch = (batch: NormalizedTranscriptBatch): unknown => toJsonValue(batch);

/** Stable pretty JSON (trailing newline so the file diffs like source). */
export const stableStringify = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
