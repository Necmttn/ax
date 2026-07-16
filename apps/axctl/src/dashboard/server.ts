import { DEFAULT_DASHBOARD_PORT } from "@ax/lib/dashboard-port";
import { Layer } from "effect";
import {
    isContractRequest,
    makeContractWebHandler,
    type ContractWebHandler,
} from "./contract/web-handler.ts";
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
import { defaultRuntimeFactory, makeServeRuntime } from "./serve-runtime.ts";
import { serveStudioAsset } from "./studio-assets.ts";

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
    contract: ContractWebHandler | null = null,
): Promise<Response> {
    const url = new URL(req.url);
    // Strangler seam (ADR-0013): (method, path) pairs the Insights Surface
    // Contract owns route into the v4 HttpRouter; everything else falls
    // through to the legacy route table untouched.
    if (contract !== null && isContractRequest(req.method, url.pathname)) {
        return contract.handler(req);
    }
    const routed = await dispatch(routeTable, req, url, runner, serve);
    if (routed !== null) return routed;
    if (url.pathname.startsWith("/api/")) return jsonResponse({ error: "not_found" });
    if (req.method === "GET") {
        // Studio is served by the daemon itself, same-origin, so the SPA fetches
        // /api/* from the same host:port with no mixed-content / Private Network
        // Access barrier. Embedded in the compiled binary; read off disk when
        // running from source. Falls through to the landing page only when this
        // build bundles no studio (and nothing is on disk).
        const asset = await serveStudioAsset(url.pathname);
        if (asset !== null) return asset;
        // serveStudioAsset returns the SPA shell for unknown non-asset routes,
        // so a null here means either a genuine asset miss (404) or a build with
        // no studio bundled at all - in which case the root gets the landing page.
        if (url.pathname === "/" || url.pathname === "") {
            return serveRootLanding(url.port || String(DEFAULT_DASHBOARD_PORT));
        }
        return new Response("not found", { status: 404 });
    }
    return new Response("not found", { status: 404 });
}

/**
 * Fallback HTML at / when this build bundles no studio assets (and none are on
 * disk) - e.g. a binary built without the embed step. Normally `ax serve`
 * serves the studio SPA here directly; this page only shows when it can't.
 */
function serveRootLanding(port: string): Response {
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
    <p>This daemon is up, but no studio UI is bundled in this build. Reinstall the latest <code>ax</code>, or run from source &mdash; studio then serves right here at the daemon root.</p>
    <a class="cta" href="https://github.com/Necmttn/ax">Get ax &nbsp;→</a>
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
    // The desktop app's renderer: studio loaded via the custom `ax://` scheme
    // (registered standard, host "studio" - see apps/studio-desktop). Chromium
    // sends `Origin: ax://studio` on its fetches to the loopback daemon; without
    // this entry every desktop API call dies as an opaque "Failed to fetch"
    // (#690). Loopback-only daemon, no credentials - echoing the origin is safe.
    "ax://studio",
]);

function isLocalDevOrigin(origin: string): boolean {
    return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function corsHeadersFor(origin: string | null, requestedHeaders?: string | null): Record<string, string> {
    if (!origin) return {};
    if (!STUDIO_ORIGINS.has(origin) && !isLocalDevOrigin(origin)) return {};
    return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        // Echo whatever the preflight asked for. A browser fails the preflight
        // when ANY requested header is missing from the allow list, and the
        // desktop studio's Effect HttpClient adds tracing headers (traceparent)
        // beyond content-type - a static list silently killed every desktop
        // request AFTER a passing-looking 204 (#690). No credentials on this
        // loopback-only API, so echoing is safe.
        "Access-Control-Allow-Headers": requestedHeaders && requestedHeaders.length > 0
            ? requestedHeaders
            : "content-type",
        "Access-Control-Max-Age": "600",
        "Vary": "Origin",
    };
}

