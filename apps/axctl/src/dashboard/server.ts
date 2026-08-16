import { DEFAULT_DASHBOARD_PORT } from "@ax/lib/dashboard-port";
import { Effect, Layer } from "effect";
import { isAddrInUse } from "./host-guard.ts";
import { CacheReadLive } from "../duckdb-embed-wiring.ts";
import {
    isContractRequest,
    makeContractWebHandler,
    type ContractWebHandler,
} from "./contract/web-handler.ts";
import { dispatch, jsonResponse, type EffectRunner, type ServeContext } from "./router/router.ts";
import { routeTable } from "./router/table.ts";
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
        // Studio is served by this process itself, same-origin, so the SPA fetches
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
 * disk) - e.g. a binary built without the embed step. Normally `ax studio`
 * serves the studio SPA here directly; this page only shows when it can't.
 */
function serveRootLanding(port: string): Response {
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>ax · studio</title>
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
    <h1>ax studio</h1>
    <p>This process is up, but no studio UI is bundled in this build. Reinstall the latest <code>ax</code>, or run from source &mdash; studio then serves right here at the root.</p>
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

// The loopback Host-header guard now lives in a dep-free module shared with the
// OTLP spool server (host-guard.ts). Imported for use below and re-exported so
// existing importers and tests keep resolving it from server.ts.
import { isAllowedHost } from "./host-guard.ts";
export { isAllowedHost };

function corsHeadersFor(origin: string | null, requestedHeaders?: string | null): Record<string, string> {
    if (!origin) return {};
    const isStudio = STUDIO_ORIGINS.has(origin);
    if (!isStudio && !isLocalDevOrigin(origin)) return {};
    return {
        "Access-Control-Allow-Origin": origin,
        // Studio (hosted + desktop) is the only origin trusted with the
        // state-changing verbs. A bare localhost dev page gets read-only CORS
        // so it can't POST/DELETE cross-origin; Host validation (server.ts)
        // is the primary state-change defense regardless of Origin.
        "Access-Control-Allow-Methods": isStudio ? "GET, POST, DELETE, OPTIONS" : "GET, OPTIONS",
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
    if (!isAllowedHost(req.headers.get("host"))) {
        return new Response("forbidden", { status: 403 });
    }

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

/** `AX_STUDIO_IDLE_TIMEOUT_MS` - how long with zero requests before studio
 *  exits on its own. Generous enough to survive a normal gap between page
 *  navigations / poll ticks in the open tab; small enough that a forgotten
 *  terminal doesn't leave a process running for hours. Tests override this to
 *  a few hundred ms so an exit-on-disconnect assertion doesn't have to wait
 *  two minutes. */
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

/** `AX_STUDIO_HARD_TIMEOUT_MS` - absolute wall-clock cap regardless of
 *  activity. A pure backstop: it exists so a bug in the idle checker (or a
 *  client that never stops polling) still bounds the process's lifetime,
 *  the same "assert the exit, don't trust that it merely served a request"
 *  guard the acceptance criteria calls for. */
const DEFAULT_HARD_TIMEOUT_MS = 6 * 60 * 60 * 1000;

const readMsEnv = (name: string, fallback: number): number => {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * `ax studio` - the ephemeral entrypoint (wave 3, `c-daemon-studio`).
 *
 * Unlike the old `ax serve` daemon, this process is not meant to outlive the
 * client that asked for it: it binds a port, serves the studio SPA + the
 * Insights Surface Contract over the published DuckDB snapshot, and EXITS on
 * its own once nothing has hit it for `idleTimeoutMs` (or `hardTimeoutMs`
 * unconditionally, whichever comes first) - no pidfile, no LaunchAgent, no
 * `ax serve status|stop` lifecycle to manage. `Ctrl-C` still works
 * immediately via SIGINT/SIGTERM.
 */
export async function serveDashboard(args: string[]): Promise<void> {
    const { port } = parseDashboardServeArgs(args);
    const idleTimeoutMs = readMsEnv("AX_STUDIO_IDLE_TIMEOUT_MS", DEFAULT_IDLE_TIMEOUT_MS);
    const hardTimeoutMs = readMsEnv("AX_STUDIO_HARD_TIMEOUT_MS", DEFAULT_HARD_TIMEOUT_MS);

    // Pre-flight: ask whoever already holds the port to identify itself. The
    // common case is "I forgot a studio is already open in another tab" - the
    // right response to that is the URL, not an EADDRINUSE stack trace. Only
    // a real network probe can answer this (studio ephemeral keeps no
    // pidfile), which is fine here: a human is about to wait on a server boot
    // regardless.
    const { probeStudioPort, formatStudioAlreadyRunning, formatStudioPortBusy, formatStudioBanner } =
        await import("../cli/banner.ts");
    const existing = await probeStudioPort(port);
    if (existing.kind === "ax") {
        console.log(formatStudioAlreadyRunning(port, { version: existing.version }));
        return;
    }
    if (existing.kind === "foreign") {
        console.error(formatStudioPortBusy(port));
        process.exitCode = 1;
        return;
    }

    // ONE server-scoped runtime for every route handler (see serve-runtime.ts)
    // - the layer stack (CacheRead's snapshot connection, trace sink) is
    // built once, not per request. If anything before a successful
    // `Bun.serve` listen throws, tear down what we already started. EADDRINUSE
    // can still land here despite the pre-flight (race, or a non-HTTP
    // listener the probe can't identify) - report it cleanly instead of
    // rethrowing into the `axctl error:` stack dump; everything else rethrows.
    // One memoMap shared between the server runtime and the contract web
    // handler: both compose overlapping layer objects (AppLayer, CacheRead),
    // so those services build once and are reused by both.
    const memoMap = Layer.makeMemoMapUnsafe();
    const handle = makeServeRuntime(defaultRuntimeFactory({ memoMap }));
    const contract = makeContractWebHandler({ memoMap });
    const serve: ServeContext = {};

    // Activity tracking for the idle-exit checker below. Bumped at the START
    // of every request (including the request that opens the SSE stream) -
    // see the module doc for why a coarser "any request in the window" signal
    // was chosen over precisely tracking open SSE connections.
    let lastActivityAt = Date.now();
    const startedAt = lastActivityAt;
    const trackedFetch = (req: Request): Promise<Response> => {
        lastActivityAt = Date.now();
        return handleDashboardRequestWithCors(req, handle.runner, serve, contract);
    };

    let server: ReturnType<typeof Bun.serve>;
    try {
        // Force the layer build before accepting requests so the first hit
        // doesn't pay the snapshot open. Non-fatal: the handle swaps in a
        // fresh runtime on a failed build, so requests retry once a snapshot
        // exists.
        const warm = await handle.warmup();
        if (!warm.ok) {
            console.warn(`[ax] studio runtime warmup failed (${warm.error instanceof Error ? warm.error.message : String(warm.error)}); will retry on first request.`);
        }

        // 60s idle timeout - recall queries currently full-scan turn excerpts
        // (no full-text index yet) and can take 5-15s on a year-old graph. JSON
        // handlers also carry a per-request DB deadline (default 45s,
        // AX_SERVE_QUERY_TIMEOUT_MS, in router.ts) so a wedged snapshot open
        // returns a fast 504 instead of hanging the request forever. This is
        // a per-CONNECTION socket timeout, distinct from the whole-process
        // idle-exit timer below.
        server = Bun.serve({
            port,
            // loopback by default; AX_SERVE_HOST=0.0.0.0 to expose on the LAN.
            hostname: process.env.AX_SERVE_HOST ?? "127.0.0.1",
            fetch: trackedFetch,
            idleTimeout: 60,
        });
    } catch (err) {
        await contract.dispose().catch(() => undefined);
        await handle.dispose().catch(() => undefined);
        if (isAddrInUse(err)) {
            const { formatStudioPortBusy: portBusy } = await import("../cli/banner.ts");
            console.error(portBusy(port));
            process.exitCode = 1;
            return;
        }
        throw err;
    }

    console.log(formatStudioBanner(port));

    // Warm the expensive read caches in the background AFTER listen so the
    // first visitor lands on hot caches (wrapped landing, next actions,
    // skill triage). Fire-and-forget - a failure just means the first
    // caller of that endpoint pays the compute instead.
    const { prewarmDashboardCaches } = await import("./prewarm.ts");
    void handle.runner(prewarmDashboardCaches().pipe(Effect.provide(CacheReadLive))).catch(() => undefined);

    // Tear down the runtime and exit. Two triggers: an explicit signal
    // (Ctrl-C, a process manager) and the idle checker below finding nobody
    // has hit the server in `idleTimeoutMs` (or `hardTimeoutMs` regardless of
    // activity) - both funnel through this one function so shutdown only
    // ever runs once.
    let shuttingDown = false;
    const shutdown = async (exitCode: number): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        clearInterval(idleChecker);
        await server.stop();
        await contract.dispose().catch(() => undefined);
        await handle.dispose().catch(() => undefined);
        process.removeListener("SIGINT", onSigint);
        process.removeListener("SIGTERM", onSigterm);
        process.exit(exitCode);
    };
    const onSigint = (): void => void shutdown(0);
    const onSigterm = (): void => void shutdown(0);
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);

    // Poll every second rather than setting one deadline timer per request:
    // a single recurring check is simpler to reason about than rescheduling
    // on every fetch, and a 1s granularity is invisible against a multi-second
    // idle budget. `.unref()`'d so a wedged idle checker can never itself hold
    // the process open past the hard cap trigger below (that path calls
    // `process.exit` directly, which does not wait on pending timers anyway,
    // but unref keeps the intent honest).
    const idleChecker = setInterval(() => {
        const now = Date.now();
        if (now - startedAt >= hardTimeoutMs) {
            void shutdown(0);
        } else if (now - lastActivityAt >= idleTimeoutMs) {
            void shutdown(0);
        }
    }, 1000);
    idleChecker.unref();
}
