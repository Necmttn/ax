import { DEFAULT_DASHBOARD_PORT } from "@ax/lib/dashboard-port";
import { DEFAULT_DB_HOST, DEFAULT_DB_PORT } from "@ax/lib/runtime-state";
import { Duration, Effect, Exit, Layer, Scope } from "effect";
import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import * as BunHttpClient from "@effect/platform-bun/BunHttpClient";
import { makeManagedDb, parseDurationString, resolveManagedSurrealPath } from "./managed-db.ts";
import { runIngestLoop } from "./serve-ingest-loop.ts";
import { IngestRuntimeLayer } from "../ingest/stage/runtime.ts";
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

export interface DashboardServeArgs {
    readonly port: number;
    readonly managedDb: boolean;
    readonly ingestEvery: Duration.Duration | null;
}

export function parseDashboardServeArgs(args: string[]): DashboardServeArgs {
    const rawPort = args.find((arg) => arg.startsWith("--port="))?.split("=")[1];
    const port = rawPort === undefined ? DEFAULT_DASHBOARD_PORT : Number(rawPort);
    if (!Number.isInteger(port) || port <= 0) throw new Error(`--port must be a positive integer (got ${rawPort})`);

    const managedDb = args.includes("--managed-db");

    const rawEvery = args.find((a) => a.startsWith("--ingest-every="))?.split("=")[1];
    let ingestEvery: Duration.Duration | null = null;
    if (rawEvery !== undefined) {
        ingestEvery = parseDurationString(rawEvery);
        if (ingestEvery === null) {
            throw new Error(`--ingest-every: unrecognised duration '${rawEvery}' (use e.g. '2m', '30s', '1h')`);
        }
    }

    return { port, managedDb, ingestEvery };
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
    contract: ContractWebHandler | null = null,
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

    const response = await handleDashboardRequest(req, runner, serve, contract);
    for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
    return response;
}

/**
 * Layer providing ChildProcessSpawner + HttpClient for `--managed-db`.
 * Built once at module level so it's not rebuilt per invocation.
 */
const managedDbLayer = Layer.mergeAll(
    BunChildProcessSpawner.layer.pipe(
        Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
    ),
    BunHttpClient.layer,
);

export async function serveDashboard(args: string[]): Promise<void> {
    const { port, managedDb, ingestEvery } = parseDashboardServeArgs(args);

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

    // --managed-db: spawn and supervise the bundled surreal binary.
    // Must happen BEFORE the serve runtime warmup so the DB is ready when
    // SurrealClient tries to connect.
    let managedDbScope: Scope.Closeable | null = null;
    if (managedDb) {
        const dbHost = DEFAULT_DB_HOST;
        const dbPort = DEFAULT_DB_PORT;
        const dataDir =
            process.env.AX_DATA_DIR ??
            `${process.env.HOME ?? "~"}/.local/share/ax`;
        const surrealPath = resolveManagedSurrealPath(process.execPath);

        try {
            managedDbScope = await Effect.runPromise(Scope.make("sequential"));
            await Effect.runPromise(
                makeManagedDb({ surrealPath, host: dbHost, port: dbPort, dataDir }).pipe(
                    Effect.provide(managedDbLayer),
                    Effect.provideService(Scope.Scope, managedDbScope),
                ),
            );
        } catch (err) {
            if (managedDbScope) {
                await Effect.runPromise(Scope.close(managedDbScope, Exit.void)).catch(() => undefined);
                managedDbScope = null;
            }
            console.error(`[ax] --managed-db: failed to start surreal: ${err instanceof Error ? err.message : String(err)}`);
            process.exitCode = 1;
            return;
        }
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
        // (no full-text index yet) and can take 5-15s on a year-old graph.
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

    // --ingest-every: fork a background ingest loop via Effect.runFork.
    // runIngestLoop has no R requirements (it closes over IngestRuntimeLayer),
    // so it can be forked without going through handle.runner. The fiber is
    // NOT attached to any scope intentionally - it runs until the process exits
    // or is interrupted by the signal handler below (which kills the process).
    if (ingestEvery !== null) {
        Effect.runFork(runIngestLoop({ every: ingestEvery }, IngestRuntimeLayer));
        console.log(`[ax] ingest loop started (every ${Duration.toSeconds(ingestEvery)}s)`);
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
        // Close the managed-db scope AFTER the serve runtime disposes so
        // in-flight ingest runs finish before surreal shuts down.
        if (managedDbScope) {
            await Effect.runPromise(Scope.close(managedDbScope, Exit.void)).catch(() => undefined);
        }
        process.removeListener("SIGINT", onSigint);
        process.removeListener("SIGTERM", onSigterm);
        process.kill(process.pid, signal);
    };
    const onSigint = (): void => void shutdown("SIGINT");
    const onSigterm = (): void => void shutdown("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
}
