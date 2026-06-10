import { Effect, type Layer, ManagedRuntime } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { AppLayer } from "@ax/lib/layers";
import { IngestRuntimeLayer } from "../ingest/stage/runtime.ts";
import { createDurableIngestStream, type DurableIngestStream } from "./ingest-stream-durable.ts";
import { ingestStreamName } from "./ingest-stream.ts";
import { startIngestWorkflow } from "./ingest-workflow.ts";
import { addIngestEventSubscriber, removeIngestEventSubscriber } from "./telemetry.ts";
import {
    clearSkillDecision,
    fetchSkillTriage,
    isTriageDecision,
    listSkillDecisions,
    setSkillDecision,
    setSkillDecisionsBulk,
} from "./triage.ts";
import { fetchSkillDetail } from "../queries/skill-detail.ts";
import {
    applySkillDecisionToDisk,
    openSkillTarget,
    readSkillSource,
} from "./skill-source.ts";
import { dispatch, jsonResponse } from "./router/router.ts";
import { routeTable } from "./router/table.ts";

/**
 * Map of supported image extension → MIME type. This is the safety allowlist
 * for {@link handleImageRequest}: a path whose extension isn't here is refused
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

/**
 * GET /api/image?path=<url-encoded-absolute-path>
 *
 * Serves a local on-disk image so the SPA can render `[Image: source: …]`
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

export function parseDashboardServeArgs(args: string[]): { port: number } {
    const raw = args.find((arg) => arg.startsWith("--port="))?.split("=")[1];
    const port = raw === undefined ? 1738 : Number(raw);
    if (!Number.isInteger(port) || port <= 0) throw new Error(`--port must be a positive integer (got ${raw})`);
    return { port };
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
 * POST /api/improve/:sig/accept body: { force?: boolean }
 * POST /api/improve/:sig/reject body: { reason?: string }
 * POST /api/improve/:sig/verdict body: { verdict: string }
 *
 * Single handler dispatches all three; shared logic lives in
 * src/improve/actions.ts so the CLI and HTTP paths agree on semantics.
 */
async function handleImproveAction(
    sig: string,
    action: "accept" | "reject" | "verdict",
    req: Request,
): Promise<Response> {
    if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
    let body: Record<string, unknown> = {};
    try { body = (await req.json()) as Record<string, unknown>; } catch { /* empty body ok */ }

    try {
        const result = await Effect.runPromise(
            Effect.gen(function* () {
                if (action === "accept") {
                    const force = body.force === true;
                    const { acceptProposal } = yield* Effect.promise(() => import("../improve/actions.ts"));
                    return yield* acceptProposal({ sigOrId: sig, force });
                }
                if (action === "reject") {
                    const reason = typeof body.reason === "string" ? body.reason : undefined;
                    const { rejectProposal } = yield* Effect.promise(() => import("../improve/actions.ts"));
                    return yield* rejectProposal({ sigOrId: sig, ...(reason === undefined ? {} : { reason }) });
                }
                const verdict = typeof body.verdict === "string" ? body.verdict : "";
                const { setVerdict } = yield* Effect.promise(() => import("../improve/actions.ts"));
                return yield* setVerdict({ sigOrId: sig, verdict });
            }).pipe(Effect.provide(AppLayer), Effect.scoped) as Effect.Effect<{ readonly status: string; readonly message?: string }>,
        );
        const httpStatus = result.status === "ok" ? 200
            : result.status === "not_found" ? 404
            : result.status === "wrong_status" || result.status === "scaffold_exists" || result.status === "verdict_locked" ? 409
            : result.status === "unsupported_form" || result.status === "missing_payload" || result.status === "invalid_verdict" ? 400
            : 500;
        return jsonResponse(result, httpStatus);
    } catch (err) {
        return jsonResponse(
            { error: err instanceof Error ? err.message : String(err) },
            500,
        );
    }
}

/**
 * POST /api/skills/:name/decide body: { decision, reason? }
 * DELETE /api/skills/:name/decide  - clears the decision
 */
