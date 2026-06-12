/**
 * Mounts the Insights Surface Contract onto a fetch-compatible web handler.
 *
 * Strangler seam (ADR-0013): `serveDashboard` consults `isContractRequest`
 * FIRST - migrated (method, path) pairs route into the v4 HttpRouter built
 * here; everything else falls through to the legacy route table untouched.
 * The explicit pair table (rather than letting the v4 router 404) keeps the
 * legacy table's quirks - e.g. method-ANY routes - intact until each family
 * is fully cut over.
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
import { ContractServeInfo, SystemGroupLive } from "./system.ts";

/** Everything the contract handlers reach for; widens as families join. */
export type ContractServices = SurrealClient;

/** Migrated (method, path) pairs the contract router owns. */
const CONTRACT_ROUTES: ReadonlySet<string> = new Set([
    "GET /api/version",
    "POST /api/query",
    "GET /api/graph-health",
    "GET /api/worktrees",
    "GET /api/self-improve",
    "GET /docs",
    "GET /openapi.json",
]);

export const isContractRequest = (method: string, pathname: string): boolean =>
    CONTRACT_ROUTES.has(`${method} ${pathname}`);

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
        Layer.provide(SystemGroupLive),
        Layer.provide([BunHttpPlatform.layer, BunFileSystem.layer, BunPath.layer, Etag.layer]),
    );
    return HttpRouter.toWebHandler(appLayer, {
        memoMap: opts.memoMap,
        disableLogger: true,
    });
}
