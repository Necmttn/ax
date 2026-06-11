import { DEFAULT_DASHBOARD_PORT } from "@ax/lib/dashboard-port";
import { ManagedRuntime } from "effect";
import { IngestRuntimeLayer } from "../ingest/stage/runtime.ts";
import { createDurableIngestStream, type DurableIngestStream } from "./ingest-stream-durable.ts";
import { setServeIngestState, type ServeIngestState } from "./ingest-state.ts";
import { dispatch, jsonResponse } from "./router/router.ts";
import { routeTable } from "./router/table.ts";

export function parseDashboardServeArgs(args: string[]): { port: number } {
    const raw = args.find((arg) => arg.startsWith("--port="))?.split("=")[1];
    const port = raw === undefined ? DEFAULT_DASHBOARD_PORT : Number(raw);
    if (!Number.isInteger(port) || port <= 0) throw new Error(`--port must be a positive integer (got ${raw})`);
    return { port };
}

export async function handleDashboardRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const routed = await dispatch(routeTable, req, url);
    if (routed !== null) return routed;
    if (url.pathname.startsWith("/api/")) return jsonResponse({ error: "not_found" });
    if (req.method === "GET") return serveRootLanding(url.port || String(DEFAULT_DASHBOARD_PORT));
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
    // ingest state + the shutdown handler in place.
    let runtime: ServeIngestState["runtime"] | undefined;
    let server: ReturnType<typeof Bun.serve>;
    try {
        runtime = ManagedRuntime.make(IngestRuntimeLayer);
        setServeIngestState({ stream, runtime });

        // 60s idle timeout - recall queries currently full-scan turn excerpts
        // (no full-text index yet) and can take 5-15s on a year-old graph.
        server = Bun.serve({ port, fetch: handleDashboardRequestWithCors, idleTimeout: 60 });
    } catch (err) {
        setServeIngestState(null);
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
        setServeIngestState(null);
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