async function handleSkillDecision(name: string, req: Request): Promise<Response> {
    if (req.method === "DELETE") {
        try {
            await Effect.runPromise(
                Effect.gen(function* () {
                    yield* clearSkillDecision(name);
                    // Clearing a decision restores the skill on disk - a
                    // cleared skill is no longer archive-decided.
                    yield* applySkillDecisionToDisk(name, null);
                }).pipe(
                    Effect.provide(AppLayer),
                    Effect.scoped,
                ) as Effect.Effect<unknown>,
            );
            return jsonResponse({ cleared: true, skill_name: name });
        } catch (err) {
            return jsonResponse(
                { error: err instanceof Error ? err.message : String(err) },
                500,
            );
        }
    }
    if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
    let payload: { decision?: unknown; reason?: unknown };
    try {
        payload = (await req.json()) as { decision?: unknown; reason?: unknown };
    } catch {
        return jsonResponse({ error: "invalid_json" }, 400);
    }
    if (!isTriageDecision(payload.decision)) {
        return jsonResponse(
            { error: "decision must be one of keep|archive|review" },
            400,
        );
    }
    // Capture the narrowed value before the closure below - the type
    // predicate's narrowing does not reach into the nested Effect.gen.
    const decision = payload.decision;
    const reason =
        typeof payload.reason === "string" && payload.reason.trim().length > 0
            ? payload.reason.trim()
            : null;
    try {
        const note = await Effect.runPromise(
            Effect.gen(function* () {
                const saved = yield* setSkillDecision(name, decision, reason);
                // `archive` disables the skill on disk; `keep`/`review`
                // restores it. No-op for non-editable (plugin/builtin) scopes.
                yield* applySkillDecisionToDisk(name, decision);
                return saved;
            }).pipe(
                Effect.provide(AppLayer),
                Effect.scoped,
            ) as Effect.Effect<unknown>,
        );
        return jsonResponse(note);
    } catch (err) {
        return jsonResponse(
            { error: err instanceof Error ? err.message : String(err) },
            500,
        );
    }
}

/** GET /api/skills/:name/detail - evidence behind the recommendation. */
async function handleSkillDetail(name: string): Promise<Response> {
    try {
        const payload = await Effect.runPromise(
            fetchSkillDetail(name).pipe(
                Effect.provide(AppLayer),
                Effect.scoped,
            ) as Effect.Effect<unknown>,
        );
        return jsonResponse(payload);
    } catch (err) {
        return jsonResponse(
            { error: err instanceof Error ? err.message : String(err) },
            500,
        );
    }
}

/** GET /api/skills/:name/source - SKILL.md frontmatter + body + disk state. */
async function handleSkillSource(name: string): Promise<Response> {
    try {
        const payload = await Effect.runPromise(
            readSkillSource(name).pipe(
                Effect.provide(AppLayer),
                Effect.scoped,
            ) as Effect.Effect<unknown>,
        );
        return jsonResponse(payload);
    } catch (err) {
        return jsonResponse(
            { error: err instanceof Error ? err.message : String(err) },
            500,
        );
    }
}

/** POST /api/skills/:name/open body: { target: "finder" | "editor" } */
async function handleSkillOpen(name: string, req: Request): Promise<Response> {
    if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
    let payload: { target?: unknown };
    try {
        payload = (await req.json()) as { target?: unknown };
    } catch {
        return jsonResponse({ error: "invalid_json" }, 400);
    }
    const target =
        payload.target === "editor" ? "editor"
        : payload.target === "finder" ? "finder"
        : null;
    if (!target) {
        return jsonResponse({ error: "target must be 'finder' or 'editor'" }, 400);
    }
    try {
        const result = await Effect.runPromise(
            openSkillTarget(name, target).pipe(
                Effect.provide(AppLayer),
                Effect.scoped,
            ) as Effect.Effect<unknown>,
        );
        return jsonResponse(result);
    } catch (err) {
        return jsonResponse(
            { error: err instanceof Error ? err.message : String(err) },
            500,
        );
    }
}

