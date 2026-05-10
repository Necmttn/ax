import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { AppLayer } from "../lib/layers.ts";
import { graphHealthSql } from "../queries/graph-health.ts";
import { checkoutActivitySql, gitCorrelationSql } from "../queries/insights.ts";

const STATIC_DIR = join(import.meta.dir, "static");

export function parseDashboardServeArgs(args: string[]): { port: number } {
    const raw = args.find((arg) => arg.startsWith("--port="))?.split("=")[1];
    const port = raw === undefined ? 1738 : Number(raw);
    if (!Number.isInteger(port) || port <= 0) throw new Error(`--port must be a positive integer (got ${raw})`);
    return { port };
}

export function routeStaticAsset(url: URL): { path: string; contentType: string } | null {
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    if (!["/index.html", "/app.js", "/styles.css"].includes(pathname)) return null;
    const contentType = pathname.endsWith(".js") ? "text/javascript" : pathname.endsWith(".css") ? "text/css" : "text/html";
    return { path: join(STATIC_DIR, pathname.slice(1)), contentType };
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
        return { error: "not_found" };
    }).pipe(Effect.provide(AppLayer), Effect.scoped);
    return jsonResponse(await Effect.runPromise(program as Effect.Effect<unknown>));
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
    if (url.pathname.startsWith("/api/")) return queryApi(url.pathname);
    const asset = routeStaticAsset(url);
    if (!asset) return new Response("not found", { status: 404 });
    try {
        return new Response(await readFile(asset.path), {
            headers: { "content-type": asset.contentType },
        });
    } catch {
        return new Response("not found", { status: 404 });
    }
}

export function serveDashboard(args: string[]): void {
    const { port } = parseDashboardServeArgs(args);
    Bun.serve({ port, fetch: handleDashboardRequest });
    console.log(`dashboard: http://localhost:${port}`);
}
