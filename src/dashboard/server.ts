import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { AppLayer } from "../lib/layers.ts";
import { graphHealthSql } from "../queries/graph-health.ts";
import { checkoutActivitySql, gitCorrelationSql } from "../queries/insights.ts";
import { addIngestEventSubscriber, removeIngestEventSubscriber } from "./telemetry.ts";
import {
    clearSkillDecision,
    fetchSkillDetail,
    fetchSkillTriage,
    isTriageDecision,
    listSkillDecisions,
    setSkillDecision,
    setSkillDecisionsBulk,
} from "./triage.ts";
import { fetchToolFailureDetail, fetchToolFailures } from "./tool-failures.ts";
import {
    applySkillDecisionToDisk,
    openSkillTarget,
    readSkillSource,
} from "./skill-source.ts";
import { fetchWorkflow } from "./workflow.ts";
import { fetchSessionDetail } from "./session-detail.ts";
import { fetchSessionInspect } from "./session-inspect.ts";
import { fetchSessionChildren, fetchSessionsList } from "./sessions-list.ts";
import { fetchEpisodeTimeline } from "./episode-timeline.ts";
import { fetchProject } from "./project.ts";
import { fetchRecall } from "./recall.ts";
import { fetchGraphExplorer } from "./graph-explorer.ts";
import { fetchSkillGraph } from "./skill-graph.ts";
import { fetchWrapped, sanitizeWrappedProfile } from "./wrapped.ts";

export function parseDashboardServeArgs(args: string[]): { port: number } {
    const raw = args.find((arg) => arg.startsWith("--port="))?.split("=")[1];
    const port = raw === undefined ? 1738 : Number(raw);
    if (!Number.isInteger(port) || port <= 0) throw new Error(`--port must be a positive integer (got ${raw})`);
    return { port };
}

export async function parseQueryRequest(req: Request): Promise<{ sql: string }> {
    const body = await req.json() as { sql?: unknown };
    const sql = typeof body.sql === "string" ? body.sql.trim() : "";
    if (!sql) throw new Error("SQL is required");
    if (!/^(SELECT|RETURN|INFO)\b/i.test(sql)) {
        throw new Error("Only SELECT, RETURN, and INFO queries are allowed");
    }
    return { sql };
}

export function formatSseEvent(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function recentIngestEventsSql(sinceIso: string, limit = 50): string {
    const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 50;
    return `
SELECT id, run, source, stage, level, message, counts, raw, ts
FROM ingest_event
WHERE ts > d"${sinceIso}"
ORDER BY ts ASC
LIMIT ${safeLimit};`.trim();
}

export function dashboardApiKind(pathname: string): "graph-health" | "worktrees" | "self-improve" | "improve" | "unknown" {
    if (pathname === "/api/graph-health") return "graph-health";
    if (pathname === "/api/worktrees") return "worktrees";
    if (pathname === "/api/self-improve") return "self-improve";
    if (pathname === "/api/improve") return "improve";
    return "unknown";
}

async function jsonResponse(value: unknown, status = 200): Promise<Response> {
    return new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
    });
}