/** POST /api/skills/decide-bulk body: { names: string[], decision, reason? } */
async function handleSkillBulkDecision(req: Request): Promise<Response> {
    if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
    let payload: { names?: unknown; decision?: unknown; reason?: unknown };
    try {
        payload = (await req.json()) as typeof payload;
    } catch {
        return jsonResponse({ error: "invalid_json" }, 400);
    }
    if (!Array.isArray(payload.names) || payload.names.length === 0) {
        return jsonResponse({ error: "names must be a non-empty array of skill names" }, 400);
    }
    const names = payload.names.filter(
        (n): n is string => typeof n === "string" && n.length > 0,
    );
    if (names.length === 0) {
        return jsonResponse({ error: "no valid skill names provided" }, 400);
    }
    if (!isTriageDecision(payload.decision)) {
        return jsonResponse({ error: "decision must be one of keep|archive|review" }, 400);
    }
    // Capture the narrowed value before the closure below - the type
    // predicate's narrowing of `payload.decision` does not reach into the
    // nested Effect.gen generator.
    const decision = payload.decision;
    const reason =
        typeof payload.reason === "string" && payload.reason.trim().length > 0
            ? payload.reason.trim()
            : null;
    try {
        const notes = await Effect.runPromise(
            Effect.gen(function* () {
                const saved = yield* setSkillDecisionsBulk(names, decision, reason);
                // Reflect the decision onto disk for every editable skill.
                for (const skillName of names) {
                    yield* applySkillDecisionToDisk(skillName, decision);
                }
                return saved;
            }).pipe(
                Effect.provide(AppLayer),
                Effect.scoped,
            ) as Effect.Effect<unknown>,
        );
        return jsonResponse({ notes });
    } catch (err) {
        return jsonResponse(
            { error: err instanceof Error ? err.message : String(err) },
            500,
        );
    }
}

/**
 * Server-lifetime ingest state, set up once by {@link serveDashboard} at
 * startup and torn down on shutdown.
 *
 * `runtime` is a LONG-LIVED {@link ManagedRuntime} (not a throwaway
 * per-request `Effect.runPromise`): `startIngestWorkflow` forks the pipeline
 * onto a detached daemon fiber that MUST outlive the HTTP request that
 * triggered it. A fresh per-request runtime would tear down when the request
 * resolves and kill the daemon mid-run. `stream` is the Durable Streams
 * sidecar the browser subscribes to directly; it is `null` when the sidecar
 * could not start (e.g. the compiled `--compile` binary, which cannot load
 * native lmdb) - the server still boots and live ingest reports unavailable.
 */
interface ServeIngestState {
    readonly stream: DurableIngestStream | null;
    readonly runtime: ManagedRuntime.ManagedRuntime<
        Layer.Success<typeof IngestRuntimeLayer>,
        Layer.Error<typeof IngestRuntimeLayer>
    >;
}

let serveIngestState: ServeIngestState | null = null;

