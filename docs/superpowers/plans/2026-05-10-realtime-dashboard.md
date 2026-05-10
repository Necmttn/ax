# Realtime Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `agentctl dashboard serve --port=1738` with live ingestion events, graph health, worktree views, and a SurrealQL query workbench.

**Architecture:** Keep the existing static report generator intact. Add a separate Bun HTTP server under `src/dashboard/server.ts`, a small browser app under `src/dashboard/static/`, shared API query handlers, and ingestion telemetry writes that stream through SSE.

**Tech Stack:** Bun HTTP server, TypeScript, SurrealDB SDK, server-sent events, browser JavaScript, existing Effect application layer, `bun test`, `bun run typecheck`. Before editing Effect code, run `effect-solutions list` and `effect-solutions show services-and-layers error-handling testing`.

---

## File Structure

- Create `src/dashboard/server.ts`: Bun server, routing, SSE clients, JSON APIs, static assets.
- Create `src/dashboard/server.test.ts`: route and response tests using local handler functions.
- Create `src/dashboard/telemetry.ts`: ingest telemetry SQL builders and event broadcasting primitives.
- Create `src/dashboard/telemetry.test.ts`: telemetry SQL and event formatting tests.
- Create `src/dashboard/static/index.html`: dashboard shell.
- Create `src/dashboard/static/app.js`: browser app, SSE subscription, fetch APIs, query workbench.
- Create `src/dashboard/static/styles.css`: restrained data-dense UI.
- Modify `src/cli/index.ts`: add `dashboard serve`.
- Modify `src/ingest/git.ts`, `src/ingest/transcripts.ts`, `src/ingest/codex.ts`, `src/ingest/skills.ts`: emit telemetry stages.
- Modify `schema/schema.surql`: add `ingest_run`, `ingest_stage`, `ingest_event`, `query_sample`, `graph_health_check`.

## Task 1: Telemetry Schema and SQL Builders

**Files:**
- Modify: `schema/schema.surql`
- Create: `src/dashboard/telemetry.ts`
- Create: `src/dashboard/telemetry.test.ts`

- [ ] **Step 1: Write failing telemetry tests**

Create `src/dashboard/telemetry.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
    buildIngestEventStatement,
    buildIngestRunStartStatement,
    makeIngestEvent,
} from "./telemetry.ts";

describe("dashboard telemetry", () => {
    test("makeIngestEvent creates stable event shape", () => {
        const event = makeIngestEvent({
            runId: "run1",
            source: "git",
            stage: "write",
            level: "info",
            message: "wrote commits",
            counts: { commits: 2 },
        });
        expect(event.type).toBe("ingest_event");
        expect(event.source).toBe("git");
        expect(event.counts).toEqual({ commits: 2 });
    });

    test("buildIngestRunStartStatement writes run record", () => {
        expect(buildIngestRunStartStatement({ runId: "r1", command: "ingest", sinceDays: 1 }))
            .toContain("UPSERT ingest_run:`r1`");
    });

    test("buildIngestEventStatement stores JSON counts", () => {
        const event = makeIngestEvent({
            runId: "run1",
            source: "git",
            stage: "write",
            level: "info",
            message: "ok",
            counts: { files: 3 },
        });
        expect(buildIngestEventStatement(event)).toContain('"files":3');
    });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```sh
bun test src/dashboard/telemetry.test.ts
```

Expected: FAIL because telemetry module does not exist.

- [ ] **Step 3: Add schema tables**

Append to `schema/schema.surql` before relation definitions:

```surql
DEFINE TABLE ingest_run SCHEMAFULL;
DEFINE FIELD command       ON ingest_run TYPE string;
DEFINE FIELD status        ON ingest_run TYPE string DEFAULT 'running';
DEFINE FIELD since_days    ON ingest_run TYPE option<int>;
DEFINE FIELD started_at    ON ingest_run TYPE datetime DEFAULT time::now();
DEFINE FIELD ended_at      ON ingest_run TYPE option<datetime>;
DEFINE FIELD metrics       ON ingest_run TYPE option<string>;
DEFINE INDEX ingest_run_status_started ON ingest_run FIELDS status, started_at;

