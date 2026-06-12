/**
 * Parser Toolkit - the shared JSON-access layer of the Derivation Engine that
 * the provider parsers (claude, codex, pi, opencode, cursor) compose.
 *
 * Every helper here was copy-pasted across 2-5 parsers before this module
 * existed. Where two copies differed SUBTLY the variants are kept as distinct
 * exports (see the three `*Field` number probes) so each call site preserves
 * its exact pre-toolkit behavior - never "merge and hope".
 */
import { Option, Schema } from "effect";
import { decodeJsonOrNull, jsonParseErrorText } from "@ax/lib/decode";

/** Narrow `unknown` to a plain JSON object record (arrays excluded). */
export function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input);
}

/** A string field, or null when absent / not a string. */
export function stringField(input: Record<string, unknown>, field: string): string | null {
    const value = input[field];
    return typeof value === "string" ? value : null;
}

/**
 * STRICT number probe: a finite `number` value, otherwise null. No string
 * coercion, no truncation. (pi + claude variant.)
 */
export function numberField(input: Record<string, unknown>, field: string): number | null {
    const value = input[field];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * INTEGER probe: accepts a number OR a numeric string, truncates to an
 * integer, null when non-finite. (codex variant - token counts arrive as
 * either type in codex transcripts.)
 */
export function intField(input: Record<string, unknown>, field: string): number | null {
    const value = input[field];
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * COERCING number probe: number, bigint, or numeric string - NOT truncated.
 * (opencode variant - SQLite hands back bigints and stringly numbers.)
 */
export function coercedNumberField(input: Record<string, unknown>, field: string): number | null {
    const value = input[field];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "bigint") return Number(value);
    if (typeof value !== "string" || value.trim().length === 0) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

/** A boolean field, or null when absent / not a boolean. */
export function booleanField(input: Record<string, unknown>, field: string): boolean | null {
    const value = input[field];
    return typeof value === "boolean" ? value : null;
}

/** A string field nested one record deep (`input[objectField][field]`). */
export function nestedStringField(
    input: Record<string, unknown>,
    objectField: string,
    field: string,
): string | null {
    const value = input[objectField];
    if (!isRecord(value)) return null;
    return stringField(value, field);
}

/** Decode one JSONL line into a record; null for unparseable JSON or a
 *  non-record payload. (claude + codex + pi line boundary.) */
export function parseJsonl(line: string): Record<string, unknown> | null {
    const decoded = decodeJsonOrNull(line);
    return isRecord(decoded) ? decoded : null;
}

/** Effect-Schema-backed JSON decode at the SQLite blob boundary. `Option`
 *  (not `null`) so a literal JSON `null` is distinguishable from a failed
 *  parse. */
const decodeJsonStringOption = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);

/**
 * Decode a SQLite-sourced JSON blob into a record, pushing a labelled warning
 * for missing / invalid / non-object data. (opencode + cursor boundary; the
 * `typeof raw !== "string"` guard is exactly the null check for the declared
 * `string | null` input, so both pre-toolkit copies behave identically.)
 */
export function parseJsonRecord(
    raw: string | null,
    label: string,
    warnings: string[],
): Record<string, unknown> | null {
    if (typeof raw !== "string" || raw.trim().length === 0) {
        warnings.push(`${label}: missing JSON data`);
        return null;
    }
    const parsed = decodeJsonStringOption(raw);
    if (Option.isNone(parsed)) {
        warnings.push(`${label}: invalid JSON data (${jsonParseErrorText(raw)})`);
        return null;
    }
    if (isRecord(parsed.value)) return parsed.value;
    warnings.push(`${label}: JSON data is not an object`);
    return null;
}

/**
 * Parse a value that MAY be a JSON string: strings decode (falling back to
 * the original string on parse failure), non-strings pass through, with
 * nullish input collapsing to null. (codex `arguments` + opencode part
 * inputs + pi tool inputs.)
 */
export function parseMaybeJson(input: unknown): unknown {
    if (typeof input !== "string") return input ?? null;
    return decodeJsonOrNull(input) ?? input;
}

/** `JSON.stringify`, with `undefined` results and throwing inputs collapsed
 *  to null. (claude + codex.) */
export function jsonText(input: unknown): string | null {
    try {
        const encoded = JSON.stringify(input);
        return encoded === undefined ? null : encoded;
    } catch {
        return null;
    }
}

/** Plain bounded slice of a string - no normalization, no ellipsis.
 *  (pi + opencode excerpt bound.) */
export function boundedExcerpt(text: string, max = 1200): string {
    return text.length <= max ? text : text.slice(0, max);
}

/**
 * Bounded excerpt of an ARBITRARY value: stringify non-strings, normalize
 * CRLF, trim, and ellipsis-terminate when clipped; null for empty/nullish
 * input. (cursor variant - deliberately different from {@link boundedExcerpt}.)
 */
export function boundExcerpt(input: unknown, max = 1200): string | null {
    let text: string | null = null;
    if (typeof input === "string") {
        text = input;
    } else if (input !== null && input !== undefined) {
        try {
            text = JSON.stringify(input);
        } catch {
            text = String(input);
        }
    }
    if (text === null) return null;
    const normalized = text.replace(/\r\n/g, "\n").trim();
    if (normalized.length === 0) return null;
    return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

/** The string members of an array value, or null when not an array.
 *  (compaction raw interpreters.) */
export function stringArray(input: unknown): readonly string[] | null {
    return Array.isArray(input) ? input.filter((x): x is string => typeof x === "string") : null;
}
