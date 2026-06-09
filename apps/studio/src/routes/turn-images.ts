/**
 * Local on-disk image references in transcript turns.
 *
 * Some harnesses inline a user's pasted screenshot as a TEXT marker in the
 * turn's `raw_text`. Two shapes appear in real data:
 *
 *   1. `[Image: source: /abs/path/to/CleanShot 2026-06-09 at 10.00.51@2x.png]`
 *      - carries an absolute on-disk path. RESOLVABLE: when the file still
 *        exists locally the dashboard can render the actual image.
 *   2. `[Image #3]`
 *      - a bare marker, no path. NOT resolvable; left as text.
 *
 * `extractImagePaths` pulls the absolute paths from form (1) only, and only
 * when the path ends in a known image extension. Paths may contain spaces
 * (CleanShot filenames do), so the regex is non-greedy up to the closing `]`
 * and we validate the extension afterward.
 */

/** Image extensions we will attempt to render inline. Lowercase, no dot. */
export const IMAGE_EXTENSIONS = [
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "bmp",
    "svg",
    "avif",
] as const;

const EXT_RE = new RegExp(`\\.(?:${IMAGE_EXTENSIONS.join("|")})$`, "i");

// `[Image: source: <path>]` - capture everything up to the closing bracket.
// Non-greedy so adjacent refs on one line don't merge; `[^\]]` keeps us within
// a single ref. Path may contain spaces, `@`, etc.
const IMAGE_REF_RE = /\[Image:\s*source:\s*([^\]]+?)\s*\]/gi;

/**
 * Return the absolute on-disk image paths referenced by `[Image: source: …]`
 * markers in `text`. Ignores bare `[Image #N]` markers and any path that does
 * not end in a known image extension. Order-preserving; does not dedupe.
 */
export function extractImagePaths(text: string): string[] {
    if (!text) return [];
    const paths: string[] = [];
    for (const match of text.matchAll(IMAGE_REF_RE)) {
        const path = match[1]?.trim();
        if (path && EXT_RE.test(path)) paths.push(path);
    }
    return paths;
}

/**
 * True when `text` is a "pure image attachment" - it carries at least one
 * renderable `[Image: source: …]` ref AND, once every such ref is stripped,
 * nothing but whitespace remains.
 *
 * Claude Code splits a pasted screenshot across two adjacent turns: the user's
 * actual message (carrying a bare `[Image #N]` marker, NO source path) and a
 * standalone follow-on turn whose text is essentially just the resolved
 * `[Image: source: /abs/path.png]`. This predicate identifies that follow-on
 * turn so the pairing pass can fold its image into the referencing message and
 * collapse it. A real message that merely mentions an image (prose around the
 * ref) is NOT pure and stays put.
 */
export function isPureImageAttachment(text: string): boolean {
    if (!text) return false;
    if (extractImagePaths(text).length === 0) return false;
    // Strip only the refs we'd actually render (extension-validated). A path
    // that fails the extension check would survive as residual non-whitespace,
    // so it can't be confused for a pure attachment.
    let residual = "";
    let lastIndex = 0;
    for (const match of text.matchAll(IMAGE_REF_RE)) {
        const path = match[1]?.trim();
        if (path && EXT_RE.test(path)) {
            residual += text.slice(lastIndex, match.index);
            lastIndex = match.index + match[0].length;
        }
    }
    residual += text.slice(lastIndex);
    return residual.trim().length === 0;
}
