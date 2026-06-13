/** kebab-case slug, <=50 chars, never empty (falls back to "draft"). */
export const slugify = (title: string): string => {
    const base = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 50)
        .replace(/-+$/g, "");
    return base.length > 0 ? base : "draft";
};

/** FNV-1a 32-bit, 8-hex. Stable, dependency-free; not for security. */
export const shortHash = (input: string): string => {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
};