export async function handleDashboardRequestWithCors(
    req: Request,
    runner?: EffectRunner,
    serve: ServeContext | null = null,
    contract: ContractWebHandler | null = null,
): Promise<Response> {
    const origin = req.headers.get("origin");
    const cors = corsHeadersFor(origin, req.headers.get("access-control-request-headers"));

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

    const response = await handleDashboardRequest(req, runner, serve, contract);
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
    // One memoMap shared between the server runtime and the contract web
    // handler: both compose the same AppLayer object, so its services (the
    // SurrealDB connection, trace sink) build once and are reused by both.
    const memoMap = Layer.makeMemoMapUnsafe();
    const handle = makeServeRuntime(defaultRuntimeFactory({ memoMap }));
    const contract = makeContractWebHandler({ ingestStream: stream, memoMap });
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
        // (no full-text index yet) and can take 5-15s on a year-old graph. JSON
        // handlers also carry a per-request DB deadline (default 45s,
        // AX_SERVE_QUERY_TIMEOUT_MS, in router.ts) so a wedged daemon returns a
        // fast 504 instead of hanging the request forever.
        server = Bun.serve({
            port,
            // loopback by default (always-on daemon; browser studio connects locally);
            // AX_SERVE_HOST=0.0.0.0 to expose on the LAN.
            hostname: process.env.AX_SERVE_HOST ?? "127.0.0.1",
            fetch: (req) => handleDashboardRequestWithCors(req, handle.runner, serve, contract),
            idleTimeout: 60,
        });
    } catch (err) {
        if (stream) await stream.stop().catch(() => undefined);
        await contract.dispose().catch(() => undefined);
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

    // Warm the expensive read caches in the background AFTER listen so the
    // first visitor lands on hot caches (wrapped landing, next actions,
    // skill triage). Fire-and-forget - a failure just means the first
    // caller of that endpoint pays the compute instead.
    const { prewarmDashboardCaches } = await import("./prewarm.ts");
    void handle.runner(prewarmDashboardCaches()).catch(() => undefined);

    // Sweep ingest_run rows stranded by a crashed ingest, now and every
    // interval (#697). The ingest-start reaper (#282) can't help when nothing
    // re-runs ingest - the IDE daemon model has no watcher - so the daemon,
    // which is always up, owns the recurring sweep. Fire-and-forget on the
    // server runtime: `handle.dispose()` interrupts it at shutdown.
    //
    // Supervised, not a bare `.catch(() => undefined)`: studio.app routinely
    // starts `ax serve` before `com.necmttn.ax-db` is listening (serve
    // self-heals from that once a request hits `handle.runner` - see the
    // warmup handling above), and that same race can hit the layer build for
    // THIS fork. `runReapLoop`'s internal `catchCause` can't catch a
    // layer-build failure (it happens before the effect body runs), so an
    // unsupervised fork would drop the reaper for the daemon's whole life,
    // silently, on a documented and expected boot race - #697 again, just
    // moved up a layer. `superviseReapLoop` re-arms on rejection so a later
    // attempt (once `handle.runner` has healed the runtime) can succeed.
    const { reapIntervalSeconds, runReapLoop, superviseReapLoop } = await import("./reap-loop.ts");
    const reapInterval = reapIntervalSeconds();
    if (reapInterval > 0) {
        superviseReapLoop({
            run: () => handle.runner(runReapLoop({ intervalSeconds: reapInterval })),
            intervalMs: reapInterval * 1000,
            // `.unref()` so a pending retry timer can never hold the process
            // open at shutdown - shutdown() calls process.kill() directly,
            // it doesn't wait on this loop.
            scheduleRetry: (fn, ms) => {
                setTimeout(fn, ms).unref();
            },
            onError: (err) => {
                console.warn(
                    `[ax] ingest_run reap loop failed to start (${err instanceof Error ? err.message : String(err)}); retrying in ${reapInterval}s.`,
                );
            },
        });
    }

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
        await contract.dispose().catch(() => undefined);
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
