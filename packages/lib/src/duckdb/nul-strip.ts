/**
 * Writer-side NUL-byte enforcement (#790), the missing half of the client's
 * bind-time guard.
 *
 * WHY THIS EXISTS. `client.ts` binds every VARCHAR through a NUL-terminated C
 * string, so a value containing U+0000 would be SILENTLY TRUNCATED at the first
 * NUL on the way in, and the length-less read accessor (`duckdb_value_varchar`
 * + `CString`) cannot detect that truncation on the way back out. The client
 * therefore REFUSES such a bind with a typed `DuckDbQueryError` - correct, and
 * it stays. But refusing is only half a contract: real transcripts DO carry
 * escaped NULs (a JSON "\\u0000" in tool output, a binary blob that leaked into
 * a text field), so with nothing enforcing the other half an unrestricted
 * `ax ingest` died on `INSERT INTO "turn" - parameter 6743 contains a NUL
 * byte`. This module is that other half: the write seam scrubs every bound text
 * value, so nothing carrying a NUL ever reaches a bind, and the client's guard
 * goes back to being the last line of defence rather than the first thing an
 * operator meets.
 *
 * STRIP, NOT ESCAPE - and the trade-off that buys. The alternatives were an
 * escape (the six literal characters "\\u0000", or a U+FFFD placeholder) and a
 * strip. An escape preserves the information that a NUL was there, but it
 * CHANGES THE STORED TEXT INTO SOMETHING NO SOURCE EVER CONTAINED: every reader
 * sees the escape, the FTS/BM25 indexes tokenize it, `LIKE` / `match_bm25`
 * queries have to know about it, and a transcript that literally spells
 * "\\u0000" (agents write that string about this very bug) becomes
 * indistinguishable from an escaped NUL. Stripping loses one code point that in
 * transcript text is always noise - never a word, never punctuation, never
 * anything a human wrote - and leaves the stored text identical to what a
 * NUL-free transcript would have produced. The accepted cost: stored text is
 * not a byte-exact copy of the source, and `"a" + NUL + "b"` becomes
 * indistinguishable from a genuine `"ab"`. That cost is paid back by making the
 * loss COUNTABLE rather than silent: {@link stripNulParams} reports how many
 * values it touched, the write seam accumulates the total, and a run that
 * scrubbed anything logs a warning naming the count.
 *
 * Pure and dependency-free on purpose, so the decision is unit-testable without
 * a database.
 */
import type { DuckDbParam } from "./types.ts";

/** U+0000, built from its code point rather than written as a literal. A raw
 *  NUL byte in a source file is invisible in every editor, diff and code
 *  review, and an editor or formatter that "cleans" the file would silently
 *  delete it - the one module whose whole job is to remove NULs must not be
 *  able to lose its own definition of one. */
export const NUL: string = String.fromCharCode(0);

/** True when `value` carries at least one U+0000 - the same question the
 *  bind-time guard in `client.ts` asks, kept in one place. */
export const hasNul = (value: string): boolean => value.includes(NUL);

/** `value` with every U+0000 removed. Nothing else is touched: other control
 *  characters (tabs, newlines, escape sequences) round-trip through a VARCHAR
 *  bind perfectly well and are frequently meaningful in transcript text. */
export const stripNul = (value: string): string => value.replaceAll(NUL, "");

/** The outcome of scrubbing one statement's parameters. `values` counts bound
 *  VALUES that carried at least one NUL, not the number of NUL bytes - "we
 *  changed 3 of the things you asked us to store" is the fact an operator
 *  needs, and one value can carry many NULs. */
export interface NulStripResult {
    readonly params: ReadonlyArray<DuckDbParam>;
    readonly values: number;
}

/**
 * Strip NUL bytes from every string parameter in `params`.
 *
 * Returns the ORIGINAL array (same reference, `values: 0`) when nothing needed
 * scrubbing, which is the overwhelmingly common case - a 500-row `putMany` on a
 * wide table binds thousands of parameters per statement, and allocating a
 * parallel array for every one of them would tax the whole ingest to serve the
 * rare row that actually carries a NUL.
 */
export const stripNulParams = (params: ReadonlyArray<DuckDbParam>): NulStripResult => {
    let first = -1;
    for (let i = 0; i < params.length; i += 1) {
        const param = params[i];
        if (typeof param === "string" && hasNul(param)) {
            first = i;
            break;
        }
    }
    if (first < 0) return { params, values: 0 };

    const scrubbed = params.slice();
    let values = 0;
    for (let i = first; i < scrubbed.length; i += 1) {
        const param = scrubbed[i];
        if (typeof param === "string" && hasNul(param)) {
            scrubbed[i] = stripNul(param);
            values += 1;
        }
    }
    return { params: scrubbed, values };
};
