import { DEFAULT_DASHBOARD_PORT } from "@ax/lib/dashboard-port";
import { createDurableIngestStream, type DurableIngestStream } from "./ingest-stream-durable.ts";
import { dispatch, jsonResponse, type EffectRunner, type ServeContext } from "./router/router.ts";
import { routeTable } from "./router/table.ts";
import {
    findListenerPid,
    isAddrInUse,
    isPidAlive,
    probeServePort,
    readServePidfile,
    removeServePidfile,
    writeServePidfile,
} from "./serve-instance.ts";
import { makeServeRuntime } from "./serve-runtime.ts";

export function parseDashboardServeArgs(args: string[]): { port: number } {
    const raw = args.find((arg) => arg.startsWith("--port="))?.split("=")[1];
    const port = raw === undefined ? DEFAULT_DASHBOARD_PORT : Number(raw);
    if (!Number.isInteger(port) || port <= 0) throw new Error(`--port must be a positive integer (got ${raw})`);
    return { port };
}

/**
 * Default runner for direct invocations (unit tests call
 * handleDashboardRequest without booting a server). Routes that never touch
 * Effect work as-is; a route that DOES reach for the runner fails loudly
 * instead of silently building a per-request layer stack.
 */
const unavailableRunner: EffectRunner = () =>
    Promise.reject(new Error("dashboard server runtime not initialized (no booted server)"));

export async function handleDashboardRequest(
    req: Request,
    runner: EffectRunner = unavailableRunner,
    serve: ServeContext | null = null,
): Promise<Response> {
    const url = new URL(req.url);
    const routed = await dispatch(routeTable, req, url, runner, serve);
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

export async function handleDashboardRequestWithCors(
    req: Request,
    runner?: EffectRunner,
    serve: ServeContext | null = null,
): Promise<Response> {
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

    const response = await handleDashboardRequest(req, runner, serve);
    for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
    return response;
}

export async function serveDashboard(args: string[]): Promise<void> {
    const { port } = parseDashboardServeArgs(args);

    // Pre-flight: ask whoever already holds the port to identify itself,
    // BEFORE any sidecar/runtime noise. The common failure here is "I forgot
    // ax serve is already running somewhere" - the right response to that is
    // the dashboard URL, not an EADDRINUSE stack trace.
    const existing = await probeServePort(port);
    if (existing.kind === "ax") {
        const pidfile = await readServePidfile();
        const pid = pidfile !== null && pidfile.port === port && isPidAlive(pidfile.pid)
            ? pidfile.pid
            : await findListenerPid(port);
        const { formatServeAlreadyRunning } = await import("../cli/banner.ts");
        console.log(formatServeAlreadyRunning(port, { version: existing.version, pid }));
        return;
    }
    if (existing.kind === "foreign") {
        const { formatServePortBusy } = await import("../cli/banner.ts");
        console.error(formatServePortBusy(port));
        process.exitCode = 1;
        return;
    }

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

    // ONE server-scoped runtime for route handlers AND the detached ingest
    // daemon fibers (see serve-runtime.ts) - the layer stack (SurrealDB
    // connection, trace sink, stage registry) is built once, not per request.
    // If anything before a successful `Bun.serve` listen throws, tear down
    // what we already started so we don't leak the sidecar port. EADDRINUSE
    // can still land here despite the pre-flight (race, or a non-HTTP
    // listener the probe can't identify) - report it cleanly instead of
    // rethrowing into the `axctl error:` stack dump; everything else rethrows.
    const handle = makeServeRuntime();
    const serve: ServeContext = { ingestStream: stream };
    let server: ReturnType<typeof Bun.serve>;
    try {
        // Force the layer build before accepting requests so the first hit
        // doesn't pay the DB connect. Non-fatal: the handle swaps in a fresh
        // runtime on a failed build, so requests retry once the DB is up.
        const warm = await handle.warmup();
        if (!warm.ok) {
            console.warn(`[ax] dashboard runtime warmup failed (${warm.error instanceof Error ? warm.error.message : String(warm.error)}); will retry on first request.`);
        }

        // 60s idle timeout - recall queries currently full-scan turn excerpts
        // (no full-text index yet) and can take 5-15s on a year-old graph.
        server = Bun.serve({
            port,
            fetch: (req) => handleDashboardRequestWithCors(req, handle.runner, serve),
            idleTimeout: 60,
        });
    } catch (err) {
        if (stream) await stream.stop().catch(() => undefined);
        await handle.dispose().catch(() => undefined);
        if (isAddrInUse(err)) {
            const { formatServePortBusy } = await import("../cli/banner.ts");
            console.error(formatServePortBusy(port));
            process.exitCode = 1;
            return;
        }
        throw err;
    }

    // Record this instance for `ax serve status|stop` and the pre-flight pid
    // lookup. Best-effort: a failed write must not take the daemon down.
    const { AX_VERSION } = await import("../cli/version.ts");
    await writeServePidfile({
        pid: process.pid,
        port,
        startedAt: new Date().toISOString(),
        axVersion: AX_VERSION,
    }).catch(() => undefined);

    const { formatServeBanner } = await import("../cli/banner.ts");
    console.log(formatServeBanner(port));

    // Tear down the sidecar + runtime on shutdown. Bun's serve never resolves,
    // so the process exits via a signal; close the open run streams and dispose
    // the runtime (which interrupts any in-flight ingest daemon) first.
    let shuttingDown = false;
    const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        // The pidfile is single-slot: only delete it if this process still
        // owns it (a later `ax serve --port=N` instance may have overwritten it).
        const pidfile = await readServePidfile().catch(() => null);
        if (pidfile?.pid === process.pid) await removeServePidfile();
        await server.stop();
        if (stream) await stream.stop().catch(() => undefined);
        await handle.dispose().catch(() => undefined);
        process.removeListener("SIGINT", onSigint);
        process.removeListener("SIGTERM", onSigterm);
        process.kill(process.pid, signal);
    };
    const onSigint = (): void => void shutdown("SIGINT");
    const onSigterm = (): void => void shutdown("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
}
