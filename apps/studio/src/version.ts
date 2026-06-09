/** This studio bundle's released version, baked in by vite `define` at build
 *  time (see vite.config.ts). The `typeof` guard keeps the module importable in
 *  plain runtimes (e.g. bun:test) where the build-time global isn't defined. */
export const STUDIO_VERSION: string =
    typeof __STUDIO_VERSION__ !== "undefined" ? __STUDIO_VERSION__ : "0.0.0";

/** Compare two `major.minor.patch` strings. <0 if a<b, >0 if a>b, 0 if equal.
 *  Tolerates missing/garbage segments (treated as 0). Used to flag a
 *  studio↔daemon version mismatch in the live banner. */
export function cmpSemver(a: string, b: string): number {
    const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
    const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) return Math.sign(d);
    }
    return 0;
}
