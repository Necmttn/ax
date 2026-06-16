/**
 * Serve the studio SPA from `ax serve` itself, same-origin with the local
 * daemon, so the dashboard works without the hosted https studio reaching
 * across to a loopback daemon (mixed-content / Private Network Access hell -
 * the bug this replaces).
 *
 * Two backing stores, in priority order:
 *
 *   1. Embedded (`STUDIO_EMBED`) - the compiled `ax` binary has no source
 *      tree, so its build bakes the studio daemon build in via `{ type: "file" }`
 *      imports (see scripts/gen-studio-embed.ts). Reads via `Bun.file` from the
 *      embedded `/$bunfs` path.
 *   2. Disk (`apps/studio/dist`) - when running `ax` from source the embed map
 *      is the empty stub, so we read the on-disk daemon build instead. This is
 *      the dogfooding path; rebuild with `bun --filter @ax/studio build`.
 *
 * Unknown non-asset routes fall back to `index.html` (SPA client routing).
 * Returns null when neither store has the path, so the caller can show the
 * daemon landing page instead.
 */
import { fileURLToPath } from "node:url";
import { STUDIO_EMBED } from "./studio-embed.gen.ts";

const CONTENT_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".wasm": "application/wasm",
};

function contentType(path: string): string {
    const dot = path.lastIndexOf(".");
    const ext = dot === -1 ? "" : path.slice(dot).toLowerCase();
    return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

const HAS_EMBED = Object.keys(STUDIO_EMBED).length > 0;
// Trailing slash kept so a relative asset path appends cleanly without node:path.
const DISK_ROOT = fileURLToPath(new URL("../../../studio/dist/", import.meta.url));

function fileResponse(filePath: string, urlPath: string): Response {
    return new Response(Bun.file(filePath), {
        headers: { "content-type": contentType(urlPath) },
    });
}

/**
 * Resolve a request pathname to a studio asset Response, or null if this build
 * does not bundle studio (and nothing is on disk). Asset misses under /assets/
 * return null (a genuine 404) rather than the SPA shell, so a hashed-filename
 * mismatch surfaces instead of silently serving HTML for a `.js`.
 */
export async function serveStudioAsset(pathname: string): Promise<Response | null> {
    // Path-traversal guard: pathnames are already URL-decoded by the runtime,
    // but a literal ".." must never escape the embed map / disk root.
    if (pathname.includes("..")) return null;
    const clean = pathname === "/" || pathname === "" ? "/index.html" : pathname;

    if (HAS_EMBED) {
        const hit = STUDIO_EMBED[clean];
        if (hit) return fileResponse(hit, clean);
        if (!clean.startsWith("/assets/")) {
            const index = STUDIO_EMBED["/index.html"];
            if (index) return fileResponse(index, "/index.html");
        }
        return null;
    }

    // Source / dogfood path: read the on-disk daemon build. DISK_ROOT ends in a
    // slash and clean.slice(1) drops the leading slash, so a plain concat is a
    // valid path join (and keeps node:path out - repo gate check:no-node-fs).
    const directPath = DISK_ROOT + clean.slice(1);
    if (await Bun.file(directPath).exists()) return fileResponse(directPath, clean);
    if (!clean.startsWith("/assets/")) {
        const indexPath = `${DISK_ROOT}index.html`;
        if (await Bun.file(indexPath).exists()) return fileResponse(indexPath, "/index.html");
    }
    return null;
}