async function queryApi(pathname: string): Promise<Response> {
    const program = Effect.gen(function* () {
        const db = yield* SurrealClient;
        if (pathname === "/api/graph-health") return yield* db.query(graphHealthSql(25));
        if (pathname === "/api/worktrees") {
            const activity = yield* db.query(checkoutActivitySql(50));
            const git = yield* db.query(gitCorrelationSql(50));
            return { activity, git };
        }
        if (pathname === "/api/self-improve") {
            return yield* db.query(`
SELECT id, guidance, version, text, status, scope, risk, evidence, metrics_before, metrics_after, created_at
FROM guidance_version
ORDER BY created_at DESC
LIMIT 50;`);
        }
        if (pathname === "/api/improve") {
            // Experiment-loop shortlist + verdict state. Reads proposal +
            // per-form payloads + the active experiment + newest checkpoint.
            // See docs/superpowers/plans/2026-05-25-experiment-loop-cleanup-and-rebuild.md
            // (Phase C10).
            const result = yield* db.query<[Array<Record<string, unknown>>]>(`
SELECT id, form, title, hypothesis, dedupe_sig, frequency, confidence, status, reject_reason,
    type::string(created_at) AS created_at,
    (SELECT trigger_pattern, suspected_gap, proposed_behavior, expected_impact FROM skill_proposal      WHERE proposal = $parent.id LIMIT 1)[0] AS skill_payload,
    (SELECT bounded_role, delegation_trigger, example_task_patterns FROM subagent_proposal   WHERE proposal = $parent.id LIMIT 1)[0] AS subagent_payload,
    (SELECT event_name, target_tool, hook_command FROM hook_proposal       WHERE proposal = $parent.id LIMIT 1)[0] AS hook_payload,
    (SELECT file_target, section, suggested_text FROM guidance_proposal   WHERE proposal = $parent.id LIMIT 1)[0] AS guidance_payload,
    (SELECT trigger_signal, schedule, action FROM automation_proposal WHERE proposal = $parent.id LIMIT 1)[0] AS automation_payload,
    (SELECT id, artifact_path, locked_verdict,
        type::string(created_at) AS created_at,
        type::string(scaffolded_at) AS scaffolded_at,
        (SELECT kind, suggested, user_verdict, measured, type::string(observed_at) AS observed_at FROM checkpoint WHERE experiment = $parent.id ORDER BY observed_at DESC LIMIT 1)[0] AS latest_checkpoint
        FROM experiment WHERE proposal = $parent.id LIMIT 1)[0] AS experiment
FROM proposal
ORDER BY frequency DESC, created_at DESC
LIMIT 100;`);
            return { proposals: result?.[0] ?? [] };
        }
        return { error: "not_found" };
    }).pipe(Effect.provide(AppLayer), Effect.scoped);
    return jsonResponse(await Effect.runPromise(program as Effect.Effect<unknown>));
}

/**
 * POST /api/improve/:sig/accept body: { force?: boolean }
 * POST /api/improve/:sig/reject body: { reason?: string }
 * POST /api/improve/:sig/verdict body: { verdict: string }
 *
 * Single handler dispatches all three; shared logic lives in
 * src/improve/actions.ts so the CLI and HTTP paths agree on semantics.
 */
async function handleImproveAction(
    sig: string,
    action: "accept" | "reject" | "verdict",
    req: Request,
): Promise<Response> {
    if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
    let body: Record<string, unknown> = {};
    try { body = (await req.json()) as Record<string, unknown>; } catch { /* empty body ok */ }

    try {
        const result = await Effect.runPromise(
            Effect.gen(function* () {
                if (action === "accept") {
                    const force = body.force === true;
                    const { acceptProposal } = yield* Effect.promise(() => import("../improve/actions.ts"));
                    return yield* acceptProposal({ sigOrId: sig, force });
                }
                if (action === "reject") {
                    const reason = typeof body.reason === "string" ? body.reason : undefined;
                    const { rejectProposal } = yield* Effect.promise(() => import("../improve/actions.ts"));
                    return yield* rejectProposal({ sigOrId: sig, ...(reason === undefined ? {} : { reason }) });
                }
                const verdict = typeof body.verdict === "string" ? body.verdict : "";
                const { setVerdict } = yield* Effect.promise(() => import("../improve/actions.ts"));
                return yield* setVerdict({ sigOrId: sig, verdict });
            }).pipe(Effect.provide(AppLayer), Effect.scoped) as Effect.Effect<{ readonly status: string; readonly message?: string }>,
        );
        const httpStatus = result.status === "ok" ? 200
            : result.status === "not_found" ? 404
            : result.status === "wrong_status" || result.status === "scaffold_exists" || result.status === "verdict_locked" ? 409
            : result.status === "unsupported_form" || result.status === "missing_payload" || result.status === "invalid_verdict" ? 400
            : 500;
        return jsonResponse(result, httpStatus);
    } catch (err) {
        return jsonResponse(
            { error: err instanceof Error ? err.message : String(err) },
            500,
        );
    }
}

