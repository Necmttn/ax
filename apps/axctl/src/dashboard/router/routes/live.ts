/**
 * Raw escape hatches: the two routes that stay OUTSIDE the Insights Surface
 * Contract permanently (ADR-0013):
 *   - GET /api/events: long-lived SSE stream (ReadableStream response).
 *   - GET /api/image: binary body + cache headers, allowlisted extensions.
 * POST /api/ingest is served by the contract router (contract/live.ts);
 * the IngestStreamBus/Durable Streams seam is unchanged (ADR-0007/0008).
 */
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, FileSystem } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { posixPath } from "@ax/lib/shared/path";
import { addIngestEventSubscriber, removeIngestEventSubscriber } from "../../telemetry.ts";
import { rawRoute, type AnyRoute, type EffectRunner } from "../router.ts";

/**
 * Map of supported image extension -> MIME type. This is the safety allowlist
 * for handleImageRequest: a path whose extension isn't here is refused
 * (404), so the local-image endpoint can only ever serve image bytes and never
 * arbitrary files. Keep in sync with the SPA's `IMAGE_EXTENSIONS`.
 */
const IMAGE_CONTENT_TYPES: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
    ".avif": "image/avif",
};

/** Content-type for a path by extension, or null if not a supported image. */
export function imageContentType(path: string): string | null {
    const dot = path.lastIndexOf(".");
    if (dot < 0) return null;
    return IMAGE_CONTENT_TYPES[path.slice(dot).toLowerCase()] ?? null;
}

function defaultImageRoots(): ReadonlyArray<string> {
    const roots = [process.env.TMPDIR ?? "/tmp"];
    const home = process.env.HOME;
    if (home) {
        roots.push(posixPath.join(home, "Library", "Application Support", "CleanShot", "media"));
    }
    return roots;
}

/**
 * True when a canonical path is an allowed root or one of its descendants.
 * Inputs are expected to be absolute, canonical paths.
 */
export function isPathWithinRoots(resolvedPath: string, roots: readonly string[]): boolean {
    return roots.some((root) => {
        const relative = posixPath.relative(root, resolvedPath);
        return relative === ""
            || (!relative.startsWith("..") && !posixPath.isAbsolute(relative));
    });
}

/**
 * Canonicalize a requested image and the allowed roots before checking
 * containment. Missing paths, non-files, unsupported extensions, and paths
 * outside every root are all rejected as null.
 */
export function resolveConfinedImage(
    rawPath: string,
    roots: readonly string[],
): Effect.Effect<string | null, never, FileSystem.FileSystem> {
    return Effect.gen(function* () {
        if (!posixPath.isAbsolute(rawPath) || !imageContentType(rawPath)) return null;

        const fs = yield* FileSystem.FileSystem;
        const resolvedPath = yield* fs.realPath(rawPath).pipe(orAbsent<string | null>(null));
        if (resolvedPath === null || !imageContentType(resolvedPath)) return null;

        const resolvedRoots = yield* Effect.forEach(roots, (root) =>
            fs.realPath(root).pipe(orAbsent<string | null>(null)),
        );
        if (!isPathWithinRoots(
            resolvedPath,
            resolvedRoots.filter((root): root is string => root !== null),
        )) {
            return null;
        }

        const info = yield* fs.stat(resolvedPath).pipe(orAbsent<FileSystem.File.Info | null>(null));
        return info?.type === "File" ? resolvedPath : null;
    });
}

