import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
import { fetchWorkflow } from "./workflow.ts";
import { fetchSessionDetail } from "./session-detail.ts";
import { fetchEpisodeTimeline } from "./episode-timeline.ts";
import { fetchProject } from "./project.ts";
import { fetchRecall } from "./recall.ts";
import { fetchSkillGraph } from "./skill-graph.ts";
import { fetchWrapped, sanitizeWrappedProfile } from "./wrapped.ts";

/**
 * Prefer the Vite-built SPA in `web/dist` (`bun run dashboard:build`). Fall
 * back to the legacy hand-rolled `static/` snapshot when dist isn't there yet
 * (e.g. fresh clones that haven't run the build). The legacy assets stay one
 * release as a safety net; remove once the SPA path is exercised.
 */
const SPA_DIST_DIR = join(import.meta.dir, "web", "dist");
const LEGACY_STATIC_DIR = join(import.meta.dir, "static");

const CONTENT_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".map": "application/json",
};

const contentTypeFor = (path: string): string => {
    const dot = path.lastIndexOf(".");
    if (dot < 0) return "application/octet-stream";
    return CONTENT_TYPES[path.slice(dot).toLowerCase()] ?? "application/octet-stream";
};

const LEGACY_PATHS = new Set(["/index.html", "/app.js", "/styles.css"]);

export function parseDashboardServeArgs(args: string[]): { port: number } {
    const raw = args.find((arg) => arg.startsWith("--port="))?.split("=")[1];
    const port = raw === undefined ? 1738 : Number(raw);
    if (!Number.isInteger(port) || port <= 0) throw new Error(`--port must be a positive integer (got ${raw})`);
    return { port };
}

export function routeStaticAsset(url: URL): { path: string; contentType: string } | null {
    // SPA shell + hashed assets land in web/dist/. Anything else under
    // `/assets/`, `/index.html`, or `/` is served from there.
    const requested = url.pathname === "/" ? "/index.html" : url.pathname;
    const isAssetLike =
        requested === "/index.html" ||
        requested.startsWith("/assets/") ||
        /^\/[\w.-]+\.(?:js|css|map|svg|png|ico)$/.test(requested);
    if (isAssetLike) {
        return {
            path: join(SPA_DIST_DIR, requested.slice(1)),
            contentType: contentTypeFor(requested),
        };
    }
    // Legacy hand-rolled static SPA - kept until SPA is fully cut over.
    if (LEGACY_PATHS.has(requested)) {
        return {
            path: join(LEGACY_STATIC_DIR, requested.slice(1)),
            contentType: contentTypeFor(requested),
        };
    }
    return null;
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

export function dashboardApiKind(pathname: string): "graph-health" | "worktrees" | "self-improve" | "unknown" {
    if (pathname === "/api/graph-health") return "graph-health";
    if (pathname === "/api/worktrees") return "worktrees";
    if (pathname === "/api/self-improve") return "self-improve";
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
        return { error: "not_found" };
    }).pipe(Effect.provide(AppLayer), Effect.scoped);
    return jsonResponse(await Effect.runPromise(program as Effect.Effect<unknown>));
}

/**
 * POST /api/skills/:name/decide body: { decision, reason? }
 * DELETE /api/skills/:name/decide  - clears the decision
 */
async function handleSkillDecision(name: string, req: Request): Promise<Response> {
    if (req.method === "DELETE") {
        try {
            await Effect.runPromise(
                clearSkillDecision(name).pipe(
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
    const reason =
        typeof payload.reason === "string" && payload.reason.trim().length > 0
            ? payload.reason.trim()
            : null;
    try {
        const note = await Effect.runPromise(
            setSkillDecision(name, payload.decision, reason).pipe(
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
    const reason =
        typeof payload.reason === "string" && payload.reason.trim().length > 0
            ? payload.reason.trim()
            : null;
    try {
        const notes = await Effect.runPromise(
            setSkillDecisionsBulk(names, payload.decision, reason).pipe(
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

export async function handleDashboardRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
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
        if (!q.trim()) {
            return jsonResponse({ q, hits: [], truncated: false });
        }
        const project = url.searchParams.get("project");
        const skill = url.searchParams.get("skill");
        const since = url.searchParams.get("since");
        try {
            const payload = await Effect.runPromise(
                fetchRecall({ q, project, skill, since }).pipe(
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
    if (url.pathname.startsWith("/api/")) return queryApi(url.pathname);
    const asset = routeStaticAsset(url);
    if (asset) {
        try {
            return new Response(await readFile(asset.path), {
                headers: { "content-type": asset.contentType },
            });
        } catch {
            // fall through to SPA shell
        }
    }
    // SPA fallback: serve index.html for any non-asset, non-API path so
    // TanStack Router can take over client-side. 404 only if dist is missing.
    if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
        try {
            return new Response(await readFile(join(SPA_DIST_DIR, "index.html")), {
                headers: { "content-type": "text/html; charset=utf-8" },
            });
        } catch {
            return new Response("dashboard not built - run `bun run dashboard:build`", {
                status: 503,
            });
        }
    }
    return new Response("not found", { status: 404 });
}

export function serveDashboard(args: string[]): void {
    const { port } = parseDashboardServeArgs(args);
    // 60s idle timeout - recall queries currently full-scan turn excerpts
    // (no full-text index yet) and can take 5-15s on a year-old graph.
    Bun.serve({ port, fetch: handleDashboardRequest, idleTimeout: 60 });
    console.log(`dashboard: http://localhost:${port}`);
}
