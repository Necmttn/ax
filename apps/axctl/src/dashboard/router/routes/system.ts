/**
 * System family: version/capability metadata, the read-only SQL console,
 * and the four legacy queryApi endpoints (raw-row responses kept loosely
 * typed exactly as before - typing them is future work, not this phase).
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { AX_VERSION } from "../../../cli/version.ts";
import { graphHealthSql } from "../../../queries/graph-health.ts";
import { checkoutActivitySql, gitCorrelationSql } from "../../../queries/insights.ts";
import { fetchImproveProposals } from "../../improve-proposals.ts";
import { API_VERSION, dashboardApiCapabilities } from "../../capabilities.ts";
import { getServeIngestState } from "../../ingest-state.ts";
import {
    decodeFail,
    decodeOk,
    jsonRoute,
    jsonResponse,
    rawRoute,
    type AnyRoute,
    type Decoded,
    type RouteInput,
} from "../router.ts";

export interface QueryParams { readonly sql: string }

export const decodeQueryParams = ({ body }: RouteInput): Decoded<QueryParams> => {
    if (body.kind !== "json") return decodeFail("invalid_json", 400);
    const sql = typeof (body.value as { sql?: unknown } | null)?.sql === "string"
        ? ((body.value as { sql: string }).sql).trim()
        : "";
    if (!sql) return decodeFail("SQL is required", 400);
    if (!/^(SELECT|RETURN|INFO)\b/i.test(sql)) {
        return decodeFail("Only SELECT, RETURN, and INFO queries are allowed", 400);
    }
    return decodeOk({ sql });
};

export const systemRoutes: ReadonlyArray<AnyRoute> = [
    rawRoute({
        method: "ANY", // legacy: /api/version answered every method; studio probes it
        path: "/api/version",
        handler: () =>
            jsonResponse({
                version: AX_VERSION,
                api_version: API_VERSION,
                capabilities: dashboardApiCapabilities(),
                // Whether the Durable Streams sidecar is actually hosting live
                // ingest. False on the compiled binary (native lmdb can't
                // bundle), where POST /api/ingest would 503 - the studio reads
                // this to engage its polling fallback up front. Additive
                // optional field: forward-compatible, no api_version bump.
                live_ingest: getServeIngestState()?.stream != null,
            }),
    }),
    jsonRoute({
        method: "POST",
        path: "/api/query",
        readsBody: true,
        decode: decodeQueryParams,
        handler: ({ sql }) => Effect.gen(function* () {
            const started = performance.now();
            const db = yield* SurrealClient;
            const result = yield* db.query(sql);
            return { result, durationMs: Math.round(performance.now() - started) };
        }),
        errorStatus: () => 400, // legacy: DB errors on /api/query were 400
    }),
    jsonRoute({
        method: "ANY",
        path: "/api/graph-health",
        decode: () => decodeOk(undefined),
        handler: () => Effect.gen(function* () {
            const db = yield* SurrealClient;
            return yield* db.query(graphHealthSql(25));
        }),
    }),
    jsonRoute({
        method: "ANY",
        path: "/api/worktrees",
        decode: () => decodeOk(undefined),
        handler: () => Effect.gen(function* () {
            const db = yield* SurrealClient;
            const activity = yield* db.query(checkoutActivitySql(50));
            const git = yield* db.query(gitCorrelationSql(50));
            return { activity, git };
        }),
    }),
    jsonRoute({
        method: "ANY",
        path: "/api/self-improve",
        decode: () => decodeOk(undefined),
        handler: () => Effect.gen(function* () {
            const db = yield* SurrealClient;
            // moved verbatim from server.ts queryApi (lines 155-159)
            return yield* db.query(`
SELECT id, guidance, version, text, status, scope, risk, evidence, metrics_before, metrics_after, created_at
FROM guidance_version
ORDER BY created_at DESC
LIMIT 50;`);
        }),
    }),
    jsonRoute({
        method: "ANY",
        path: "/api/improve",
        decode: () => decodeOk(undefined),
        handler: () =>
            fetchImproveProposals().pipe(
                Effect.map((proposals) => ({ proposals })),
            ),
    }),
];