DEFINE TABLE ingest_stage SCHEMAFULL;
DEFINE FIELD run           ON ingest_stage TYPE record<ingest_run>;
DEFINE FIELD source        ON ingest_stage TYPE string;
DEFINE FIELD stage         ON ingest_stage TYPE string;
DEFINE FIELD status        ON ingest_stage TYPE string DEFAULT 'running';
DEFINE FIELD started_at    ON ingest_stage TYPE datetime DEFAULT time::now();
DEFINE FIELD ended_at      ON ingest_stage TYPE option<datetime>;
DEFINE FIELD counts        ON ingest_stage TYPE option<string>;
DEFINE FIELD error_text    ON ingest_stage TYPE option<string>;
DEFINE INDEX ingest_stage_run ON ingest_stage FIELDS run, started_at;

DEFINE TABLE ingest_event SCHEMAFULL;
DEFINE FIELD run           ON ingest_event TYPE record<ingest_run>;
DEFINE FIELD source        ON ingest_event TYPE string;
DEFINE FIELD stage         ON ingest_event TYPE string;
DEFINE FIELD level         ON ingest_event TYPE string;
DEFINE FIELD message       ON ingest_event TYPE string;
DEFINE FIELD counts        ON ingest_event TYPE option<string>;
DEFINE FIELD raw           ON ingest_event TYPE option<string>;
DEFINE FIELD ts            ON ingest_event TYPE datetime DEFAULT time::now();
DEFINE INDEX ingest_event_run_ts ON ingest_event FIELDS run, ts;
DEFINE INDEX ingest_event_source_ts ON ingest_event FIELDS source, ts;

DEFINE TABLE query_sample SCHEMAFULL;
DEFINE FIELD name          ON query_sample TYPE option<string>;
DEFINE FIELD sql           ON query_sample TYPE string;
DEFINE FIELD status        ON query_sample TYPE string;
DEFINE FIELD duration_ms   ON query_sample TYPE option<int>;
DEFINE FIELD error_text    ON query_sample TYPE option<string>;
DEFINE FIELD row_count     ON query_sample TYPE option<int>;
DEFINE FIELD created_at    ON query_sample TYPE datetime DEFAULT time::now();

DEFINE TABLE graph_health_check SCHEMAFULL;
DEFINE FIELD kind          ON graph_health_check TYPE string;
DEFINE FIELD status        ON graph_health_check TYPE string;
DEFINE FIELD count         ON graph_health_check TYPE int DEFAULT 0;
DEFINE FIELD rows          ON graph_health_check TYPE option<string>;
DEFINE FIELD created_at    ON graph_health_check TYPE datetime DEFAULT time::now();
DEFINE INDEX graph_health_kind_created ON graph_health_check FIELDS kind, created_at;
```

- [ ] **Step 4: Implement telemetry module**

Create `src/dashboard/telemetry.ts`:

```ts
export type IngestEventLevel = "debug" | "info" | "warn" | "error";

export interface IngestEvent {
    readonly type: "ingest_event";
    readonly id: string;
    readonly runId: string;
    readonly source: string;
    readonly stage: string;
    readonly level: IngestEventLevel;
    readonly message: string;
    readonly counts: Record<string, number>;
    readonly ts: string;
}

const sqlString = (value: string): string => JSON.stringify(value);
const sqlJsonOption = (value: unknown): string => JSON.stringify(JSON.stringify(value));

export function makeIngestEvent(input: Omit<IngestEvent, "type" | "id" | "ts"> & { readonly ts?: string }): IngestEvent {
    const ts = input.ts ?? new Date().toISOString();
    const id = Bun.hash(`${input.runId}|${input.source}|${input.stage}|${input.message}|${ts}`).toString(16);
    return { type: "ingest_event", id, ts, ...input };
}

export function buildIngestRunStartStatement(input: {
    readonly runId: string;
    readonly command: string;
    readonly sinceDays?: number | null;
}): string {
    const since = input.sinceDays === null || input.sinceDays === undefined ? "NONE" : String(input.sinceDays);
    return `UPSERT ingest_run:\`${input.runId}\` MERGE { command: ${sqlString(input.command)}, status: "running", since_days: ${since}, started_at: time::now() };`;
}

export function buildIngestRunFinishStatement(input: {
    readonly runId: string;
    readonly status: "ok" | "error";
    readonly metrics?: unknown;
}): string {
    return `UPDATE ingest_run:\`${input.runId}\` SET status = ${sqlString(input.status)}, ended_at = time::now(), metrics = ${sqlJsonOption(input.metrics ?? {})} RETURN NONE;`;
}