/**
 * POST /api/skills/:name/decide body: { decision, reason? }
 * DELETE /api/skills/:name/decide  - clears the decision
 */
async function handleSkillDecision(name: string, req: Request): Promise<Response> {
    if (req.method === "DELETE") {
        try {
            await Effect.runPromise(
                Effect.gen(function* () {
                    yield* clearSkillDecision(name);
                    // Clearing a decision restores the skill on disk - a
                    // cleared skill is no longer archive-decided.
                    yield* applySkillDecisionToDisk(name, null);
                }).pipe(
                    Effect.provide(AppLayer),
                    Effect.scoped,
                ) as Effect.Effect<unknown>,
            );
            return jsonResponse({ cleared: true, skill_name: name });
        } catch (err) {
            return jsonResponse(
                { error: err instanceof Error ? err.message : String(err) },
                500,
            );
        }
    }
    if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
    let payload: { decision?: unknown; reason?: unknown };
    try {
        payload = (await req.json()) as { decision?: unknown; reason?: unknown };
    } catch {
        return jsonResponse({ error: "invalid_json" }, 400);
    }
    if (!isTriageDecision(payload.decision)) {
        return jsonResponse(
            { error: "decision must be one of keep|archive|review" },
            400,
        );
    }
    // Capture the narrowed value before the closure below - the type
    // predicate's narrowing does not reach into the nested Effect.gen.
    const decision = payload.decision;
    const reason =
        typeof payload.reason === "string" && payload.reason.trim().length > 0
            ? payload.reason.trim()
            : null;
    try {
        const note = await Effect.runPromise(
            Effect.gen(function* () {
                const saved = yield* setSkillDecision(name, decision, reason);
                // `archive` disables the skill on disk; `keep`/`review`
                // restores it. No-op for non-editable (plugin/builtin) scopes.
                yield* applySkillDecisionToDisk(name, decision);
                return saved;
            }).pipe(
                Effect.provide(AppLayer),
                Effect.scoped,
            ) as Effect.Effect<unknown>,
        );
        return jsonResponse(note);
    } catch (err) {
        return jsonResponse(
            { error: err instanceof Error ? err.message : String(err) },
            500,
        );
    }
}

/** GET /api/skills/:name/detail - evidence behind the recommendation. */
async function handleSkillDetail(name: string): Promise<Response> {
    try {
        const payload = await Effect.runPromise(
            fetchSkillDetail(name).pipe(
                Effect.provide(AppLayer),
                Effect.scoped,
            ) as Effect.Effect<unknown>,
        );
        return jsonResponse(payload);
    } catch (err) {
        return jsonResponse(
            { error: err instanceof Error ? err.message : String(err) },
            500,
        );
    }
}

/** GET /api/skills/:name/source - SKILL.md frontmatter + body + disk state. */
async function handleSkillSource(name: string): Promise<Response> {
    try {
        const payload = await Effect.runPromise(
            readSkillSource(name).pipe(
                Effect.provide(AppLayer),
                Effect.scoped,
            ) as Effect.Effect<unknown>,
        );
        return jsonResponse(payload);
    } catch (err) {
        return jsonResponse(
            { error: err instanceof Error ? err.message : String(err) },
            500,
        );
    }
}

/** POST /api/skills/:name/open body: { target: "finder" | "editor" } */
async function handleSkillOpen(name: string, req: Request): Promise<Response> {
    if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
    let payload: { target?: unknown };
    try {
        payload = (await req.json()) as { target?: unknown };
    } catch {
        return jsonResponse({ error: "invalid_json" }, 400);
    }
    const target =
        payload.target === "editor" ? "editor"
        : payload.target === "finder" ? "finder"
        : null;
    if (!target) {
        return jsonResponse({ error: "target must be 'finder' or 'editor'" }, 400);
    }
    try {
        const result = await Effect.runPromise(
            openSkillTarget(name, target).pipe(
                Effect.provide(AppLayer),
                Effect.scoped,
            ) as Effect.Effect<unknown>,
        );
        return jsonResponse(result);
    } catch (err) {
        return jsonResponse(
            { error: err instanceof Error ? err.message : String(err) },
            500,
        );
    }
}

