#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Surreal } from "surrealdb";

const root = resolve(import.meta.dir, "../..");
const htmlPath = resolve(root, "docs/prototypes/turn-content-blocks-dashboard.html");

const cfg = {
    url: process.env.AX_DB_URL ?? "ws://127.0.0.1:8521",
    ns: process.env.AX_DB_NS ?? "ax",
    db: process.env.AX_DB_DB ?? "main",
    user: process.env.AX_DB_USER ?? "root",
    pass: process.env.AX_DB_PASS ?? "root",
    port: Number.parseInt(process.env.AX_TURN_BLOCKS_PORT ?? "4177", 10),
};

const DB_TIMEOUT_MS = Number.parseInt(process.env.AX_TURN_BLOCKS_DB_TIMEOUT_MS ?? "5000", 10);

const latestTurnContentSql = `
LET $doc = (
    SELECT VALUE id
    FROM content_document
    WHERE source_kind = "turn"
    ORDER BY ts DESC
    LIMIT 1
)[0];

RETURN IF $doc = NONE THEN NONE ELSE {
    document: (
        SELECT
            type::string(id) AS id,
            source_kind,
            source_ref,
            type::string(turn) AS turn,
            type::string(session) AS session,
            type::string(agent_event) AS agent_event,
            title,
            content_hash,
            parse_fingerprint,
            registry_version,
            parser_id,
            parser_version,
            classifier_versions,
            blockset_hash,
            raw_text,
            raw,
            labels,
            metrics,
            type::string(ts) AS ts
        FROM ONLY $doc
    ),
    blocks: (
        SELECT
            type::string(id) AS id,
            type::string(document) AS document,
            kind,
            seq,
            parent_seq,
            role,
            heading,
            text,
            text_excerpt,
            search_text,
            block_hash,
            start_offset,
            end_offset,
            confidence,
            parser,
            raw,
            labels,
            metrics,
            type::string(ts) AS ts
        FROM content_block
        WHERE document = $doc
        ORDER BY seq
    ),
    atoms: (
        SELECT
            type::string(id) AS id,
            type::string(block) AS block,
            type::string(document) AS document,
            source_kind,
            type::string(session) AS session,
            type::string(agent_session) AS agent_session,
            type::string(repository) AS repository,
            type::string(workspace) AS workspace,
            artifact_kind,
            kind,
            value,
            normalized,
            start_offset,
            end_offset,
            confidence,
            raw,
            type::string(ts) AS ts
        FROM content_atom
        WHERE document = $doc
        ORDER BY block, kind, value
    )
} END;
`;

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
        },
    });
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function withDb<T>(fn: (db: Surreal) => Promise<T>): Promise<T> {
    const db = new Surreal();
    const work = (async () => {
        await db.connect(cfg.url);
        await db.signin({ username: cfg.user, password: cfg.pass });
        await db.use({ namespace: cfg.ns, database: cfg.db });
        return await fn(db);
    })();
    const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`SurrealDB did not respond within ${DB_TIMEOUT_MS}ms at ${cfg.url}`)), DB_TIMEOUT_MS);
    });
    try {
        return await Promise.race([work, timeout]);
    } finally {
        try {
            await db.close();
        } catch {
            // best effort
        }
    }
}

function lastPayload(result: unknown): unknown {
    if (!Array.isArray(result)) return result;
    for (let i = result.length - 1; i >= 0; i -= 1) {
        const value = result[i];
        if (value !== null && value !== undefined) return value;
    }
    return null;
}

async function latestTurnContent(): Promise<Response> {
    try {
        const payload = await withDb(async (db) => {
            const result = await db.query(latestTurnContentSql);
            return lastPayload(result);
        });

        if (payload === null || payload === undefined) {
            return json({
                ok: false,
                reason: "no_turn_content",
                message: "No parsed turn content found. Run: axctl ingest --stages=turn-content-blocks --since=7",
            }, 404);
        }

        return json({ ok: true, payload });
    } catch (error) {
        return json({
            ok: false,
            reason: "db_error",
            message: errorMessage(error),
            hint: "Start the daemon and ingest turn blocks: scripts/db-start.sh && axctl ingest --stages=turn-content-blocks --since=7",
        }, 500);
    }
}

async function serveHtml(): Promise<Response> {
    const html = await readFile(htmlPath, "utf8");
    return new Response(html, {
        headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
        },
    });
}

async function handleRequest(req: Request): Promise<Response> {
        const url = new URL(req.url);
        if (url.pathname === "/" || url.pathname === "/turn-content-blocks") {
            return serveHtml();
        }
        if (url.pathname === "/api/turn-content/latest") {
            return latestTurnContent();
        }
        if (url.pathname === "/health") {
            return json({ ok: true });
        }
        return new Response("not found", { status: 404 });
}

function startServer(): ReturnType<typeof Bun.serve> {
    if (process.env.AX_TURN_BLOCKS_PORT) {
        return Bun.serve({ port: cfg.port, idleTimeout: 20, fetch: handleRequest });
    }

    let lastError: unknown;
    for (let port = cfg.port; port < cfg.port + 20; port += 1) {
        try {
            return Bun.serve({ port, idleTimeout: 20, fetch: handleRequest });
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError;
}

const server = startServer();

console.log(`turn content blocks dashboard: http://127.0.0.1:${server.port}/`);
console.log(`api: http://127.0.0.1:${server.port}/api/turn-content/latest`);