/** Handle `POST /api/ingest`: trigger an in-process run, return its `runId`. */
async function handleIngestTrigger(req: Request): Promise<Response> {
    const state = serveIngestState;
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

export async function handleDashboardRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const routed = await dispatch(routeTable, req, url);
    if (routed !== null) return routed;
    if (url.pathname === "/api/events") {
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
    if (url.pathname === "/api/decisions" && req.method === "GET") {
        try {
            const notes = await Effect.runPromise(
                listSkillDecisions().pipe(
                    Effect.provide(AppLayer),
                    Effect.scoped,
                ) as Effect.Effect<unknown>,
            );
            return jsonResponse({ decisions: notes });
        } catch (err) {
            return jsonResponse(
                { error: err instanceof Error ? err.message : String(err) },
                500,
            );
        }
    }
    if (url.pathname === "/api/skills" && req.method === "GET") {
        try {
            const triage = await Effect.runPromise(
                fetchSkillTriage().pipe(
                    Effect.provide(AppLayer),
                    Effect.scoped,
                ) as Effect.Effect<unknown>,
            );
            return jsonResponse(triage);
        } catch (err) {
            return jsonResponse(
                { error: err instanceof Error ? err.message : String(err) },
                500,
            );
        }
    }
    if (url.pathname === "/api/skills/decide-bulk") {
        return handleSkillBulkDecision(req);
    }
    const decisionMatch = url.pathname.match(/^\/api\/skills\/(.+)\/decide$/);
    if (decisionMatch) {
        const name = decodeURIComponent(decisionMatch[1] ?? "");
        if (!name) return jsonResponse({ error: "missing skill name" }, 400);
        return handleSkillDecision(name, req);
    }
    const detailMatch = url.pathname.match(/^\/api\/skills\/(.+)\/detail$/);
    if (detailMatch) {
        const name = decodeURIComponent(detailMatch[1] ?? "");
        if (!name) return jsonResponse({ error: "missing skill name" }, 400);
        return handleSkillDetail(name);
    }
    const sourceMatch = url.pathname.match(/^\/api\/skills\/(.+)\/source$/);
    if (sourceMatch) {
        const name = decodeURIComponent(sourceMatch[1] ?? "");
        if (!name) return jsonResponse({ error: "missing skill name" }, 400);
        return handleSkillSource(name);
    }
    const openMatch = url.pathname.match(/^\/api\/skills\/(.+)\/open$/);
    if (openMatch) {
        const name = decodeURIComponent(openMatch[1] ?? "");
        if (!name) return jsonResponse({ error: "missing skill name" }, 400);
        return handleSkillOpen(name, req);
    }
    const improveActionMatch = url.pathname.match(/^\/api\/improve\/(.+?)\/(accept|reject|verdict)$/);
    if (improveActionMatch) {
        const sig = decodeURIComponent(improveActionMatch[1] ?? "");
        const action = improveActionMatch[2] as "accept" | "reject" | "verdict";
        if (!sig) return jsonResponse({ error: "missing proposal sig" }, 400);
        return handleImproveAction(sig, action, req);
    }
    if (url.pathname === "/api/ingest" && req.method === "POST") {
        return handleIngestTrigger(req);
    }
    if (url.pathname === "/api/image" && req.method === "GET") {
        return handleImageRequest(url);
    }
    if (url.pathname.startsWith("/api/")) return jsonResponse({ error: "not_found" });

    // Non-API GET: serve a tiny landing pointing the user at the hosted
    // studio. The CLI is API-only now; the dashboard UI lives at
    // https://ax.necmttn.com/studio/ and CORS-fetches this daemon.
    if (req.method === "GET") {
        return serveRootLanding(url.port || "1738");
    }
    return new Response("not found", { status: 404 });
}

/**
 * Tiny HTML response at /. ax serve is API-only; the dashboard lives at
 * the hosted studio. This page is what someone sees if they curl the
 * daemon root or accidentally open http://localhost:1738/ in a browser.
 */
function serveRootLanding(port: string): Response {
    const studioUrl = `https://ax.necmttn.com/studio/?endpoint=${encodeURIComponent(`http://127.0.0.1:${port}`)}`;
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>ax · daemon</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { margin: 0; padding: 64px 32px; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
           background: #f6f5f0; color: #0a0a0a; line-height: 1.55; }
    main { max-width: 720px; margin: 0 auto; }
    h1 { font-family: Georgia, serif; font-size: 56px; line-height: 1; margin: 0 0 8px; letter-spacing: -1px; }
    p { font-size: 18px; max-width: 56ch; }
    .tag { font-family: ui-monospace, Menlo, monospace; font-size: 11px; text-transform: uppercase;
           letter-spacing: 0.14em; color: #6b6b66; }
    .cta { display: inline-block; margin-top: 16px; padding: 12px 22px; background: #0a0a0a; color: #f6f5f0;
           font-family: ui-monospace, Menlo, monospace; font-size: 14px; text-decoration: none;
           border: 1px solid #0a0a0a; }
    .cta:hover { background: #222; }
    code { font-family: ui-monospace, Menlo, monospace; font-size: 14px; background: #fbfaf5;
           padding: 1px 6px; border: 1px solid #d8d6cf; }
    hr { border: none; border-top: 2px solid #0a0a0a; margin: 32px 0; }
    .api { color: #6b6b66; font-size: 14px; }
  </style>
</head>
<body>
  <main>
    <p class="tag">ax · agent experience layer</p>
    <h1>ax serve</h1>
    <p>API-only daemon. The dashboard UI lives at the hosted studio &mdash; click below to open it with this daemon as the source.</p>
    <a class="cta" href="${studioUrl}">Open studio &nbsp;→</a>
    <hr>
    <p class="api">
      API endpoints: <code>/api/skills</code>, <code>/api/workflow</code>, <code>/api/improve</code>, <code>/api/version</code> &hellip;<br>
      Listening on port <code>${port}</code>.<br>
      Studio source: <a href="https://github.com/Necmttn/ax">github.com/Necmttn/ax</a> &mdash; MIT, host your own anytime.
    </p>
  </main>
</body>
</html>`;
    return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
    });
}

/**
 * CORS so the public studio at https://ax.necmttn.com/studio/ can read
 * a user's local `axctl serve` daemon. Local-only loopback, no cookies/
 * credentials needed, so we echo the requesting origin and allow the
 * standard methods + content-type.
 */
const STUDIO_ORIGINS = new Set([
    "https://ax.necmttn.com",
    "http://ax.necmttn.com",
]);

function isLocalDevOrigin(origin: string): boolean {
    return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function corsHeadersFor(origin: string | null): Record<string, string> {
    if (!origin) return {};
    if (!STUDIO_ORIGINS.has(origin) && !isLocalDevOrigin(origin)) return {};
    return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Max-Age": "600",
        "Vary": "Origin",
    };
}

export async function handleDashboardRequestWithCors(req: Request): Promise<Response> {
    const origin = req.headers.get("origin");
    const cors = corsHeadersFor(origin);

    if (req.method === "OPTIONS") {
        // Chrome's Private Network Access: an HTTPS page (the hosted studio at
        // ax.necmttn.com) fetching a loopback address (this daemon) triggers a
        // preflight carrying `Access-Control-Request-Private-Network: true`.
        // Without echoing `Access-Control-Allow-Private-Network: true` the
        // request is blocked and studio "cannot access" the daemon. Only set it
        // for an allowed origin (cors is empty otherwise) and only when asked.
        const headers = { ...cors };
        if (
            Object.keys(cors).length > 0 &&
            req.headers.get("access-control-request-private-network") === "true"
        ) {
            headers["Access-Control-Allow-Private-Network"] = "true";
        }
        return new Response(null, { status: 204, headers });
    }

    const response = await handleDashboardRequest(req);
    for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
    return response;
}

export async function serveDashboard(args: string[]): Promise<void> {
    const { port } = parseDashboardServeArgs(args);

    // Start the Durable Streams sidecar ONCE, before we accept requests, so
    // POST /api/ingest can publish progress the browser subscribes to directly
    // (the sidecar has permissive CORS). Graceful degradation: the sidecar
    // loads native lmdb, which can't load from a `bun build --compile`
    // single-file binary, so this throws there. We catch and run WITHOUT live
    // ingest rather than crash - the dashboard + every other route still work.
    let stream: DurableIngestStream | null = null;
    try {
        stream = await createDurableIngestStream();
    } catch (err) {
        stream = null;
        console.warn(`[ax] live ingest disabled: Durable Streams sidecar unavailable (${err instanceof Error ? err.message : String(err)}). Run ax from source (not the compiled binary) to enable live ingest in the dashboard.`);
    }

    // Build the long-lived runtime regardless (it doesn't need the sidecar).
    // If anything before a successful `Bun.serve` listen throws (most commonly
    // EADDRINUSE - port in use), tear down what we already started so we don't
    // leak the sidecar port, then rethrow. Only the success path leaves
    // `serveIngestState` + the shutdown handler in place.
    let runtime: ServeIngestState["runtime"] | undefined;
    let server: ReturnType<typeof Bun.serve>;
    try {
        runtime = ManagedRuntime.make(IngestRuntimeLayer);
        serveIngestState = { stream, runtime };

        // 60s idle timeout - recall queries currently full-scan turn excerpts
        // (no full-text index yet) and can take 5-15s on a year-old graph.
        server = Bun.serve({ port, fetch: handleDashboardRequestWithCors, idleTimeout: 60 });
    } catch (err) {
        serveIngestState = null;
        if (stream) await stream.stop().catch(() => undefined);
        if (runtime) await runtime.dispose().catch(() => undefined);
        throw err;
    }

    const { formatServeBanner } = await import("../cli/banner.ts");
    console.log(formatServeBanner(port));

    // Tear down the sidecar + runtime on shutdown. Bun's serve never resolves,
    // so the process exits via a signal; close the open run streams and dispose
    // the runtime (which interrupts any in-flight ingest daemon) first.
    let shuttingDown = false;
    const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        serveIngestState = null;
        await server.stop();
        if (stream) await stream.stop().catch(() => undefined);
        await runtime.dispose().catch(() => undefined);
        process.removeListener("SIGINT", onSigint);
        process.removeListener("SIGTERM", onSigterm);
        process.kill(process.pid, signal);
    };
    const onSigint = (): void => void shutdown("SIGINT");
    const onSigterm = (): void => void shutdown("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
}
