/**
 * Raw escape hatches: routes that cannot be jsonRoutes.
 *   - GET /api/events: long-lived SSE stream (ReadableStream response).
 *   - GET /api/image: binary body + cache headers, allowlisted extensions.
 *   - POST /api/ingest: forks runIngest onto the server's long-lived
 *     ManagedRuntime via the IngestStreamBus/Durable Streams seam.
 *     DO NOT restructure the workflow here (ADR-0007/0008).
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { AppLayer } from "@ax/lib/layers";
import { IngestRuntimeLayer } from "../../../ingest/stage/runtime.ts";
import { getServeIngestState } from "../../ingest-state.ts";
import { ingestStreamName } from "../../ingest-stream.ts";
import { startIngestWorkflow } from "../../ingest-workflow.ts";
import { addIngestEventSubscriber, removeIngestEventSubscriber } from "../../telemetry.ts";
import { jsonResponse, rawRoute, type AnyRoute } from "../router.ts";

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

export function formatSseEvent(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
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
 * is a localhost-only personal dev daemon; the safety line is: the path must
 * resolve to an EXISTING regular file with a known image extension. Anything
 * else - missing file, directory, non-image extension, read error - is a flat
 * 404, so we never follow into or leak non-image files.
 */
async function handleImageRequest(url: URL): Promise<Response> {
    const raw = url.searchParams.get("path");
    if (!raw) return new Response("not found", { status: 404 });
    const contentType = imageContentType(raw);
    if (!contentType) return new Response("not found", { status: 404 });
    try {
        const file = Bun.file(raw);
        // `exists()` is false for a missing path; a directory yields size 0 and
        // a failing read below. Bun.file on a dir does not throw on `exists`.
        if (!(await file.exists())) return new Response("not found", { status: 404 });
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

function handleEventsRequest(): Response {
    let subscriber: ((event: unknown) => void) | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;
    let closed = false;
    let sinceIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(formatSseEvent("ready", { ts: new Date().toISOString() })));
            subscriber = (event: unknown) => {
                controller.enqueue(new TextEncoder().encode(formatSseEvent("ingest_event", event)));
            };
            addIngestEventSubscriber(subscriber);
            interval = setInterval(async () => {
                if (closed) return;
                try {
                    const result = await Effect.runPromise(Effect.gen(function* () {
                        const db = yield* SurrealClient;
                        return yield* db.query<[Array<Record<string, unknown>>]>(recentIngestEventsSql(sinceIso));
                    }).pipe(Effect.provide(AppLayer), Effect.scoped) as Effect.Effect<[Array<Record<string, unknown>>]>);
                    for (const row of result?.[0] ?? []) {
                        if (closed) return;
                        controller.enqueue(new TextEncoder().encode(formatSseEvent("ingest_event", row)));
                        const ts = row.ts;
                        if (typeof ts === "string" || ts instanceof Date) {
                            sinceIso = new Date(ts).toISOString();
                        }
                    }
                } catch (error) {
                    if (!closed) {
                        controller.enqueue(new TextEncoder().encode(formatSseEvent("error", { message: error instanceof Error ? error.message : String(error) })));
                    }
                }
            }, 2000);
        },
        cancel() {
            closed = true;
            if (interval) clearInterval(interval);
            if (subscriber) removeIngestEventSubscriber(subscriber);
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

/** Handle `POST /api/ingest`: trigger an in-process run, return its `runId`. */
async function handleIngestTrigger(req: Request): Promise<Response> {
    const state = getServeIngestState();
    if (state === null) {
        // The handler can be invoked directly in tests without a running
        // server; the sidecar + runtime only exist once serveDashboard boots.
        return jsonResponse({ error: "ingest_unavailable" }, 503);
    }
    const stream = state.stream;
    if (stream === null) {
        // The Durable Streams sidecar failed to start (e.g. the compiled
        // single-file binary, which can't load native lmdb). The dashboard +
        // all other routes still work; live ingest is the only casualty.
        return jsonResponse({
            error: "live ingest unavailable: run ax from source (the compiled binary can't host the Durable Streams sidecar)",
        }, 503);
    }
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const sinceDays = typeof body.since === "number" && Number.isInteger(body.since) && body.since > 0
        ? body.since
        : undefined;
    try {
        // `runIngest` reads `--since=N` from `args` (see ingest/run.ts), so the
        // server-triggered run is shaped exactly like the CLI's `ax ingest`.
        const { runId } = await state.runtime.runPromise(
            startIngestWorkflow(
                {
                    command: "ingest",
                    args: sinceDays === undefined ? [] : [`--since=${sinceDays}`],
                    cwd: process.cwd(),
                },
                stream,
                IngestRuntimeLayer,
            ),
        );
        return jsonResponse({
            runId,
            stream: stream.streamUrl(runId),
            streamName: ingestStreamName(runId),
            streamBaseUrl: stream.baseUrl,
        });
    } catch (err) {
        return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
}

export const liveRoutes: ReadonlyArray<AnyRoute> = [
    rawRoute({ method: "GET", path: "/api/events", handler: () => handleEventsRequest() }),
    rawRoute({ method: "GET", path: "/api/image", handler: ({ url }) => handleImageRequest(url) }),
    rawRoute({ method: "POST", path: "/api/ingest", handler: ({ req }) => handleIngestTrigger(req) }),
];
