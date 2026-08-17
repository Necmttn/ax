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
 * (serve-runtime.ts), so `AppLayer`'s services - AxConfig, the trace sink -
 * are built ONCE and reused by both the contract routes and the legacy
 * routes' runner. No SurrealDB connection: see {@link InertSurrealLayer}.
 */
import { Layer } from "effect";
import { BunFileSystem, BunHttpPlatform, BunPath } from "@effect/platform-bun";
import { Etag, HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi";
import { AppLayer } from "@ax/lib/layers";
import { CacheRead } from "@ax/lib/duckdb/seam";
import { AxApi } from "@ax/lib/shared/api-contract";
import { CacheReadLive } from "../../duckdb-embed-wiring.ts";
import { GitHubEnv, GitHubEnvLive } from "../../profile/github-env.ts";
import { jsonResponse } from "../router/router.ts";
import { errorText } from "./common.ts";
import { ImproveGroupLive } from "./improve.ts";
import { InsightsGroupLive } from "./insights.ts";
import { OtelGroupLive } from "./otel.ts";
import { RoutingGroupLive } from "./routing.ts";
import { SessionsGroupLive } from "./sessions.ts";
import { SkillsGroupLive } from "./skills.ts";
import { SystemGroupLive } from "./system.ts";
import { TeamGroupLive } from "./team.ts";
import { UsageGroupLive } from "./usage.ts";
import { JudgmentLive } from "../../judgment.ts";

/** Migrated exact (method, path) pairs the contract router owns. */
const CONTRACT_ROUTES: ReadonlySet<string> = new Set([
    // system (GET /api/version deliberately absent - see module doc; POST
    // /api/query and GET /api/graph-health retired - see system.ts)
    "GET /api/worktrees",
    "GET /api/self-improve",
    // insights
    "GET /api/recall",
    "GET /api/skill-graph",
    "GET /api/wrapped",
    "GET /api/wrapped/public-preview",
    "GET /api/wrapped/generate-brief",
    "GET /api/cost/models",
    "GET /api/cost/split",
    "GET /api/cost/dispatches",
    "GET /api/cost/routability",
    "GET /api/routing/table",
    "POST /api/routing/backtest",
    "POST /api/routing/classes",
    "GET /api/context/budget",
    "GET /api/context/drift",
    "GET /api/workflow",
    "GET /api/tool-failures",
    // sessions
    "GET /api/session-canvas",
    "GET /api/session-summary",
    "GET /api/session-orchestration",
    "GET /api/sessions",
    "GET /api/sessions/compare",
    // skills
    "GET /api/decisions",
    "GET /api/skills",
    "POST /api/skills/decide-bulk",
    // improve
    "GET /api/improve",
    "GET /api/next-actions",
    "GET /api/improve/analyze-brief",
    // usage
    "GET /api/usage",
    // team
    "GET /api/team",
    // live: SSE /api/events + binary /api/image stay raw legacy routes; the
    // trigger POST /api/ingest was retired in studio ephemeral, wave 3 - see
    // api-contract.ts's module doc.
    // otel receiver
    "POST /v1/metrics",
    "POST /v1/traces",
    "POST /v1/logs",
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
    // /api/sessions/compare also matches the single-segment pattern below.
    // That is intentional: both route into the contract and FindMyWay gives
    // static paths precedence over :param paths, so compare wins correctly.
    { method: "GET", pattern: /^\/api\/sessions\/[^/]+$/ },
    { method: "GET", pattern: /^\/api\/sessions\/[^/]+\/(children|evidence|insights|inspect|timeline)$/ },
    { method: "GET", pattern: /^\/api\/skills\/[^/]+\/(detail|source)$/ },
    { method: "POST", pattern: /^\/api\/skills\/[^/]+\/(decide|open)$/ },
    { method: "DELETE", pattern: /^\/api\/skills\/[^/]+\/decide$/ },
    { method: "DELETE", pattern: /^\/api\/routing\/classes\/[^/]+$/ },
    { method: "GET", pattern: /^\/api\/improve\/[^/]+\/impact$/ },
    // All actions route to the contract; the handler answers unknown ones
    // with the legacy 404 { error: "unknown_improve_action" }.
    { method: "POST", pattern: /^\/api\/improve\/[^/]+\/[^/]+$/ },
];

export const isContractRequest = (method: string, pathname: string): boolean =>
    CONTRACT_ROUTES.has(`${method} ${pathname}`) ||
    CONTRACT_PATTERNS.some((p) => p.method === method && p.pattern.test(pathname));

export interface ContractWebHandler {
    readonly handler: (request: Request) => Promise<Response>;
    readonly dispose: () => Promise<void>;
}

export interface MakeContractWebHandlerOptions {
    /**
     * Retired with the live-ingest trigger (studio ephemeral, wave 3) - the
     * Durable Streams sidecar this used to identify no longer exists. Kept
     * accepting `null` only so existing call sites (every group's test file
     * passes `ingestStream: null`) compile unchanged; the value is not read.
     */
    readonly ingestStream?: null;
    /** Share with the server runtime so `AppLayer` builds once (see above). */
    readonly memoMap?: Layer.MemoMap;
    /**
     * Test seam for the published-snapshot reader (default: `CacheReadLive`,
     * which resolves a real libduckdb).
     *
     * v2 moved DuckDB-backed routes (`/api/recall`, `/api/sessions`, ...) onto
     * `CacheRead`, and `CacheReadLive` fails with "the DuckDB library could not
     * be loaded" wherever no dylib is resolvable - which is every plain
     * `bun test` run and CI. Without this seam a route-plumbing test (does
     * `GET /api/sessions` answer 200 with empty data?) reports 500 for a reason
     * that has nothing to do with the route, and the only way to make it green
     * would be to stop asserting the status. `@ax/lib/testing/cache`
     * `makeTestCacheRead` fills it with canned rows that still decode through
     * the caller's `Schema`. Query CORRECTNESS is a different question and
     * belongs on a real temp DuckDB (`duckdbTestSetup` + `publishCacheFixture`).
     */
    readonly cacheRead?: Layer.Layer<CacheRead, unknown>;
    /** Test seam for server-side GitHub calls (default: daemon `gh` auth). */
    readonly github?: Layer.Layer<GitHubEnv, unknown>;
}

export function makeContractWebHandler(opts: MakeContractWebHandlerOptions): ContractWebHandler {
    // Handler services (ContractServeInfo, FileSystem/Path
    // for the transcript-reading session handlers) must be part of the app
    // layer's OUTPUT: route handlers declare them through the router's
    // `Requires` channel, which `toWebHandler` satisfies from the built
    // context at request time - `Layer.provide` into the group does not.
    const platformLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);
    const routesLayer = Layer.mergeAll(
        HttpApiBuilder.layer(AxApi, { openapiPath: "/openapi.json" }),
        HttpApiScalar.layer(AxApi, { path: "/docs" }),
        // The read seam: handlers read the published DuckDB snapshot. The
        // layer opens nothing until a query actually arrives (see
        // @ax/lib/duckdb/seam), so a daemon that never serves a read request
        // pays nothing for it.
        opts.cacheRead ?? CacheReadLive,
        JudgmentLive,
        // AxConfig/ProcessService/live-trace sink. Some handler call chains
        // (worktrees overview, self-improve) reach for these transitively.
        AppLayer,
    ).pipe(
        Layer.provide([
            SystemGroupLive,
            InsightsGroupLive,
            SessionsGroupLive,
            SkillsGroupLive,
            ImproveGroupLive,
            UsageGroupLive,
            OtelGroupLive,
            RoutingGroupLive,
            TeamGroupLive,
        ]),
        // FileSystem/Path are provided beneath the route builder for build-time
        // needs. The final app layer merges platformLayer back into the output
        // for request-time handler requirements.
        Layer.provide([BunHttpPlatform.layer, platformLayer, Etag.layer]),
    );
    const appLayer = Layer.mergeAll(routesLayer, platformLayer).pipe(
        Layer.provideMerge(opts.github ?? GitHubEnvLive),
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
