/**
 * Shared OG-poster metadata: the render revision plus the versioned og:image
 * URL builder. Lives in an underscore dir (not routed by Pages, importable by
 * route files) so the /s/ meta rewriter can version its og:image URLs without
 * bundling the poster renderer (workers-og).
 *
 * Why version at all: X / Slack / Discord cache card images keyed by the
 * literal og:image URL, so a poster-template change (e.g. r=5 -> r=6) never
 * reaches links that were already shared - the platform serves the stale
 * card forever. Folding the revision - and, when in hand, a hash of the
 * share's manifest - into a ?v= param gives every template change (and every
 * re-exported share) a fresh URL the platforms treat as a new image.
 */

/** Bump when the poster template changes; busts edge + social image caches. */
export const OG_RENDER_REV = 6;

/** FNV-1a 32-bit as 8 hex chars - tiny, synchronous, stable across runtimes. */
const fnv1a = (s: string): string => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
};

/**
 * Version tag for og:image URLs: `<rev>` alone, or `<rev>-<hash8>` when the
 * caller already holds the share's manifest text (re-exporting a share
 * rewrites the gist manifest, so the hash busts social caches for refreshed
 * shares too - no extra network call, the rewriter fetches it anyway).
 */
export const ogImageVersion = (manifestText?: string): string =>
    manifestText == null ? String(OG_RENDER_REV) : `${OG_RENDER_REV}-${fnv1a(manifestText)}`;

/** Absolute /og/ poster URL with the cache-busting ?v= version param. */
export const buildOgImageUrl = (owner: string, gistId: string, manifestText?: string): string =>
    `https://ax.necmttn.com/og/${owner}/${gistId}?v=${ogImageVersion(manifestText)}`;