export function buildIngestEventStatement(event: IngestEvent): string {
    return `UPSERT ingest_event:\`${event.id}\` CONTENT { run: ingest_run:\`${event.runId}\`, source: ${sqlString(event.source)}, stage: ${sqlString(event.stage)}, level: ${sqlString(event.level)}, message: ${sqlString(event.message)}, counts: ${sqlJsonOption(event.counts)}, raw: ${sqlJsonOption(event)}, ts: d${sqlString(event.ts)} };`;
}
```

- [ ] **Step 5: Run tests**

Run:

```sh
bun test src/dashboard/telemetry.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add schema/schema.surql src/dashboard/telemetry.ts src/dashboard/telemetry.test.ts
git commit -m "feat: add ingest telemetry records"
```

## Task 2: Dashboard Server Routes

**Files:**
- Create: `src/dashboard/server.ts`
- Create: `src/dashboard/server.test.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Write failing server tests**

Create `src/dashboard/server.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseDashboardServeArgs, routeStaticAsset } from "./server.ts";

describe("dashboard server", () => {
    test("parseDashboardServeArgs defaults to port 1738", () => {
        expect(parseDashboardServeArgs([]).port).toBe(1738);
    });

    test("parseDashboardServeArgs accepts explicit port", () => {
        expect(parseDashboardServeArgs(["--port=1800"]).port).toBe(1800);
    });

    test("routeStaticAsset serves index for root", () => {
        expect(routeStaticAsset(new URL("http://localhost/"))?.path.endsWith("index.html")).toBe(true);
    });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```sh
bun test src/dashboard/server.test.ts
```

Expected: FAIL because server module does not exist.

- [ ] **Step 3: Implement server skeleton**

Create `src/dashboard/server.ts`:

```ts
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
        if (pathname === "/api/worktrees") return yield* db.query(`${checkoutActivitySql(50)}\\n${gitCorrelationSql(50)}`);
        return { error: "not_found" };
    }).pipe(Effect.provide(AppLayer), Effect.scoped);
    return jsonResponse(await Effect.runPromise(program as Effect.Effect<unknown>));
}

export async function handleDashboardRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) return queryApi(url.pathname);
    const asset = routeStaticAsset(url);
    if (!asset) return new Response("not found", { status: 404 });
    return new Response(await readFile(asset.path), {
        headers: { "content-type": asset.contentType },
    });
}

export function serveDashboard(args: string[]): void {
    const { port } = parseDashboardServeArgs(args);
    Bun.serve({ port, fetch: handleDashboardRequest });
    console.log(`dashboard: http://localhost:${port}`);
}
```

- [ ] **Step 4: Wire CLI command**

In `src/cli/index.ts`, import:

```ts
import { serveDashboard } from "../dashboard/server.ts";
```

Update help:

```txt
agentctl dashboard serve [--port=1738]
```

In command dispatch, handle:

```ts
if (cmd === "dashboard" && rest[0] === "serve") {
    serveDashboard(rest.slice(1));
    return;
}
```

Place this before the existing static `dashboard` command path.

- [ ] **Step 5: Run tests**

Run:

```sh
bun test src/dashboard/server.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add src/dashboard/server.ts src/dashboard/server.test.ts src/cli/index.ts
git commit -m "feat: add dashboard serve command"
```

## Task 3: Static Dashboard UI

**Files:**
- Create: `src/dashboard/static/index.html`
- Create: `src/dashboard/static/app.js`
- Create: `src/dashboard/static/styles.css`
- Test: `src/dashboard/server.test.ts`

- [ ] **Step 1: Add static asset existence test**

Append to `src/dashboard/server.test.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";