export function formatSseEvent(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * SSE comment line. EventSource ignores comments (no listener fires), so this
 * is a pure keep-alive: it writes bytes to the socket without the client
 * treating it as an event. Needed because the daemon runs a 60s idleTimeout
 * (server.ts) and this stream only emits on new ingest rows - an idle studio
 * tab would otherwise see the socket reaped mid-response
 * (ERR_INCOMPLETE_CHUNKED_ENCODING) and reconnect-storm. See issue #503.
 */
export function formatSseComment(text: string): string {
    return `: ${text}\n\n`;
}

export function recentIngestEventsSql(sinceIso: string, limit = 50): string {
    const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 50;
    return `
SELECT id, run, source, stage, level, message, counts, raw, ts
FROM ingest_event
WHERE ts > d"${sinceIso}"
ORDER BY ts ASC
LIMIT ${safeLimit};`.trim();
}

/**
 * GET /api/image?path=<url-encoded-absolute-path>
 *
 * Serves a local on-disk image so the SPA can render `[Image: source: ...]`
 * transcript refs (a browser can't load `file://` from an http origin). This
 * is a localhost-only personal dev daemon; the safety line is: the canonical
 * path must stay inside an allowlisted image root and resolve to an existing
 * regular file with a known image extension. Anything else - missing file,
 * directory, non-image extension, boundary escape, read error - is a flat 404.
 */
export async function handleImageRequest(
    url: URL,
    roots: readonly string[] = defaultImageRoots(),
): Promise<Response> {
    const raw = url.searchParams.get("path");
    if (!raw) return new Response("not found", { status: 404 });
    try {
        const resolvedPath = await Effect.runPromise(
            resolveConfinedImage(raw, roots).pipe(Effect.provide(BunFileSystem.layer)),
        );
        if (resolvedPath === null) return new Response("not found", { status: 404 });
        const contentType = imageContentType(resolvedPath);
        if (!contentType) return new Response("not found", { status: 404 });
        const file = Bun.file(resolvedPath);
        const bytes = await file.arrayBuffer();
        return new Response(bytes, {
            headers: {
                "content-type": contentType,
                // Personal dev daemon; on-disk images are effectively immutable
                // (CleanShot writes unique filenames), so cache hard.
                "cache-control": "private, max-age=86400",
            },
        });
    } catch {
        return new Response("not found", { status: 404 });
    }
}

/**
 * GET /api/events - the studio Live SSE stream. Emits `ready` once, then for
 * each tick: a `: ping` keep-alive (issue #503) plus any new `ingest_event`
 * rows since the last seen timestamp. `intervalMs` is injectable for tests.
 */
export function handleEventsRequest(runner: EffectRunner, intervalMs = 2000): Response {
    let subscriber: ((event: unknown) => void) | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;
    let closed = false;
    // Guards against overlapping DB polls: setInterval does not await the async
    // work, so a poll slower than intervalMs would otherwise stack up multiple
    // concurrent queries against the same `sinceIso` and replay rows.
    let polling = false;
    let sinceIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const teardown = (): void => {
        if (closed) return;
        closed = true;
        if (interval) clearInterval(interval);
        if (subscriber) removeIngestEventSubscriber(subscriber);
    };

    const stream = new ReadableStream({
        start(controller) {
            const encoder = new TextEncoder();
            // Single write path. The controller can be closed/errored out from
            // under us (client disconnect before cancel() runs); enqueue throws
            // in that state, so we catch, tear down, and signal the caller to
            // stop rather than leaving an interval/subscriber dangling.
            const safeEnqueue = (frame: string): boolean => {
                if (closed) return false;
                try {
                    controller.enqueue(encoder.encode(frame));
                    return true;
                } catch {
                    teardown();
                    return false;
                }
            };

            safeEnqueue(formatSseEvent("ready", { ts: new Date().toISOString() }));
            subscriber = (event: unknown) => {
                safeEnqueue(formatSseEvent("ingest_event", event));
            };
            addIngestEventSubscriber(subscriber);

            interval = setInterval(() => {
                if (closed) return;
                // Keep-alive every tick, independent of the DB poll, so an idle
                // OR wedged-DB stream still writes bytes within the daemon's 60s
                // idleTimeout and the socket is not reaped out from under the
                // browser (issue #503).
                if (!safeEnqueue(formatSseComment("ping"))) return;
                if (polling) return;
                polling = true;
                void (async () => {
                    try {
                        const result = await runner(Effect.gen(function* () {
                            const db = yield* SurrealClient;
                            return yield* db.query<[Array<Record<string, unknown>>]>(recentIngestEventsSql(sinceIso));
                        }));
                        for (const row of result?.[0] ?? []) {
                            if (!safeEnqueue(formatSseEvent("ingest_event", row))) return;
                            const ts = row.ts;
                            if (typeof ts === "string" || ts instanceof Date) {
                                // Advance the cursor forward only; ISO-8601 UTC
                                // strings compare chronologically, so a late
                                // poll can never rewind it.
                                const next = new Date(ts).toISOString();
                                if (next > sinceIso) sinceIso = next;
                            }
                        }
                    } catch (error) {
                        safeEnqueue(formatSseEvent("error", { message: error instanceof Error ? error.message : String(error) }));
                    } finally {
                        polling = false;
                    }
                })();
            }, intervalMs);
        },
        cancel() {
            teardown();
        },
    });
    return new Response(stream, {
        headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
        },
    });
}

export const liveRoutes: ReadonlyArray<AnyRoute> = [
    rawRoute({ method: "ANY", path: "/api/events", handler: ({ runner }) => handleEventsRequest(runner) }),
    rawRoute({
        method: "GET",
        path: "/api/image",
        fallthroughOnMethodMismatch: true,
        handler: ({ url }) => handleImageRequest(url),
    }),
];