/** POST /api/skills/decide-bulk body: { names: string[], decision, reason? } */
async function handleSkillBulkDecision(req: Request): Promise<Response> {
    if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
    let payload: { names?: unknown; decision?: unknown; reason?: unknown };
    try {
        payload = (await req.json()) as typeof payload;
    } catch {
        return jsonResponse({ error: "invalid_json" }, 400);
    }
    if (!Array.isArray(payload.names) || payload.names.length === 0) {
        return jsonResponse({ error: "names must be a non-empty array of skill names" }, 400);
    }
    const names = payload.names.filter(
        (n): n is string => typeof n === "string" && n.length > 0,
    );
    if (names.length === 0) {
        return jsonResponse({ error: "no valid skill names provided" }, 400);
    }
    if (!isTriageDecision(payload.decision)) {
        return jsonResponse({ error: "decision must be one of keep|archive|review" }, 400);
    }
    // Capture the narrowed value before the closure below - the type
    // predicate's narrowing of `payload.decision` does not reach into the
    // nested Effect.gen generator.
    const decision = payload.decision;
    const reason =
        typeof payload.reason === "string" && payload.reason.trim().length > 0
            ? payload.reason.trim()
            : null;
    try {
        const notes = await Effect.runPromise(
            Effect.gen(function* () {
                const saved = yield* setSkillDecisionsBulk(names, decision, reason);
                // Reflect the decision onto disk for every editable skill.
                for (const skillName of names) {
                    yield* applySkillDecisionToDisk(skillName, decision);
                }
                return saved;
            }).pipe(
                Effect.provide(AppLayer),
                Effect.scoped,
            ) as Effect.Effect<unknown>,
        );
        return jsonResponse({ notes });
    } catch (err) {
        return jsonResponse(
            { error: err instanceof Error ? err.message : String(err) },
            500,
        );
    }
}

/**
 * API version contract. Bump api_version when removing or renaming
 * endpoints / fields (breaking change). Adding endpoints / optional
 * fields is forward-compatible - keep api_version, append to capabilities.
 *
 * The hosted studio at ax.necmttn.com reads this and uses it to:
 *   - display the connected daemon's version in the banner
 *   - feature-gate UI for missing capabilities
 *   - nag the user to `axctl update` when their daemon is behind
 */
const API_VERSION = 1;
const API_CAPABILITIES = [
    "skills",      // /api/skills + decide/detail/source/open
    "decisions",   // /api/decisions
    "workflow",    // /api/workflow
    "sessions",    // /api/sessions + detail/children/inspect
    "episodes",    // /api/episodes/:parentId
    "projects",    // /api/projects/:slug
    "graph",       // /api/graph-explorer + /api/skill-graph
    "recall",      // /api/recall
    "tools",       // /api/tool-failures
    "wrapped",     // /api/wrapped + public-preview
    "improve",     // /api/improve + accept/reject/verdict
    "events",      // /api/events (SSE)
] as const;