test("dashboard static assets exist", () => {
    const dir = join(import.meta.dir, "static");
    expect(existsSync(join(dir, "index.html"))).toBe(true);
    expect(existsSync(join(dir, "app.js"))).toBe(true);
    expect(existsSync(join(dir, "styles.css"))).toBe(true);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```sh
bun test src/dashboard/server.test.ts
```

Expected: FAIL because static assets do not exist.

- [ ] **Step 3: Create HTML shell**

Create `src/dashboard/static/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>agentctl dashboard</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <main class="app">
      <header class="topbar">
        <h1>agentctl</h1>
        <nav>
          <button data-view="ingest">Ingest</button>
          <button data-view="health">Graph Health</button>
          <button data-view="worktrees">Worktrees</button>
          <button data-view="query">Query</button>
        </nav>
      </header>
      <section id="status" class="status">connecting</section>
      <section id="view" class="view"></section>
    </main>
    <script src="/app.js" type="module"></script>
  </body>
</html>
```

- [ ] **Step 4: Create browser app**

Create `src/dashboard/static/app.js`:

```js
const view = document.querySelector("#view");
const status = document.querySelector("#status");

async function fetchJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

function table(rows) {
  const flat = Array.isArray(rows?.[0]) ? rows.flat() : rows;
  if (!Array.isArray(flat) || flat.length === 0) return "<p class='empty'>No rows.</p>";
  const keys = Object.keys(flat[0]);
  return `<table><thead><tr>${keys.map((k) => `<th>${k}</th>`).join("")}</tr></thead><tbody>${flat
    .map((row) => `<tr>${keys.map((k) => `<td><code>${String(row[k] ?? "")}</code></td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

async function showHealth() {
  view.innerHTML = "<h2>Graph Health</h2><p>Loading...</p>";
  view.innerHTML = `<h2>Graph Health</h2>${table(await fetchJson("/api/graph-health"))}`;
}

async function showWorktrees() {
  view.innerHTML = "<h2>Worktrees</h2><p>Loading...</p>";
  view.innerHTML = `<h2>Worktrees</h2>${table(await fetchJson("/api/worktrees"))}`;
}

function showIngest() {
  view.innerHTML = "<h2>Ingest Live</h2><ol id='events'></ol>";
}

function showQuery() {
  view.innerHTML = `<h2>Query Workbench</h2><textarea id="sql" spellcheck="false">SELECT * FROM session LIMIT 5;</textarea><button id="run">Run</button><section id="result"></section>`;
}

document.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const selected = target.dataset.view;
  if (selected === "ingest") showIngest();
  if (selected === "health") await showHealth();
  if (selected === "worktrees") await showWorktrees();
  if (selected === "query") showQuery();
});

status.textContent = "ready";
showIngest();
```

- [ ] **Step 5: Create CSS**

Create `src/dashboard/static/styles.css`:

```css
:root {
  color-scheme: dark;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #0b0d10;
  color: #e6e8eb;
}

body {
  margin: 0;
}

.app {
  min-height: 100vh;
  display: grid;
  grid-template-rows: auto auto 1fr;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid #242933;
  background: #11151b;
}

h1, h2 {
  margin: 0;
  font-size: 16px;
}

nav {
  display: flex;
  gap: 8px;
}

button {
  border: 1px solid #303747;
  background: #171d26;
  color: #e6e8eb;
  border-radius: 6px;
  padding: 8px 10px;
}

.status {
  padding: 8px 18px;
  border-bottom: 1px solid #202632;
  color: #9aa3b2;
}

.view {
  padding: 18px;
  overflow: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 14px;
  font-size: 12px;
}

th, td {
  border-bottom: 1px solid #202632;
  padding: 8px;
  text-align: left;
  vertical-align: top;
}

code, textarea {
  font-family: "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace;
}

textarea {
  width: min(900px, 100%);
  min-height: 180px;
  box-sizing: border-box;
  border: 1px solid #303747;
  border-radius: 6px;
  background: #0d1117;
  color: #e6e8eb;
  padding: 10px;
}

.empty {
  color: #8b94a5;
}
```

- [ ] **Step 6: Run tests**

Run:

```sh
bun test src/dashboard/server.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```sh
git add src/dashboard/static src/dashboard/server.test.ts
git commit -m "feat: add dashboard web shell"
```

## Task 4: Query Workbench API

**Files:**
- Modify: `src/dashboard/server.ts`
- Modify: `src/dashboard/server.test.ts`
- Modify: `src/dashboard/static/app.js`

- [ ] **Step 1: Write failing request parsing test**

Add to `src/dashboard/server.test.ts`:

```ts
import { parseQueryRequest } from "./server.ts";

test("parseQueryRequest rejects non-select mutations", async () => {
    await expect(parseQueryRequest(new Request("http://x/api/query", {
        method: "POST",
        body: JSON.stringify({ sql: "DELETE session;" }),
    }))).rejects.toThrow("Only SELECT, RETURN, and INFO queries are allowed");
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```sh
bun test src/dashboard/server.test.ts
```

Expected: FAIL because `parseQueryRequest` does not exist.

- [ ] **Step 3: Implement safe query parsing**

In `src/dashboard/server.ts`, add:

```ts
export async function parseQueryRequest(req: Request): Promise<{ sql: string }> {
    const body = await req.json() as { sql?: unknown };
    const sql = typeof body.sql === "string" ? body.sql.trim() : "";
    if (!sql) throw new Error("SQL is required");
    if (!/^(SELECT|RETURN|INFO)\\b/i.test(sql)) {
        throw new Error("Only SELECT, RETURN, and INFO queries are allowed");
    }
    return { sql };
}
```

Add `/api/query` handling:

```ts
if (url.pathname === "/api/query" && req.method === "POST") {
    const { sql } = await parseQueryRequest(req);
    const started = performance.now();
    const result = await Effect.runPromise(Effect.gen(function* () {
        const db = yield* SurrealClient;
        return yield* db.query(sql);
    }).pipe(Effect.provide(AppLayer), Effect.scoped) as Effect.Effect<unknown>);
    return jsonResponse({ result, durationMs: Math.round(performance.now() - started) });
}
```

- [ ] **Step 4: Wire browser query button**

In `src/dashboard/static/app.js`, add after `showQuery()` rendering:

```js
document.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || target.id !== "run") return;
  const sql = document.querySelector("#sql").value;
  const result = document.querySelector("#result");
  result.textContent = "running";
  try {
    const json = await fetchJsonPost("/api/query", { sql });
    result.innerHTML = table(json.result);
  } catch (error) {
    result.innerHTML = `<pre>${String(error.message ?? error)}</pre>`;
  }
});

