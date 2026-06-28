/**
 * Shared public OG image URL helpers. Kept dependency-free so both the CLI
 * and Cloudflare Pages functions can import the same cache-busting revision.
 */

/** Bump when the poster template changes; busts edge + social image caches. */
export const OG_RENDER_REV = 9;

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
 * caller already holds the share's manifest text.
 */
export const ogImageVersion = (manifestText?: string): string =>
    manifestText == null ? String(OG_RENDER_REV) : `${OG_RENDER_REV}-${fnv1a(manifestText)}`;

/** Absolute /og/ poster URL with the cache-busting ?v= version param. */
export const buildOgImageUrl = (owner: string, gistId: string, manifestText?: string): string =>
    `https://ax.necmttn.com/og/${owner}/${gistId}?v=${ogImageVersion(manifestText)}`;

/** Absolute /og-profile/ poster URL for a profile login with the cache-busting ?r= param. */
export const buildProfileOgImageUrl = (login: string): string =>
    `https://ax.necmttn.com/og-profile/${login}?r=${OG_RENDER_REV}`;