export async function handleDashboardRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/api/version") {
        const { AX_VERSION } = await import("../cli/version.ts");
        return jsonResponse({
            version: AX_VERSION,
            api_version: API_VERSION,
            capabilities: API_CAPABILITIES,
        });
    }
    if (url.pathname === "/api/query" && req.method === "POST") {
        try {
            const { sql } = await parseQueryRequest(req);
            const started = performance.now();
            const result = await Effect.runPromise(Effect.gen(function* () {
                const db = yield* SurrealClient;
                return yield* db.query(sql);
            }).pipe(Effect.provide(AppLayer), Effect.scoped) as Effect.Effect<unknown>);
            return jsonResponse({ result, durationMs: Math.round(performance.now() - started) });
        } catch (error) {
            return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
        }
    }
    if (url.pathname === "/api/events") {
        let subscriber: ((event: unknown) => void) | null = null;
        let interval: ReturnType<typeof setInterval> | null = null;
        let closed = false;
        let sinceIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(formatSseEvent("ready", { ts: new Date().toISOString() })));
                subscriber = (event: unknown) => {
                    controller.enqueue(new TextEncoder().encode(formatSseEvent("ingest_event", event)));
                };
                addIngestEventSubscriber(subscriber);
                interval = setInterval(async () => {
                    if (closed) return;
                    try {
                        const result = await Effect.runPromise(Effect.gen(function* () {
                            const db = yield* SurrealClient;
                            return yield* db.query<[Array<Record<string, unknown>>]>(recentIngestEventsSql(sinceIso));
                        }).pipe(Effect.provide(AppLayer), Effect.scoped) as Effect.Effect<[Array<Record<string, unknown>>]>);
                        for (const row of result?.[0] ?? []) {
                            if (closed) return;
                            controller.enqueue(new TextEncoder().encode(formatSseEvent("ingest_event", row)));
                            const ts = row.ts;
                            if (typeof ts === "string" || ts instanceof Date) {
                                sinceIso = new Date(ts).toISOString();
                            }
                        }
                    } catch (error) {
                        if (!closed) {
                            controller.enqueue(new TextEncoder().encode(formatSseEvent("error", { message: error instanceof Error ? error.message : String(error) })));
                        }
                    }
                }, 2000);
            },
            cancel() {
                closed = true;
                if (interval) clearInterval(interval);
                if (subscriber) removeIngestEventSubscriber(subscriber);
            },
        });
        return new Response(stream, {
            headers: {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
            },
        });
    }
    const episodeMatch = url.pathname.match(/^\/api\/episodes\/(.+)$/);
    if (episodeMatch && req.method === "GET") {
        const parentId = decodeURIComponent(episodeMatch[1] ?? "");
        if (!parentId) return jsonResponse({ error: "missing parent id" }, 400);
        try {
            const payload = await Effect.runPromise(
                fetchEpisodeTimeline(parentId).pipe(
                    Effect.provide(AppLayer),
                    Effect.scoped,
                ) as Effect.Effect<unknown>,
            );
            return jsonResponse(payload);
        } catch (err) {
            return jsonResponse(
                { error: err instanceof Error ? err.message : String(err) },
                500,
            );
        }
    }
    if (url.pathname === "/api/graph-explorer" && req.method === "GET") {
        const mode = url.searchParams.get("mode");
        const q = url.searchParams.get("q");
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam ? Number(limitParam) : undefined;
        const params: { mode?: string; q?: string | null; limit?: number } = {};
        if (mode !== null) params.mode = mode;
        if (q !== null) params.q = q;
        if (typeof limit === "number" && Number.isFinite(limit)) {
            params.limit = limit;
        }
        try {
            const payload = await Effect.runPromise(
                fetchGraphExplorer(params).pipe(
                    Effect.provide(AppLayer),
                    Effect.scoped,
                ) as Effect.Effect<unknown>,
            );
            return jsonResponse(payload);
        } catch (err) {
            return jsonResponse(
                { error: err instanceof Error ? err.message : String(err) },
                500,
            );
        }
    }
    if (url.pathname === "/api/skill-graph" && req.method === "GET") {
        const minCountParam = url.searchParams.get("minCount");
        const limitParam = url.searchParams.get("limit");
        const minCount = minCountParam ? Number(minCountParam) : undefined;
        const limit = limitParam ? Number(limitParam) : undefined;
        const params: { minCount?: number; limit?: number } = {};
        if (typeof minCount === "number" && Number.isFinite(minCount)) {
            params.minCount = minCount;
        }
        if (typeof limit === "number" && Number.isFinite(limit)) {
            params.limit = limit;
        }
        try {
            const payload = await Effect.runPromise(
                fetchSkillGraph(params).pipe(
                    Effect.provide(AppLayer),
                    Effect.scoped,
                ) as Effect.Effect<unknown>,
            );
            return jsonResponse(payload);
        } catch (err) {
            return jsonResponse(
                { error: err instanceof Error ? err.message : String(err) },
                500,
            );
        }
    }
    if (url.pathname === "/api/recall" && req.method === "GET") {
        const q = url.searchParams.get("q") ?? "";
        const offsetParam = Number(url.searchParams.get("offset") ?? "0");
        const limitParam = Number(url.searchParams.get("limit") ?? "50");
        const offset = Number.isFinite(offsetParam) ? offsetParam : 0;
        const limit = Number.isFinite(limitParam) ? limitParam : 50;
        if (!q.trim()) {
            return jsonResponse({
                q,
                hits: [],
                truncated: false,
                total_count: 0,
                window: { offset, limit },
            });
        }
        const project = url.searchParams.get("project");
        const skill = url.searchParams.get("skill");
        const since = url.searchParams.get("since");
        try {
            const payload = await Effect.runPromise(
                fetchRecall({ q, project, skill, since, offset, limit }).pipe(
                    Effect.provide(AppLayer),
                    Effect.scoped,
                ) as Effect.Effect<unknown>,
            );
            return jsonResponse(payload);
        } catch (err) {
            return jsonResponse(
                { error: err instanceof Error ? err.message : String(err) },
                500,
            );
        }
    }
    const projectMatch = url.pathname.match(/^\/api\/projects\/(.+)$/);
    if (projectMatch && req.method === "GET") {
        const project = decodeURIComponent(projectMatch[1] ?? "");
        if (!project) return jsonResponse({ error: "missing project" }, 400);
        try {
            const payload = await Effect.runPromise(
                fetchProject(project).pipe(
                    Effect.provide(AppLayer),
                    Effect.scoped,
                ) as Effect.Effect<unknown>,
            );
            if (payload === null) {
                return jsonResponse({ error: "project not found" }, 404);
            }
            return jsonResponse(payload);
        } catch (err) {
            return jsonResponse(
                { error: err instanceof Error ? err.message : String(err) },
                500,
            );
        }
    }
    if (url.pathname === "/api/sessions" && req.method === "GET") {
        const offsetParam = Number(url.searchParams.get("offset") ?? "0");
        const limitParam = Number(url.searchParams.get("limit") ?? "200");
        const source = url.searchParams.get("source") ?? undefined;
        const project = url.searchParams.get("project") ?? undefined;
        try {
            const payload = await Effect.runPromise(
                fetchSessionsList({
                    offset: Number.isFinite(offsetParam) ? offsetParam : 0,
                    limit: Number.isFinite(limitParam) ? limitParam : 200,
                    ...(source ? { source } : {}),
                    ...(project ? { project } : {}),
                }).pipe(Effect.provide(AppLayer), Effect.scoped) as Effect.Effect<unknown>,
            );
            return jsonResponse(payload);
        } catch (err) {
            return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
    }

    // Specific routes before the catch-all `sessions/(.+)` below.
    const sessionChildrenMatch = url.pathname.match(/^\/api\/sessions\/(.+)\/children$/);
    if (sessionChildrenMatch && req.method === "GET") {
        const parentId = decodeURIComponent(sessionChildrenMatch[1] ?? "");
        if (!parentId) return jsonResponse({ error: "missing parent id" }, 400);
        const limitParam = Number(url.searchParams.get("limit") ?? "500");
        try {
            const payload = await Effect.runPromise(
                fetchSessionChildren(parentId, {
                    limit: Number.isFinite(limitParam) ? limitParam : 500,
                }).pipe(Effect.provide(AppLayer), Effect.scoped) as Effect.Effect<unknown>,
            );
            return jsonResponse(payload);
        } catch (err) {
            return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
    }
    const sessionInspectMatch = url.pathname.match(/^\/api\/sessions\/(.+)\/inspect$/);
    if (sessionInspectMatch && req.method === "GET") {
        const sessionId = decodeURIComponent(sessionInspectMatch[1] ?? "");
        if (!sessionId) return jsonResponse({ error: "missing session id" }, 400);
        const turnOffset = Number(url.searchParams.get("turn_offset") ?? "0");
        const turnLimit = Number(url.searchParams.get("turn_limit") ?? "100");
        try {
            const payload = await Effect.runPromise(
                fetchSessionInspect(sessionId, {
                    turnOffset: Number.isFinite(turnOffset) ? turnOffset : 0,
                    turnLimit: Number.isFinite(turnLimit) ? turnLimit : 100,
                }).pipe(
                    Effect.provide(AppLayer),
                    Effect.scoped,
                ) as Effect.Effect<unknown>,
            );
            return jsonResponse(payload);
        } catch (err) {
            return jsonResponse(
                { error: err instanceof Error ? err.message : String(err) },
                err instanceof Error && /not found/i.test(err.message) ? 404 : 500,
            );
        }
    }

    const sessionDetailMatch = url.pathname.match(/^\/api\/sessions\/(.+)$/);
    if (sessionDetailMatch && req.method === "GET") {
        const sessionId = decodeURIComponent(sessionDetailMatch[1] ?? "");
        if (!sessionId) return jsonResponse({ error: "missing session id" }, 400);
        try {
            const payload = await Effect.runPromise(
                fetchSessionDetail(sessionId).pipe(
                    Effect.provide(AppLayer),
                    Effect.scoped,
                ) as Effect.Effect<unknown>,
            );
            return jsonResponse(payload);
        } catch (err) {
            return jsonResponse(
                { error: err instanceof Error ? err.message : String(err) },
                500,
            );
        }
    }
    if (url.pathname === "/api/wrapped" && req.method === "GET") {
        try {
            const payload = await Effect.runPromise(
                fetchWrapped().pipe(
                    Effect.provide(AppLayer),
                    Effect.scoped,
                ) as Effect.Effect<unknown>,
            );
            return jsonResponse(payload);
        } catch (err) {
            return jsonResponse(
                { error: err instanceof Error ? err.message : String(err) },
                500,
            );
        }
    }
    if (url.pathname === "/api/wrapped/public-preview" && req.method === "GET") {
        try {
            const payload = await Effect.runPromise(
                fetchWrapped().pipe(
                    Effect.map(sanitizeWrappedProfile),
                    Effect.provide(AppLayer),
                    Effect.scoped,
                ) as Effect.Effect<unknown>,
            );
            return jsonResponse(payload);
        } catch (err) {
            return jsonResponse(
                { error: err instanceof Error ? err.message : String(err) },
                500,
            );
        }
    }
    if (url.pathname === "/api/workflow" && req.method === "GET") {
        try {
            const payload = await Effect.runPromise(
                fetchWorkflow().pipe(
                    Effect.provide(AppLayer),
                    Effect.scoped,
                ) as Effect.Effect<unknown>,
            );
            return jsonResponse(payload);
        } catch (err) {
            return jsonResponse(
                { error: err instanceof Error ? err.message : String(err) },
                500,
            );
        }
    }
    if (url.pathname === "/api/tool-failures" && req.method === "GET") {
        try {
            const payload = await Effect.runPromise(
                fetchToolFailures().pipe(
                    Effect.provide(AppLayer),
                    Effect.scoped,
                ) as Effect.Effect<unknown>,
            );
            return jsonResponse(payload);
        } catch (err) {
            return jsonResponse(
                { error: err instanceof Error ? err.message : String(err) },
                500,
            );
        }
    }
    const failureDetailMatch = url.pathname.match(
        /^\/api\/tool-failures\/(.+)\/detail$/,
    );
    if (failureDetailMatch) {
        const label = decodeURIComponent(failureDetailMatch[1] ?? "");
        if (!label) return jsonResponse({ error: "missing label" }, 400);
        try {
            const payload = await Effect.runPromise(
                fetchToolFailureDetail(label).pipe(
                    Effect.provide(AppLayer),
                    Effect.scoped,
                ) as Effect.Effect<unknown>,
            );
            return jsonResponse(payload);
        } catch (err) {
            return jsonResponse(
                { error: err instanceof Error ? err.message : String(err) },
                500,
            );
        }
    }
    if (url.pathname === "/api/decisions" && req.method === "GET") {
        try {
            const notes = await Effect.runPromise(
                listSkillDecisions().pipe(
                    Effect.provide(AppLayer),
                    Effect.scoped,
                ) as Effect.Effect<unknown>,
            );
            return jsonResponse({ decisions: notes });
        } catch (err) {
            return jsonResponse(
                { error: err instanceof Error ? err.message : String(err) },
                500,
            );
        }
    }
    if (url.pathname === "/api/skills" && req.method === "GET") {
        try {
            const triage = await Effect.runPromise(
                fetchSkillTriage().pipe(
                    Effect.provide(AppLayer),
                    Effect.scoped,
                ) as Effect.Effect<unknown>,
            );
            return jsonResponse(triage);
        } catch (err) {
            return jsonResponse(
                { error: err instanceof Error ? err.message : String(err) },
                500,
            );
        }
    }
    if (url.pathname === "/api/skills/decide-bulk") {
        return handleSkillBulkDecision(req);
    }
    const decisionMatch = url.pathname.match(/^\/api\/skills\/(.+)\/decide$/);
    if (decisionMatch) {
        const name = decodeURIComponent(decisionMatch[1] ?? "");
        if (!name) return jsonResponse({ error: "missing skill name" }, 400);
        return handleSkillDecision(name, req);
    }
    const detailMatch = url.pathname.match(/^\/api\/skills\/(.+)\/detail$/);
    if (detailMatch) {
        const name = decodeURIComponent(detailMatch[1] ?? "");
        if (!name) return jsonResponse({ error: "missing skill name" }, 400);
        return handleSkillDetail(name);
    }
    const sourceMatch = url.pathname.match(/^\/api\/skills\/(.+)\/source$/);
    if (sourceMatch) {
        const name = decodeURIComponent(sourceMatch[1] ?? "");
        if (!name) return jsonResponse({ error: "missing skill name" }, 400);
        return handleSkillSource(name);
    }
    const openMatch = url.pathname.match(/^\/api\/skills\/(.+)\/open$/);
    if (openMatch) {
        const name = decodeURIComponent(openMatch[1] ?? "");
        if (!name) return jsonResponse({ error: "missing skill name" }, 400);
        return handleSkillOpen(name, req);
    }
    const improveActionMatch = url.pathname.match(/^\/api\/improve\/(.+?)\/(accept|reject|verdict)$/);
    if (improveActionMatch) {
        const sig = decodeURIComponent(improveActionMatch[1] ?? "");
        const action = improveActionMatch[2] as "accept" | "reject" | "verdict";
        if (!sig) return jsonResponse({ error: "missing proposal sig" }, 400);
        return handleImproveAction(sig, action, req);
    }
    if (url.pathname.startsWith("/api/")) return queryApi(url.pathname);

    // Non-API GET: serve a tiny landing pointing the user at the hosted
    // studio. The CLI is API-only now; the dashboard UI lives at
    // https://ax.necmttn.com/studio/ and CORS-fetches this daemon.
    if (req.method === "GET") {
        return serveRootLanding(url.port || "1738");
    }
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
        return new Response(null, { status: 204, headers: cors });
    }

    const response = await handleDashboardRequest(req);
    for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
    return response;
}

export async function serveDashboard(args: string[]): Promise<void> {
    const { port } = parseDashboardServeArgs(args);
    // 60s idle timeout - recall queries currently full-scan turn excerpts
    // (no full-text index yet) and can take 5-15s on a year-old graph.
    Bun.serve({ port, fetch: handleDashboardRequestWithCors, idleTimeout: 60 });
    const { formatServeBanner } = await import("../cli/banner.ts");
    console.log(formatServeBanner(port));
}