async function fetchJsonPost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
```

- [ ] **Step 5: Run tests**

Run:

```sh
bun test src/dashboard/server.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add src/dashboard/server.ts src/dashboard/server.test.ts src/dashboard/static/app.js
git commit -m "feat: add dashboard query workbench"
```

## Task 5: SSE Event Stream

**Files:**
- Modify: `src/dashboard/server.ts`
- Modify: `src/dashboard/static/app.js`
- Modify: `src/dashboard/server.test.ts`

- [ ] **Step 1: Write event formatting test**

Add to `src/dashboard/server.test.ts`:

```ts
import { formatSseEvent } from "./server.ts";

test("formatSseEvent emits valid SSE frame", () => {
    expect(formatSseEvent("message", { ok: true })).toBe("event: message\\ndata: {\\"ok\\":true}\\n\\n");
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```sh
bun test src/dashboard/server.test.ts
```

Expected: FAIL because `formatSseEvent` does not exist.

- [ ] **Step 3: Implement SSE route**

In `src/dashboard/server.ts`, add:

```ts
export function formatSseEvent(event: string, data: unknown): string {
    return `event: ${event}\\ndata: ${JSON.stringify(data)}\\n\\n`;
}
```

Add route in `handleDashboardRequest`:

```ts
if (url.pathname === "/api/events") {
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(formatSseEvent("ready", { ts: new Date().toISOString() })));
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
```

- [ ] **Step 4: Subscribe in browser**

In `src/dashboard/static/app.js`, add:

```js
const events = new EventSource("/api/events");
events.addEventListener("ready", (event) => {
  status.textContent = `live ${JSON.parse(event.data).ts}`;
});
events.addEventListener("ingest_event", (event) => {
  const list = document.querySelector("#events");
  if (!list) return;
  const item = document.createElement("li");
  item.textContent = event.data;
  list.prepend(item);
});
events.onerror = () => {
  status.textContent = "live stream disconnected";
};
```

- [ ] **Step 5: Run tests**

Run:

```sh
bun test src/dashboard/server.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add src/dashboard/server.ts src/dashboard/server.test.ts src/dashboard/static/app.js
git commit -m "feat: stream dashboard events"
```

## Task 6: Verification

**Files:**
- No new source files.

- [ ] **Step 1: Run focused tests**

Run:

```sh
bun test src/dashboard/telemetry.test.ts src/dashboard/server.test.ts src/dashboard/report.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full tests**

Run:

```sh
bun test
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```sh
bun run typecheck
```

Expected: exit 0.

- [ ] **Step 4: Start dashboard**

Run:

```sh
bun src/cli/index.ts dashboard serve --port=1738
```

Expected: process stays running and prints `dashboard: http://localhost:1738`.

- [ ] **Step 5: Browser smoke test**

Open:

```txt
http://localhost:1738
```

Expected: dashboard shell loads, Graph Health and Worktrees fetch JSON, Query Workbench can run `SELECT * FROM session LIMIT 5;`.

- [ ] **Step 6: Commit verification fixes**

If fixes are needed:

```sh
git add src/dashboard src/cli/index.ts schema/schema.surql
git commit -m "fix: stabilize realtime dashboard"
```

If no fixes are needed, do not create an empty commit.
