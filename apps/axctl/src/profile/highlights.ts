/**
 * User-authored profile highlights: load/validate/save the local
 * ~/.ax/profile-highlights.json file. The profile block (no `v`) is what
 * buildProfile attaches; the file carries `v:1`. Atomic write via the shared
 * atomicWriteJson helper.
 *
 * loadHighlightsBlock distinguishes MISSING from INVALID: a missing file is
 * null (no highlights, normal), but a present-but-corrupt/schema-invalid file
 * THROWS - so a bad manual edit surfaces loudly instead of silently dropping
 * the published highlights block on the next (possibly unattended) publish.
 */
import { Effect, Schema } from "effect";
import { Highlights } from "./schema.ts";
import { atomicWriteJson } from "./fs.ts";

export const defaultHighlightsPath = (): string =>
    `${process.env.HOME}/.ax/profile-highlights.json`;

export const HighlightsFile = Schema.Struct({
    v: Schema.Literal(1),
    ...Highlights.fields,
});
export type HighlightsFile = typeof HighlightsFile.Type;

export const decodeHighlightsFile = (raw: unknown): Effect.Effect<HighlightsFile, unknown> =>
    Schema.decodeUnknownEffect(HighlightsFile)(raw);

/** Thrown by loadHighlightsBlock when the file exists but cannot be parsed/decoded. */
export class HighlightsInvalidError extends Error {
    readonly _tag = "HighlightsInvalidError";
    constructor(readonly path: string, readonly reason: string) {
        super(`highlights file invalid at ${path}: ${reason}`);
        this.name = "HighlightsInvalidError";
    }
}

/**
 * Returns the profile block (no `v`) for a valid file, null when the file is
 * absent, and THROWS HighlightsInvalidError when present-but-unreadable. The
 * missing-vs-invalid distinction is the whole point: callers must not confuse
 * "no highlights yet" with "the highlights got corrupted".
 */
export async function loadHighlightsBlock(path: string): Promise<Highlights | null> {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    let raw: unknown;
    try {
        raw = JSON.parse(await file.text());
    } catch (e) {
        throw new HighlightsInvalidError(path, e instanceof Error ? e.message : String(e));
    }
    try {
        const decoded = Schema.decodeUnknownSync(HighlightsFile)(raw);
        const { v: _v, ...block } = decoded;
        return block;
    } catch (e) {
        throw new HighlightsInvalidError(path, e instanceof Error ? e.message : String(e));
    }
}

export async function saveHighlightsFile(path: string, data: HighlightsFile): Promise<void> {
    await atomicWriteJson(path, data);
}
