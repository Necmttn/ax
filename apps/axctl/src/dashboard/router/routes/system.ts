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
import { API_VERSION, dashboardApiCapabilities } from "../../capabilities.ts";
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
        handler: () => Effect.gen(function* () {
            const db = yield* SurrealClient;
            // Experiment-loop shortlist + verdict state. Reads proposal +
            // per-form payloads + the active experiment + newest checkpoint.
            // See docs/superpowers/plans/2026-05-25-experiment-loop-cleanup-and-rebuild.md
            // (Phase C10). Moved verbatim from server.ts queryApi (166-182).
            const result = yield* db.query<[Array<Record<string, unknown>>]>(`
SELECT id, form, title, hypothesis, dedupe_sig, frequency, confidence, status, reject_reason,
    type::string(created_at) AS created_at,
    (SELECT trigger_pattern, suspected_gap, proposed_behavior, expected_impact FROM skill_proposal      WHERE proposal = $parent.id LIMIT 1)[0] AS skill_payload,
    (SELECT bounded_role, delegation_trigger, example_task_patterns FROM subagent_proposal   WHERE proposal = $parent.id LIMIT 1)[0] AS subagent_payload,
    (SELECT event_name, target_tool, hook_command, recovery_path, smoke_test_command, disable_command, failure_mode FROM hook_proposal       WHERE proposal = $parent.id LIMIT 1)[0] AS hook_payload,
    (SELECT file_target, section, suggested_text FROM guidance_proposal   WHERE proposal = $parent.id LIMIT 1)[0] AS guidance_payload,
    (SELECT trigger_signal, schedule, action, recovery_path, smoke_test_command, disable_command, failure_mode FROM automation_proposal WHERE proposal = $parent.id LIMIT 1)[0] AS automation_payload,
    (SELECT id, artifact_path, status, task_path, locked_verdict,
        type::string(created_at) AS created_at,
        type::string(scaffolded_at) AS scaffolded_at,
        (SELECT kind, suggested, user_verdict, measured, type::string(observed_at) AS observed_at FROM checkpoint WHERE experiment = $parent.id ORDER BY observed_at DESC LIMIT 1)[0] AS latest_checkpoint
        FROM experiment WHERE proposal = $parent.id LIMIT 1)[0] AS experiment
FROM proposal
ORDER BY frequency DESC, created_at DESC
LIMIT 100;`);
            return { proposals: result?.[0] ?? [] };
        }),
    }),
];
