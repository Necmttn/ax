/**
 * Mounts the Insights Surface Contract onto a fetch-compatible web handler.
 *
 * Strangler seam (ADR-0013): `serveDashboard` consults `isContractRequest`
 * FIRST - migrated (method, path) pairs route into the v4 HttpRouter built
 * here; everything else falls through to the legacy route table untouched.
 * The explicit pair table (rather than letting the v4 router 404) keeps the
 * legacy table's quirks - e.g. method-ANY routes and greedy `:param+` ids
 * with raw slashes - intact until each family is fully cut over.
 *
 * GET /api/version is in the CONTRACT (docs, OpenAPI, generated client) but
 * NOT in the routing table: it is the daemon's identity probe and must keep
 * answering when SurrealDB is down, so the DB-free legacy rawRoute serves
 * it. The v4 web handler builds its layer stack on first request and
 * `toWebHandlerLayerWith` caches a FAILED build forever - the self-healing
 * wrapper below rebuilds the handler after a rejected request so contract
 * routes recover once the DB comes up (mirrors serve-runtime.ts).
 *
 * The `memoMap` option is shared with the server's ManagedRuntime
 * (serve-runtime.ts), so AppLayer's services - the SurrealDB connection,
 * trace sink - are built ONCE and reused by both the contract routes and
 * the legacy routes' runner.
 */
import { Layer } from "effect";
import { BunFileSystem, BunHttpPlatform, BunPath } from "@effect/platform-bun";
import { Etag, HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi";
import type { SurrealClient } from "@ax/lib/db";
import { AppLayer } from "@ax/lib/layers";
import { AxApi } from "@ax/lib/shared/api-contract";
import { jsonResponse } from "../router/router.ts";
import { errorText } from "./common.ts";
import { InsightsGroupLive } from "./insights.ts";
import { ContractServeInfo, SystemGroupLive } from "./system.ts";

/** Everything the contract handlers reach for; widens as families join. */
export type ContractServices = SurrealClient;

/** Migrated exact (method, path) pairs the contract router owns. */
const CONTRACT_ROUTES: ReadonlySet<string> = new Set([
    // system (GET /api/version deliberately absent - see module doc)
    "POST /api/query",
    "GET /api/graph-health",
    "GET /api/worktrees",
    "GET /api/self-improve",
    // insights
    "GET /api/recall",
    "GET /api/skill-graph",
    "GET /api/wrapped",
    "GET /api/wrapped/public-preview",
    "GET /api/workflow",
    "GET /api/tool-failures",
    // docs
    "GET /docs",
    "GET /openapi.json",
]);

/** Migrated single-segment param routes. Multi-segment ids (raw slashes in
 *  a greedy `:param+`) fall through to the legacy rows by construction. */
const CONTRACT_PATTERNS: ReadonlyArray<{ readonly method: string; readonly pattern: RegExp }> = [
    { method: "GET", pattern: /^\/api\/episodes\/[^/]+$/ },
    { method: "GET", pattern: /^\/api\/projects\/[^/]+$/ },
    { method: "GET", pattern: /^\/api\/tool-failures\/[^/]+\/detail$/ },
];

export const isContractRequest = (method: string, pathname: string): boolean =>
    CONTRACT_ROUTES.has(`${method} ${pathname}`) ||
    CONTRACT_PATTERNS.some((p) => p.method === method && p.pattern.test(pathname));

export interface ContractWebHandler {
    readonly handler: (request: Request) => Promise<Response>;
    readonly dispose: () => Promise<void>;
}

export interface MakeContractWebHandlerOptions {
    /** Whether the Durable Streams sidecar is hosting live ingest. */
    readonly liveIngest: boolean;
    /** Share with the server runtime so AppLayer builds once (see above). */
    readonly memoMap?: Layer.MemoMap;
    /** Test seam: services the handlers need (default: production AppLayer). */
    readonly services?: Layer.Layer<ContractServices, unknown>;
}

export function makeContractWebHandler(opts: MakeContractWebHandlerOptions): ContractWebHandler {
    // Handler services (SurrealClient, ContractServeInfo) must be part of the
    // app layer's OUTPUT: route handlers declare them through the router's
    // `Requires` channel, which `toWebHandler` satisfies from the built
    // context at request time - `Layer.provide` into the group does not.
    const appLayer = Layer.mergeAll(
        HttpApiBuilder.layer(AxApi, { openapiPath: "/openapi.json" }),
        HttpApiScalar.layer(AxApi, { path: "/docs" }),
        Layer.succeed(ContractServeInfo)({ liveIngest: opts.liveIngest }),
        opts.services ?? AppLayer,
    ).pipe(
        Layer.provide([SystemGroupLive, InsightsGroupLive]),
        Layer.provide([BunHttpPlatform.layer, BunFileSystem.layer, BunPath.layer, Etag.layer]),
    );
    const build = (): ContractWebHandler =>
        HttpRouter.toWebHandler(appLayer, {
            memoMap: opts.memoMap,
            disableLogger: true,
        });

    // Self-heal: a handler REJECTION (as opposed to an error response) means
    // the lazy layer build failed - e.g. SurrealDB down at boot - and
    // toWebHandlerLayerWith caches that failure forever. Swap in a fresh
    // handler so the next request retries, and answer this one with a 500.
    let current = build();
    return {
        handler: async (request) => {
            const active = current;
            try {
                return await active.handler(request);
            } catch (err) {
                if (current === active) {
                    current = build();
                    void active.dispose().catch(() => undefined);
                }
                return jsonResponse({ error: errorText(err) }, 500);
            }
        },
        dispose: () => current.dispose(),
    };
}
