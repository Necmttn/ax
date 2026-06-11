# Phase 3: Dashboard Route Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ~546-line `if (url.pathname === ...)` chain in `apps/axctl/src/dashboard/server.ts` (1,249 LOC) with a typed, ordered route table. Each route becomes one declaration - method, path pattern, pure param decoder, Effect handler returning a typed payload from `@ax/lib/shared/dashboard-types` - and `server.ts` shrinks to: dispatch + decode + run + encode + error mapping + serve lifecycle (~250 LOC). Migration is incremental: the dispatcher runs in front of the if-chain, route families move over one task at a time, the chain shrinks to nothing and dies in the final task.

**Architecture:** A tiny in-repo router (`apps/axctl/src/dashboard/router/router.ts`, no framework) compiles `:name` (single segment) and `:name+` (greedy, regex `(.+)` - exact parity with today's regexes) patterns to RegExp. The route table (`router/table.ts`) is an ordered `ReadonlyArray<AnyRoute>`; first match wins; matched-path-wrong-method → 405. Two route kinds: `jsonRoute` (decode → Effect handler → JSON encode, with optional `respond`/`errorStatus` overrides) and `rawRoute` (full `Request → Response` escape hatch for SSE `/api/events`, binary `/api/image`, and `POST /api/ingest` - the IngestStreamBus seam is NOT touched, per ADR-0007/0008). The Effect runner is injectable (`EffectRunner`) so router unit tests never build `AppLayer`/DB; production uses `appLayerRunner` which centralizes the one `Effect.provide(AppLayer) + Effect.scoped + cast` that today is copy-pasted ~30 times.

**Tech Stack:** bun ≥1.3, TypeScript strict, Effect v4 (`effect@beta`), `bun:test` colocated. Reuses: `@ax/lib/layers` (`AppLayer`), `@ax/lib/db` (`SurrealClient`), `@ax/lib/shared/dashboard-types` (response types), existing per-route modules (`session-detail.ts`, `sessions-list.ts`, `session-inspect.ts`, `session-compare.ts`, `episode-timeline.ts`, `project.ts`, `recall.ts`, `workflow.ts`, `wrapped.ts`, `triage.ts`, `tool-failures.ts`, `skill-source.ts`, `skill-graph.ts`, `graph-explorer.ts`, `session-canvas.ts`, `session-summary.ts`, `../timeline/service.ts`, `../improve/actions.ts`).

**Decoder choice:** Effect Schema-backed decoding - `docs/effect-json-boundaries.md` and `packages/lib/src/decode.ts` already establish Effect Schema as the repo's IO-boundary decode mechanism, so param helpers wrap verified v4 primitives (`Schema.FiniteFromString`, `Schema.Literals`, `Schema.decodeUnknownOption`) in small pure functions that preserve today's lenient fall-back-to-default semantics (a strict whole-struct decode would silently change behavior on garbage query strings).

**Running tests:** a repo hook blocks the literal `bun␠test` typed in a shell command. Create a wrapper file via your editor (not a heredoc) and run it:
`/tmp/rt.sh` containing:
```
#!/bin/bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
exec bun test "$@"
```
then `chmod +x /tmp/rt.sh && /tmp/rt.sh <path>`. (Adjust `cd` to your worktree root if needed.)

**Typecheck:** `bun run typecheck 2>&1 | rg "dashboard"` must be empty after every task. Pre-existing unrelated errors elsewhere are not yours; do not fix them here.

**Commit rule:** stage only the files each task names (NEVER `git add -A` - repo convention). End every commit body with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## Do-not-touch list

- `POST /api/ingest` internals: `startIngestWorkflow`, `IngestStreamBus`, `ingest-stream.ts`, `ingest-stream-durable.ts`, `ingest-workflow.ts`. The handler body moves verbatim behind a `rawRoute`; its logic does not change (ADR-0007/0008 territory, two adapters, works).
- Handler/fetch-module internals (`fetchSessionDetail`, etc.) - making those DB-decoupled is Phase 1's job, not this plan's.
- `handleDashboardRequestWithCors` CORS/PNA logic - unchanged.
- Response *shapes* on the wire - every payload, status code, and error body stays byte-identical except the explicitly listed behavioral deltas below.

## Intentional behavioral deltas (each must be covered by a test)

1. **405 on matched-path-wrong-method.** Today e.g. `POST /api/wrapped` falls through to the `queryApi` catch-all and returns `200 {"error":"not_found"}`. Once a path is in the table, a wrong method returns `405 {"error":"method_not_allowed"}` (matching the 405 bodies the skill/improve handlers already emit). `/api/version` keeps method `"ANY"` (today it answers any method; the hosted studio may probe it).
2. **Read-only routes tightened to GET.** `/api/tool-failures/:label+/detail`, `/api/skills/:name+/detail`, `/api/skills/:name+/source` currently match any method; they become GET (wrong method → 405 per delta 1).
3. **`POST /api/query` with invalid JSON** returns `400 {"error":"invalid_json"}` instead of `400` with the raw `JSON.parse` exception message. (Valid-JSON validation errors keep their exact messages: `"SQL is required"`, `"Only SELECT, RETURN, and INFO queries are allowed"`.)
4. **`/api/improve/:sig/<garbage-action>`** returns `404 {"error":"unknown_improve_action"}` instead of the catch-all `200 {"error":"not_found"}`.
5. **Empty-string numeric query params** (e.g. `?limit=`): legacy `Number("") === 0` made them `0`; `Schema.FiniteFromString` rejects `""` so they now fall back to the route default. Well-formed inputs are unchanged.
6. **Unknown `/api/*` paths** keep the legacy quirk: `200 {"error":"not_found"}` (preserved deliberately for hosted-studio compat; flagged as a future api_version-bump candidate, NOT changed in this plan).

---

## Complete route inventory

`server.ts` line ranges are pre-refactor (current `main`). "Handler module" = where the business logic lives after migration; modules marked *(existing)* already exist and are only pointed at.

| # | Method | Path pattern | Current lines | Params | Response type | Handler module |
|---|--------|--------------|---------------|--------|---------------|----------------|
| 1 | ANY | `/api/version` | 536-543 | - | `{version, api_version, capabilities}` | `router/routes/system.ts` + `capabilities.ts` |
| 2 | POST | `/api/query` | 544-556 + 106-114 | body `{sql}` (SELECT/RETURN/INFO only) | `{result, durationMs}` / 400 | `router/routes/system.ts` |
| 3 | GET | `/api/graph-health` | 1074 → 145-148 | - | raw rows (`unknown`, legacy) | `router/routes/system.ts` (SQL from `queries/graph-health.ts`) |
| 4 | GET | `/api/worktrees` | 1074 → 149-153 | - | `{activity, git}` (legacy `unknown`) | `router/routes/system.ts` (SQL from `queries/insights.ts`) |
| 5 | GET | `/api/self-improve` | 1074 → 154-160 | - | raw rows (legacy `unknown`) | `router/routes/system.ts` (inline SQL, moved verbatim) |
| 6 | GET | `/api/improve` | 1074 → 161-183 | - | `{proposals: Record<string,unknown>[]}` (legacy) | `router/routes/system.ts` (inline SQL, moved verbatim) |
| 7 | GET (raw, SSE) | `/api/events` | 557-604 | - | `text/event-stream` | `router/routes/live.ts` |
| 8 | GET | `/api/episodes/:parentId+` | 605-623 | path `parentId` | `EpisodeTimelinePayload` | `episode-timeline.ts` *(existing)* |
| 9 | GET | `/api/graph-explorer` | 624-655 | query `mode`, `q`, `limit`; env gate | `GraphExplorerPayload` / 404 disabled | `graph-explorer.ts` *(existing)* |
| 10 | GET | `/api/session-canvas` | 656-677 | query `limit` | `SessionCanvasPayload` | `session-canvas.ts` *(existing)* |
| 11 | GET | `/api/session-summary` | 678-689 | query `id` (required) | `SessionSummary` | `session-summary.ts` *(existing)* |
| 12 | GET | `/api/session-orchestration` | 690-707 | query `id` (required) | `SessionOrchestration` | `session-canvas.ts` *(existing)* |
| 13 | GET | `/api/skill-graph` | 708-734 | query `minCount`, `limit` | `SkillGraphPayload` | `skill-graph.ts` *(existing)* |
| 14 | GET | `/api/recall` | 735-770 | query `q`, `offset`, `limit`, `project`, `skill`, `since`; empty `q` → empty response | `RecallResponse` | `recall.ts` *(existing)* |
| 15 | GET | `/api/projects/:project+` | 771-792 | path `project` | `ProjectPagePayload`; `null` → 404 | `project.ts` *(existing)* |
| 16 | GET | `/api/sessions` | 793-811 | query `offset`, `limit`, `source`, `project` | `SessionListResponse` | `sessions-list.ts` *(existing)* |
| 17 | GET | `/api/sessions/compare` | 814-834 | query `ids` (csv, ≥2 → else 400), `turns` ("1") | `SessionComparePayload` | `session-compare.ts` *(existing)* |
| 18 | GET | `/api/sessions/:id+/children` | 835-850 | path `id`; query `limit` | `SessionChildrenResponse` | `sessions-list.ts` *(existing)* |
| 19 | GET | `/api/sessions/:id+/inspect` | 851-874 | path `id`; query `turn_offset`, `turn_limit`; `/not found/i` → 404 | `SessionInspectPayload` | `session-inspect.ts` *(existing)* |
| 20 | GET | `/api/sessions/:id+/timeline` | 876-895 | path `id`; `/not found/i` → 404; needs `SessionTimelineServiceLayer` | `SessionTimeline` | `../timeline/service.ts` *(existing)* |
| 21 | GET | `/api/sessions/:id+` | 897-915 | path `id` (catch-all, LAST in sessions family) | `SessionDetailPayload` | `session-detail.ts` *(existing)* |
| 22 | GET | `/api/wrapped` | 916-931 | - | `WrappedProfile` | `wrapped.ts` *(existing)* |
| 23 | GET | `/api/wrapped/public-preview` | 932-948 | - | `WrappedProfile` (sanitized) | `wrapped.ts` *(existing)* |
| 24 | GET | `/api/workflow` | 949-964 | - | `WorkflowResponse` | `workflow.ts` *(existing)* |
| 25 | GET | `/api/tool-failures` | 965-980 | - | `ToolFailuresResponse` | `tool-failures.ts` *(existing)* |
| 26 | GET (was ANY) | `/api/tool-failures/:label+/detail` | 981-1001 | path `label` | `ToolFailureDetailPayload` | `tool-failures.ts` *(existing)* |
| 27 | GET | `/api/decisions` | 1002-1017 | - | `{decisions: SkillTriageNote[]}` | `triage.ts` *(existing)* |
| 28 | GET | `/api/skills` | 1018-1033 | - | `SkillTriageResponse` | `triage.ts` *(existing)* |
| 29 | POST | `/api/skills/decide-bulk` | 1034-1036 → 375-424 | body `{names[], decision, reason?}` | `{notes}` | `router/routes/skills.ts` → `triage.ts` + `skill-source.ts` |
| 30 | POST | `/api/skills/:name+/decide` | 1037-1042 → 264-304 | path `name`; body `{decision, reason?}` | saved note | `router/routes/skills.ts` → `triage.ts` + `skill-source.ts` |
| 31 | DELETE | `/api/skills/:name+/decide` | 1037-1042 → 243-263 | path `name` | `{cleared, skill_name}` | `router/routes/skills.ts` → `triage.ts` + `skill-source.ts` |
| 32 | GET (was ANY) | `/api/skills/:name+/detail` | 1043-1048 → 307-322 | path `name` | `SkillDetailPayload` | `triage.ts` *(existing)* |
| 33 | GET (was ANY) | `/api/skills/:name+/source` | 1049-1054 → 325-340 | path `name` | `SkillSourcePayload` | `skill-source.ts` *(existing)* |
| 34 | POST | `/api/skills/:name+/open` | 1055-1060 → 343-372 | path `name`; body `{target: "finder"\|"editor"}` | `{launched}` | `skill-source.ts` *(existing)* |
| 35 | POST | `/api/improve/:sig/:action` | 1061-1067 → 197-236 | path `sig`, `action` ∈ accept\|reject\|verdict; body `{force?\|reason?\|verdict?}`; result.status → HTTP map | `{status, message?}` | `router/routes/improve.ts` → `../improve/actions.ts` |
| 36 | POST (raw) | `/api/ingest` | 1068-1070 → 489-532 | body `{since?}` | `{runId, stream, streamName, streamBaseUrl}` / 503 | `router/routes/live.ts` (verbatim move; seam untouched) |
| 37 | GET (raw) | `/api/image` | 1071-1073 → 47-97 | query `path` (allowlisted image ext) | image bytes / 404 | `router/routes/live.ts` |
| - | fallback | unknown `/api/*` | 1074 → 184 | - | `200 {"error":"not_found"}` (legacy quirk, preserved) | `server.ts` epilogue |
| - | fallback | GET non-API | 1079-1081, 1090-1134 | - | HTML landing | `server.ts` (`serveRootLanding`, unchanged) |
| - | fallback | anything else | 1082 | - | `404 "not found"` | `server.ts` epilogue |

**Ordering constraints encoded in `table.ts`:** within the sessions family `compare` (static) precedes the `:id+` routes; `:id+/children|inspect|timeline` precede the bare `:id+` detail catch-all; `decide-bulk` (static) sits with the skills family (no actual conflict with `:name+/decide` since `(.+)/decide$` cannot match `decide-bulk`, but keep static-before-param as the house rule). First match wins; the table is a flat ordered array.

---

## File structure

```
apps/axctl/src/dashboard/
  capabilities.ts                       # CREATE (Task 3): API_VERSION, capabilities, isGraphExplorerEnabled (moved from server.ts 436-463)
  ingest-state.ts                       # CREATE (Task 8): ServeIngestState + get/set (moved from server.ts 478-486)
  router/
    router.ts                           # CREATE (Task 1): patterns, AnyRoute, jsonRoute/rawRoute, dispatch, jsonResponse, EffectRunner
    router.test.ts                      # CREATE (Task 1)
    params.ts                           # CREATE (Task 2): Schema-backed query/body helpers
    params.test.ts                      # CREATE (Task 2)
    table.ts                            # CREATE (Task 3, grows through Task 8): ordered route table
    routes/
      system.ts        + system.test.ts        # CREATE (Task 3): version, query, graph-health, worktrees, self-improve, improve-list
      insights.ts      + insights.test.ts      # CREATE (Task 4): workflow, wrapped×2, tool-failures×2, recall, episodes, projects, graph-explorer, skill-graph
      sessions.ts      + sessions.test.ts      # CREATE (Task 5): sessions, compare, children, inspect, timeline, detail, summary, orchestration, canvas
      skills.ts        + skills.test.ts        # CREATE (Task 6): skills, decisions, decide-bulk, decide POST/DELETE, detail, source, open
      improve.ts       + improve.test.ts       # CREATE (Task 7): improve/:sig/:action
      live.ts          + live.test.ts          # CREATE (Task 8): events (SSE), image, ingest - raw escape hatches
  server.ts                             # SHRINKS every task; final ~250 LOC (serve lifecycle, CORS, dispatch epilogue, landing)
  server.test.ts                        # MODIFIED Tasks 3 & 8 (imports follow moved symbols; request-level tests unchanged)
```

---

## Task 1: Router core

**Files:**
- Create: `apps/axctl/src/dashboard/router/router.ts`
- Create: `apps/axctl/src/dashboard/router/router.test.ts`

- [ ] **Step 1: Write the failing test file** `router/router.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
    compilePattern,
    decodeFail,
    decodeOk,
    dispatch,
    jsonResponse,
    jsonRoute,
    matchRoute,
    rawRoute,
    type AnyRoute,
    type EffectRunner,
} from "./router.ts";

/** Test runner: handlers in these tests are pure, so run without AppLayer. */
const testRunner: EffectRunner = <A,>(effect: Effect.Effect<A, unknown, never>): Promise<A> =>
    Effect.runPromise(effect as Effect.Effect<A>);

const get = (path: string): Request => new Request(`http://127.0.0.1:1738${path}`);
const post = (path: string, body?: string): Request =>
    new Request(`http://127.0.0.1:1738${path}`, { method: "POST", ...(body === undefined ? {} : { body }) });

describe("compilePattern", () => {
    test(":name matches exactly one segment", () => {
        const p = compilePattern("/api/improve/:sig/:action");
        expect("/api/improve/abc/accept".match(p.regex)?.slice(1)).toEqual(["abc", "accept"]);
        expect("/api/improve/abc/def/accept".match(p.regex)).toBeNull();
        expect(p.keys).toEqual(["sig", "action"]);
    });

    test(":name+ is greedy across slashes (parity with legacy (.+) regexes)", () => {
        const p = compilePattern("/api/sessions/:id+/inspect");
        expect("/api/sessions/a/b/inspect".match(p.regex)?.slice(1)).toEqual(["a/b"]);
    });

    test("static patterns escape regex metacharacters", () => {
        const p = compilePattern("/api/wrapped");
        expect("/api/wrapped".match(p.regex)).not.toBeNull();
        expect("/api/wrappedX".match(p.regex)).toBeNull();
    });
});

describe("matchRoute", () => {
    const table: ReadonlyArray<AnyRoute> = [
        jsonRoute({
            method: "GET",
            path: "/api/thing/:id",
            decode: ({ path }) => decodeOk({ id: path.id ?? "" }),
            handler: (p) => Effect.succeed({ got: p.id }),
        }),
    ];

    test("matched route decodes URI components in path params", () => {
        const m = matchRoute(table, "GET", "/api/thing/a%2Fb");
        expect(m.kind).toBe("matched");
        if (m.kind === "matched") expect(m.match.path.id).toBe("a/b");
    });

    test("unmatched path reports unmatched", () => {
        expect(matchRoute(table, "GET", "/api/other").kind).toBe("unmatched");
    });

    test("matched path with wrong method reports method_mismatch", () => {
        expect(matchRoute(table, "POST", "/api/thing/x").kind).toBe("method_mismatch");
    });
});

describe("dispatch", () => {
    test("first match wins (declaration order)", async () => {
        const table: ReadonlyArray<AnyRoute> = [
            jsonRoute({
                method: "GET",
                path: "/api/x/static",
                decode: () => decodeOk(undefined),
                handler: () => Effect.succeed({ which: "static" }),
            }),
            jsonRoute({
                method: "GET",
                path: "/api/x/:id+",
                decode: ({ path }) => decodeOk({ id: path.id ?? "" }),
                handler: (p) => Effect.succeed({ which: "param", id: p.id }),
            }),
        ];
        const res = await dispatch(table, get("/api/x/static"), new URL("http://h/api/x/static"), testRunner);
        expect(await res?.json()).toEqual({ which: "static" });
    });

    test("unmatched returns null so the caller can fall through", async () => {
        expect(await dispatch([], get("/api/nope"), new URL("http://h/api/nope"), testRunner)).toBeNull();
    });

    test("method mismatch returns 405 method_not_allowed", async () => {
        const table = [jsonRoute({
            method: "GET",
            path: "/api/only-get",
            decode: () => decodeOk(undefined),
            handler: () => Effect.succeed({ ok: true }),
        })];
        const res = await dispatch(table, post("/api/only-get"), new URL("http://h/api/only-get"), testRunner);
        expect(res?.status).toBe(405);
        expect(await res?.json()).toEqual({ error: "method_not_allowed" });
    });

    test("decode failure short-circuits with the decoder's body + status", async () => {
        const table = [jsonRoute({
            method: "GET",
            path: "/api/fail",
            decode: () => decodeFail("missing id", 400),
            handler: () => Effect.succeed({ unreachable: true }),
        })];
        const res = await dispatch(table, get("/api/fail"), new URL("http://h/api/fail"), testRunner);
        expect(res?.status).toBe(400);
        expect(await res?.json()).toEqual({ error: "missing id" });
    });

    test("handler failure maps through errorStatus (default 500)", async () => {
        const table = [jsonRoute({
            method: "GET",
            path: "/api/boom",
            decode: () => decodeOk(undefined),
            handler: () => Effect.fail(new Error("session not found")),
            errorStatus: (err) => err instanceof Error && /not found/i.test(err.message) ? 404 : 500,
        })];
        const res = await dispatch(table, get("/api/boom"), new URL("http://h/api/boom"), testRunner);
        expect(res?.status).toBe(404);
        expect(await res?.json()).toEqual({ error: "session not found" });
    });

    test("respond overrides the default JSON encoding", async () => {
        const table = [jsonRoute({
            method: "GET",
            path: "/api/maybe",
            decode: () => decodeOk(undefined),
            handler: () => Effect.succeed(null),
            respond: (value) => value === null
                ? jsonResponse({ error: "project not found" }, 404)
                : jsonResponse(value),
        })];
        const res = await dispatch(table, get("/api/maybe"), new URL("http://h/api/maybe"), testRunner);
        expect(res?.status).toBe(404);
    });

    test("readsBody: invalid JSON arrives as kind=invalid, valid as kind=json", async () => {
        const seen: unknown[] = [];
        const table = [jsonRoute({
            method: "POST",
            path: "/api/body",
            readsBody: true,
            decode: ({ body }) => { seen.push(body); return decodeOk(undefined); },
            handler: () => Effect.succeed({ ok: true }),
        })];
        await dispatch(table, post("/api/body", "{not json"), new URL("http://h/api/body"), testRunner);
        await dispatch(table, post("/api/body", '{"a":1}'), new URL("http://h/api/body"), testRunner);
        expect(seen[0]).toEqual({ kind: "invalid" });
        expect(seen[1]).toEqual({ kind: "json", value: { a: 1 } });
    });

    test("rawRoute gets the request untouched and returns its own Response", async () => {
        const table = [rawRoute({
            method: "GET",
            path: "/api/raw",
            handler: () => new Response("bytes", { status: 200 }),
        })];
        const res = await dispatch(table, get("/api/raw"), new URL("http://h/api/raw"), testRunner);
        expect(await res?.text()).toBe("bytes");
    });
});
```

- [ ] **Step 2: Run, confirm FAIL** (module doesn't exist): `/tmp/rt.sh apps/axctl/src/dashboard/router/router.test.ts`

- [ ] **Step 3: Implement** `router/router.ts`:

```ts
/**
 * Tiny typed route table for the dashboard server (Insights Surface).
 *
 * No framework: patterns compile to RegExp, the table is an ordered array,
 * first match wins. Two route kinds:
 *   - jsonRoute: pure param decoder -> Effect handler -> JSON encode, with
 *     optional respond/errorStatus overrides.
 *   - rawRoute: full Request -> Response escape hatch (SSE /api/events,
 *     binary /api/image, POST /api/ingest - the IngestStreamBus seam).
 *
 * The Effect runner is injectable so router/route unit tests never build
 * AppLayer (and therefore never touch SurrealDB).
 */
import { Effect, type Layer } from "effect";
import { AppLayer } from "@ax/lib/layers";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Everything AppLayer provides; the upper bound for jsonRoute handler envs. */
export type DashboardEnv = Layer.Success<typeof AppLayer>;

/** Runs a handler effect to a Promise. Production = appLayerRunner. */
export type EffectRunner = <A>(
    effect: Effect.Effect<A, unknown, DashboardEnv>,
) => Promise<A>;

/**
 * The ONE place the per-request AppLayer provide + error-channel cast lives
 * (it replaces ~30 scattered `as Effect.Effect<unknown>` casts in the old
 * if-chain). runPromise rejects on any typed failure; the route runner's
 * catch maps it to an HTTP status.
 */
export const appLayerRunner: EffectRunner = <A>(
    effect: Effect.Effect<A, unknown, DashboardEnv>,
): Promise<A> =>
    Effect.runPromise(
        effect.pipe(Effect.provide(AppLayer), Effect.scoped) as Effect.Effect<A>,
    );

export function jsonResponse(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
    });
}

// ---------------------------------------------------------------- decoding

export type BodyResult =
    | { readonly kind: "none" }
    | { readonly kind: "invalid" }
    | { readonly kind: "json"; readonly value: unknown };

export interface RouteInput {
    readonly req: Request;
    readonly url: URL;
    /** Captured path params, already decodeURIComponent-ed. */
    readonly path: Readonly<Record<string, string>>;
    readonly body: BodyResult;
}

export type Decoded<P> =
    | { readonly ok: true; readonly value: P }
    | { readonly ok: false; readonly status: number; readonly body: unknown };

export const decodeOk = <P>(value: P): Decoded<P> => ({ ok: true, value });
export const decodeFail = (error: string, status = 400): Decoded<never> =>
    ({ ok: false, status, body: { error } });
/** For routes whose error body has extra fields (e.g. graph-explorer gate). */
export const decodeFailWith = (body: unknown, status: number): Decoded<never> =>
    ({ ok: false, status, body });

// ---------------------------------------------------------------- patterns

export interface CompiledPattern {
    readonly regex: RegExp;
    readonly keys: ReadonlyArray<string>;
}

const PARAM_SEGMENT = /^:([A-Za-z_][A-Za-z0-9_]*)(\+)?$/;
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `:name` matches one segment (`([^/]+)`); `:name+` is greedy across
 * slashes (`(.+)`) - exact parity with the legacy `(.+)` regexes so ids
 * that URL-encode slashes keep working identically.
 */
export function compilePattern(path: string): CompiledPattern {
    const keys: string[] = [];
    const parts = path.split("/").map((part) => {
        const m = part.match(PARAM_SEGMENT);
        if (!m) return escapeRegExp(part);
        keys.push(m[1] ?? "");
        return m[2] === "+" ? "(.+)" : "([^/]+)";
    });
    return { regex: new RegExp(`^${parts.join("/")}$`), keys };
}

// ---------------------------------------------------------------- routes

export interface JsonRouteDef<P, A> {
    /** "ANY" answers every method (legacy /api/version behavior). */
    readonly method: Method | ReadonlyArray<Method> | "ANY";
    readonly path: string;
    /** Set true to have dispatch read+parse the JSON body before decode. */
    readonly readsBody?: boolean;
    readonly decode: (input: RouteInput) => Decoded<P>;
    readonly handler: (params: P) => Effect.Effect<A, unknown, DashboardEnv>;
    /** Override the default `jsonResponse(value)` encoding. */
    readonly respond?: (value: A) => Response;
    /** Map a handler failure to an HTTP status (default 500). */
    readonly errorStatus?: (err: unknown) => number;
}

export interface RawRouteDef {
    readonly method: Method | ReadonlyArray<Method> | "ANY";
    readonly path: string;
    readonly handler: (input: RouteInput) => Response | Promise<Response>;
}

/** Existentially-typed route: P/A are closed over at construction. */
export interface AnyRoute {
    /** Empty array = ANY method. */
    readonly methods: ReadonlyArray<Method>;
    readonly pattern: CompiledPattern;
    readonly readsBody: boolean;
    readonly run: (input: RouteInput, runner: EffectRunner) => Promise<Response>;
}

const toMethods = (m: Method | ReadonlyArray<Method> | "ANY"): ReadonlyArray<Method> =>
    m === "ANY" ? [] : Array.isArray(m) ? m : [m as Method];

export const jsonRoute = <P, A>(def: JsonRouteDef<P, A>): AnyRoute => ({
    methods: toMethods(def.method),
    pattern: compilePattern(def.path),
    readsBody: def.readsBody === true,
    run: async (input, runner) => {
        const decoded = def.decode(input);
        if (!decoded.ok) return jsonResponse(decoded.body, decoded.status);
        try {
            const value = await runner(def.handler(decoded.value));
            return def.respond ? def.respond(value) : jsonResponse(value);
        } catch (err) {
            return jsonResponse(
                { error: err instanceof Error ? err.message : String(err) },
                def.errorStatus?.(err) ?? 500,
            );
        }
    },
});

export const rawRoute = (def: RawRouteDef): AnyRoute => ({
    methods: toMethods(def.method),
    pattern: compilePattern(def.path),
    readsBody: false,
    run: (input, _runner) => Promise.resolve(def.handler(input)),
});

// ---------------------------------------------------------------- dispatch

export type MatchOutcome =
    | { readonly kind: "matched"; readonly match: { readonly route: AnyRoute; readonly path: Record<string, string> } }
    | { readonly kind: "method_mismatch" }
    | { readonly kind: "unmatched" };

export function matchRoute(
    table: ReadonlyArray<AnyRoute>,
    method: string,
    pathname: string,
): MatchOutcome {
    let sawPathMatch = false;
    for (const route of table) {
        const m = pathname.match(route.pattern.regex);
        if (!m) continue;
        if (route.methods.length > 0 && !route.methods.includes(method as Method)) {
            sawPathMatch = true;
            continue;
        }
        const path: Record<string, string> = {};
        route.pattern.keys.forEach((key, i) => {
            path[key] = decodeURIComponent(m[i + 1] ?? "");
        });
        return { kind: "matched", match: { route, path } };
    }
    return sawPathMatch ? { kind: "method_mismatch" } : { kind: "unmatched" };
}

/**
 * Returns a Response when a table route handled the request, or null so the
 * caller can fall through (during migration: to the legacy if-chain; after:
 * to the /api not_found quirk, the root landing, and the final 404).
 */
export async function dispatch(
    table: ReadonlyArray<AnyRoute>,
    req: Request,
    url: URL,
    runner: EffectRunner = appLayerRunner,
): Promise<Response | null> {
    const outcome = matchRoute(table, req.method, url.pathname);
    if (outcome.kind === "method_mismatch") {
        return jsonResponse({ error: "method_not_allowed" }, 405);
    }
    if (outcome.kind !== "matched") return null;
    const { route, path } = outcome.match;
    const body: BodyResult = route.readsBody
        ? await req.json()
            .then((value): BodyResult => ({ kind: "json", value }))
            .catch((): BodyResult => ({ kind: "invalid" }))
        : { kind: "none" };
    return route.run({ req, url, path, body }, runner);
}
```

- [ ] **Step 4: Run, confirm PASS**: `/tmp/rt.sh apps/axctl/src/dashboard/router/router.test.ts`
- [ ] **Step 5: Typecheck**: `bun run typecheck 2>&1 | rg "dashboard/router"` → empty
- [ ] **Step 6: Commit**:

```
feat(dashboard): tiny typed router core for the route-table refactor

Pattern compile (:name / :name+ parity with legacy regexes), ordered
first-match dispatch, 405 on matched-path-wrong-method, jsonRoute/rawRoute
constructors with an injectable EffectRunner so unit tests never build
AppLayer. Not wired into server.ts yet.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Task 2: Schema-backed param helpers

**Files:**
- Create: `apps/axctl/src/dashboard/router/params.ts`
- Create: `apps/axctl/src/dashboard/router/params.test.ts`

- [ ] **Step 1: Write the failing test** `router/params.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { csvParam, numberParam, optionalNumberParam } from "./params.ts";

const url = (qs: string): URL => new URL(`http://h/api/x${qs}`);

describe("numberParam", () => {
    test("parses finite numbers", () => {
        expect(numberParam(url("?limit=25"), "limit", 50)).toBe(25);
    });
    test("missing → fallback", () => {
        expect(numberParam(url(""), "limit", 50)).toBe(50);
    });
    test("garbage → fallback (legacy Number.isFinite guard semantics)", () => {
        expect(numberParam(url("?limit=abc"), "limit", 50)).toBe(50);
    });
});

describe("optionalNumberParam", () => {
    test("present + finite → number", () => {
        expect(optionalNumberParam(url("?minCount=3"), "minCount")).toBe(3);
    });
    test("missing → undefined", () => {
        expect(optionalNumberParam(url(""), "minCount")).toBeUndefined();
    });
    test("garbage → undefined", () => {
        expect(optionalNumberParam(url("?minCount=x"), "minCount")).toBeUndefined();
    });
});

describe("csvParam", () => {
    test("splits, trims, drops empties (sessions/compare ids semantics)", () => {
        expect(csvParam(url("?ids=a,%20b%20,,c"), "ids")).toEqual(["a", "b", "c"]);
    });
    test("missing → empty array", () => {
        expect(csvParam(url(""), "ids")).toEqual([]);
    });
});
```

- [ ] **Step 2: Run, confirm FAIL**: `/tmp/rt.sh apps/axctl/src/dashboard/router/params.test.ts`
- [ ] **Step 3: Implement** `router/params.ts`:

```ts
/**
 * Query-param decode helpers backed by Effect Schema, per the repo norm in
 * docs/effect-json-boundaries.md / packages/lib/src/decode.ts. The helpers
 * preserve the if-chain's lenient semantics: a missing or non-finite numeric
 * param silently falls back instead of producing a 400.
 */
import { Option, Schema } from "effect";

const finiteFromString = Schema.decodeUnknownOption(Schema.FiniteFromString);

/** Numeric query param with fallback (legacy `Number.isFinite(x) ? x : d`). */
export const numberParam = (url: URL, name: string, fallback: number): number => {
    const raw = url.searchParams.get(name);
    if (raw === null) return fallback;
    return Option.getOrElse(finiteFromString(raw), () => fallback);
};

/** Numeric query param; undefined when absent or non-finite. */
export const optionalNumberParam = (url: URL, name: string): number | undefined => {
    const raw = url.searchParams.get(name);
    if (raw === null) return undefined;
    return Option.getOrUndefined(finiteFromString(raw));
};

/** Comma-separated values: split, trim, drop empties. */
export const csvParam = (url: URL, name: string): ReadonlyArray<string> =>
    (url.searchParams.get(name) ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
```

- [ ] **Step 4: Run, confirm PASS**; typecheck filter empty.
- [ ] **Step 5: Commit**:

```
feat(dashboard): Schema-backed query param helpers for the route table

numberParam/optionalNumberParam wrap Schema.FiniteFromString with the
if-chain's lenient fallback semantics; csvParam reproduces the
sessions/compare ids split. Pure, unit-tested.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Task 3: Install dispatcher + migrate the system family

Routes #1-6: `/api/version`, `POST /api/query`, and the four `queryApi` endpoints (`/api/graph-health`, `/api/worktrees`, `/api/self-improve`, `/api/improve`).

**Files:**
- Create: `apps/axctl/src/dashboard/capabilities.ts` (move server.ts lines 426-463 verbatim: `API_VERSION`, `isGraphExplorerEnabled`, `baseApiCapabilities`, `dashboardApiCapabilities`, with their doc comments; export `API_VERSION` too)
- Create: `apps/axctl/src/dashboard/router/routes/system.ts` + `system.test.ts`
- Create: `apps/axctl/src/dashboard/router/table.ts`
- Modify: `apps/axctl/src/dashboard/server.ts` (wire dispatch; delete lines 536-556 version+query branches, 106-114 `parseQueryRequest`, 130-136 `dashboardApiKind`, 145-187 `queryApi`, 426-463 moved block; change line 1074 catch-all to `jsonResponse({ error: "not_found" })`)
- Modify: `apps/axctl/src/dashboard/server.test.ts` (import `isGraphExplorerEnabled`/`dashboardApiCapabilities` from `./capabilities.ts`; replace `parseQueryRequest` + `dashboardApiKind` tests with `system.test.ts` equivalents - see Step 1)

- [ ] **Step 1: Write the failing tests** `router/routes/system.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { decodeQueryParams } from "./system.ts";
import type { RouteInput } from "../router.ts";

const input = (body: RouteInput["body"]): RouteInput => ({
    req: new Request("http://h/api/query", { method: "POST" }),
    url: new URL("http://h/api/query"),
    path: {},
    body,
});

describe("decodeQueryParams (POST /api/query)", () => {
    test("accepts SELECT", () => {
        const d = decodeQueryParams(input({ kind: "json", value: { sql: " SELECT * FROM session; " } }));
        expect(d).toEqual({ ok: true, value: { sql: "SELECT * FROM session;" } });
    });
    test("rejects mutations with the legacy message", () => {
        const d = decodeQueryParams(input({ kind: "json", value: { sql: "DELETE session;" } }));
        expect(d).toMatchObject({ ok: false, status: 400, body: { error: "Only SELECT, RETURN, and INFO queries are allowed" } });
    });
    test("rejects missing sql with the legacy message", () => {
        const d = decodeQueryParams(input({ kind: "json", value: {} }));
        expect(d).toMatchObject({ ok: false, status: 400, body: { error: "SQL is required" } });
    });
    test("rejects invalid JSON bodies", () => {
        const d = decodeQueryParams(input({ kind: "invalid" }));
        expect(d).toMatchObject({ ok: false, status: 400, body: { error: "invalid_json" } });
    });
});
```

Also add to `server.test.ts` (request-level, no DB - version handler only imports `cli/version.ts`):

```ts
test("GET /api/version is served by the route table", async () => {
    const res = await handleDashboardRequest(new Request("http://127.0.0.1:1738/api/version"));
    expect(res.status).toBe(200);
    const body = await res.json() as { api_version: number; capabilities: string[] };
    expect(body.api_version).toBe(1);
    expect(body.capabilities).toContain("sessions");
});

test("unknown /api/* path preserves the legacy 200 not_found quirk", async () => {
    const res = await handleDashboardRequest(new Request("http://127.0.0.1:1738/api/definitely-not-a-route"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ error: "not_found" });
});
```

- [ ] **Step 2: Run, confirm FAIL** (system.ts missing; version test fails only after the old branch is deleted - fine, write everything then go green).

- [ ] **Step 3: Implement** `router/routes/system.ts`:

```ts
/**
 * System family: version/capability metadata, the read-only SQL console,
 * and the four legacy queryApi endpoints (raw-row responses kept loosely
 * typed exactly as before - typing them is future work, not this phase).
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { graphHealthSql } from "../../../queries/graph-health.ts";
import { checkoutActivitySql, gitCorrelationSql } from "../../../queries/insights.ts";
import { API_VERSION, dashboardApiCapabilities } from "../../capabilities.ts";
import {
    decodeFail,
    decodeOk,
    jsonRoute,
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
    jsonRoute({
        method: "ANY", // legacy: /api/version answered every method; studio probes it
        path: "/api/version",
        decode: () => decodeOk(undefined),
        handler: () => Effect.promise(async () => {
            const { AX_VERSION } = await import("../../../cli/version.ts");
            return {
                version: AX_VERSION,
                api_version: API_VERSION,
                capabilities: dashboardApiCapabilities(),
            };
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
        method: "GET",
        path: "/api/graph-health",
        decode: () => decodeOk(undefined),
        handler: () => Effect.gen(function* () {
            const db = yield* SurrealClient;
            return yield* db.query(graphHealthSql(25));
        }),
    }),
    jsonRoute({
        method: "GET",
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
        method: "GET",
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
        method: "GET",
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
```

`router/table.ts`:

```ts
/**
 * The ordered dashboard route table. FIRST MATCH WINS - keep static paths
 * before param paths within a family, and keep the sessions detail
 * catch-all (`/api/sessions/:id+`) after its sibling subroutes.
 */
import type { AnyRoute } from "./router.ts";
import { systemRoutes } from "./routes/system.ts";

export const routeTable: ReadonlyArray<AnyRoute> = [
    ...systemRoutes,
];
```

- [ ] **Step 4: Wire into `server.ts`.** At the top of `handleDashboardRequest`, before the if-chain:

```ts
export async function handleDashboardRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const routed = await dispatch(routeTable, req, url);
    if (routed !== null) return routed;
    // ... legacy if-chain continues below, shrinking task by task ...
```

with imports `import { dispatch, jsonResponse } from "./router/router.ts";` and `import { routeTable } from "./router/table.ts";`. Delete the migrated branches and helpers listed in **Files**; replace line 1074's `if (url.pathname.startsWith("/api/")) return queryApi(url.pathname);` with `if (url.pathname.startsWith("/api/")) return jsonResponse({ error: "not_found" });` (same wire behavior, no pointless DB roundtrip). Keep the local `async function jsonResponse` deleted in favor of the router's sync one (all call sites: `await`-free is fine since the function was only ever awaited).
- [ ] **Step 5: Update `server.test.ts`**: import `isGraphExplorerEnabled` + `dashboardApiCapabilities` from `./capabilities.ts`; delete the `parseQueryRequest` and `dashboardApiKind` tests (replaced by `system.test.ts`); add the two request-level tests from Step 1.
- [ ] **Step 6: Run, confirm PASS**: `/tmp/rt.sh apps/axctl/src/dashboard` (router, params, system, server tests all green). Typecheck filter empty.
- [ ] **Step 7: Commit** (files: `capabilities.ts`, `router/routes/system.ts`, `router/routes/system.test.ts`, `router/table.ts`, `server.ts`, `server.test.ts`):

```
refactor(dashboard): install route-table dispatch + migrate system family

/api/version, POST /api/query, and the four legacy queryApi endpoints
(graph-health, worktrees, self-improve, improve) become table routes;
capabilities metadata moves to capabilities.ts; queryApi, parseQueryRequest
and dashboardApiKind die. Unknown /api/* keeps the legacy 200 not_found
quirk, now without a DB roundtrip.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Task 4: Migrate the insights family

Routes #8-9, #13-15, #22-26: episodes, graph-explorer, skill-graph, recall, projects, wrapped, wrapped/public-preview, workflow, tool-failures, tool-failures detail.

**Files:**
- Create: `apps/axctl/src/dashboard/router/routes/insights.ts` + `insights.test.ts`
- Modify: `apps/axctl/src/dashboard/recall.ts` (rename internal `EMPTY_RESPONSE` to exported `emptyRecallResponse` - removes the duplicated empty-payload literal in server.ts lines 742-751)
- Modify: `apps/axctl/src/dashboard/router/table.ts` (append `...insightRoutes`)
- Modify: `apps/axctl/src/dashboard/server.ts` (delete lines 605-655, 708-792, 916-1001)

- [ ] **Step 1: Write the failing decode tests** `router/routes/insights.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { decodeGraphExplorerParams, decodeRecallParams, decodeSkillGraphParams } from "./insights.ts";
import type { RouteInput } from "../router.ts";

const input = (urlStr: string, path: Record<string, string> = {}): RouteInput => ({
    req: new Request(urlStr),
    url: new URL(urlStr),
    path,
    body: { kind: "none" },
});

describe("decodeRecallParams", () => {
    test("defaults: offset 0, limit 50, null filters", () => {
        const d = decodeRecallParams(input("http://h/api/recall?q=hello"));
        expect(d).toEqual({
            ok: true,
            value: { q: "hello", project: null, skill: null, since: null, offset: 0, limit: 50 },
        });
    });
    test("missing q decodes to empty string (handler short-circuits)", () => {
        const d = decodeRecallParams(input("http://h/api/recall"));
        if (d.ok) expect(d.value.q).toBe("");
        expect(d.ok).toBe(true);
    });
});

describe("decodeSkillGraphParams", () => {
    test("finite minCount/limit pass through; garbage dropped", () => {
        const d = decodeSkillGraphParams(input("http://h/api/skill-graph?minCount=2&limit=abc"));
        expect(d).toEqual({ ok: true, value: { minCount: 2 } });
    });
});

describe("decodeGraphExplorerParams", () => {
    test("disabled env → 404 with the legacy error body", () => {
        const d = decodeGraphExplorerParams(input("http://h/api/graph-explorer"), {});
        expect(d).toMatchObject({ ok: false, status: 404, body: { error: "graph_explorer_disabled" } });
    });
    test("enabled env decodes mode/q/limit", () => {
        const d = decodeGraphExplorerParams(
            input("http://h/api/graph-explorer?mode=skills&q=x&limit=5"),
            { AX_ENABLE_GRAPH_EXPLORER: "1" },
        );
        expect(d).toEqual({ ok: true, value: { mode: "skills", q: "x", limit: 5 } });
    });
});
```

- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement** `router/routes/insights.ts`. Decoders are pure exported functions; route declarations point at the existing fetch modules:

```ts
import { Effect } from "effect";
import type { RecallParams } from "../../recall.ts";
import { emptyRecallResponse, fetchRecall } from "../../recall.ts";
import { fetchEpisodeTimeline } from "../../episode-timeline.ts";
import { fetchProject } from "../../project.ts";
import { fetchGraphExplorer, type GraphExplorerParams } from "../../graph-explorer.ts";
import { fetchSkillGraph, type SkillGraphParams } from "../../skill-graph.ts";
import { fetchToolFailureDetail, fetchToolFailures } from "../../tool-failures.ts";
import { fetchWorkflow } from "../../workflow.ts";
import { fetchWrapped, sanitizeWrappedProfile } from "../../wrapped.ts";
import { isGraphExplorerEnabled } from "../../capabilities.ts";
import { numberParam, optionalNumberParam } from "../params.ts";
import {
    decodeFail,
    decodeFailWith,
    decodeOk,
    jsonResponse,
    jsonRoute,
    type AnyRoute,
    type Decoded,
    type RouteInput,
} from "../router.ts";

export const decodeRecallParams = ({ url }: RouteInput): Decoded<RecallParams> =>
    decodeOk({
        q: url.searchParams.get("q") ?? "",
        project: url.searchParams.get("project"),
        skill: url.searchParams.get("skill"),
        since: url.searchParams.get("since"),
        offset: numberParam(url, "offset", 0),
        limit: numberParam(url, "limit", 50),
    });

export const decodeSkillGraphParams = ({ url }: RouteInput): Decoded<SkillGraphParams> => {
    const minCount = optionalNumberParam(url, "minCount");
    const limit = optionalNumberParam(url, "limit");
    return decodeOk({
        ...(minCount === undefined ? {} : { minCount }),
        ...(limit === undefined ? {} : { limit }),
    });
};

export const decodeGraphExplorerParams = (
    { url }: RouteInput,
    env: Record<string, string | undefined> = process.env,
): Decoded<GraphExplorerParams> => {
    if (!isGraphExplorerEnabled(env)) {
        return decodeFailWith({
            error: "graph_explorer_disabled",
            message: "Graph explorer is disabled. Set AX_ENABLE_GRAPH_EXPLORER=1 to enable this experimental endpoint.",
        }, 404);
    }
    const mode = url.searchParams.get("mode");
    const q = url.searchParams.get("q");
    const limit = optionalNumberParam(url, "limit");
    return decodeOk({
        ...(mode === null ? {} : { mode }),
        ...(q === null ? {} : { q }),
        ...(limit === undefined ? {} : { limit }),
    });
};

const requiredPath = (path: Readonly<Record<string, string>>, key: string, missing: string): Decoded<string> => {
    const value = path[key] ?? "";
    return value ? decodeOk(value) : decodeFail(missing, 400);
};

export const insightRoutes: ReadonlyArray<AnyRoute> = [
    jsonRoute({
        method: "GET",
        path: "/api/episodes/:parentId+",
        decode: ({ path }) => requiredPath(path, "parentId", "missing parent id"),
        handler: (parentId) => fetchEpisodeTimeline(parentId),
    }),
    jsonRoute({
        method: "GET",
        path: "/api/graph-explorer",
        decode: (input) => decodeGraphExplorerParams(input),
        handler: (params) => fetchGraphExplorer(params),
    }),
    jsonRoute({
        method: "GET",
        path: "/api/skill-graph",
        decode: decodeSkillGraphParams,
        handler: (params) => fetchSkillGraph(params),
    }),
    jsonRoute({
        method: "GET",
        path: "/api/recall",
        decode: decodeRecallParams,
        handler: (p) => p.q.trim().length === 0
            ? Effect.succeed(emptyRecallResponse(p.q, p.offset ?? 0, p.limit ?? 50))
            : fetchRecall(p),
    }),
    jsonRoute({
        method: "GET",
        path: "/api/projects/:project+",
        decode: ({ path }) => requiredPath(path, "project", "missing project"),
        handler: (project) => fetchProject(project),
        respond: (payload) => payload === null
            ? jsonResponse({ error: "project not found" }, 404)
            : jsonResponse(payload),
    }),
    jsonRoute({
        method: "GET",
        path: "/api/wrapped",
        decode: () => decodeOk(undefined),
        handler: () => fetchWrapped(),
    }),
    jsonRoute({
        method: "GET",
        path: "/api/wrapped/public-preview",
        decode: () => decodeOk(undefined),
        handler: () => fetchWrapped().pipe(Effect.map(sanitizeWrappedProfile)),
    }),
    jsonRoute({
        method: "GET",
        path: "/api/workflow",
        decode: () => decodeOk(undefined),
        handler: () => fetchWorkflow(),
    }),
    jsonRoute({
        method: "GET",
        path: "/api/tool-failures",
        decode: () => decodeOk(undefined),
        handler: () => fetchToolFailures(),
    }),
    jsonRoute({
        method: "GET", // tightened from ANY (behavioral delta 2)
        path: "/api/tool-failures/:label+/detail",
        decode: ({ path }) => requiredPath(path, "label", "missing label"),
        handler: (label) => fetchToolFailureDetail(label),
    }),
];
```

In `recall.ts`, rename `EMPTY_RESPONSE` → `export const emptyRecallResponse` (same signature `(q: string, offset: number, limit: number): RecallResponse`) and update its internal call site.
- [ ] **Step 4: Append to table**, delete the migrated if-chain branches (server.ts lines 605-655, 708-792, 916-1001).
- [ ] **Step 5: Run** `/tmp/rt.sh apps/axctl/src/dashboard` - including the pre-existing `graph-explorer endpoint returns 404 by default` request-level test in `server.test.ts`, which now exercises the table path and must stay green with the identical body. Typecheck filter empty.
- [ ] **Step 6: Commit** (files: `router/routes/insights.ts`, `router/routes/insights.test.ts`, `router/table.ts`, `recall.ts`, `server.ts`):

```
refactor(dashboard): migrate insights family to the route table

episodes, graph-explorer, skill-graph, recall, projects, wrapped(+preview),
workflow, tool-failures(+detail) become declarations; recall's empty-query
payload is exported from recall.ts instead of duplicated; read-only detail
route tightened to GET.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Task 5: Migrate the sessions family

Routes #10-12, #16-21: sessions list, compare, children, inspect, timeline, detail, session-summary, session-orchestration, session-canvas.

**Files:**
- Create: `apps/axctl/src/dashboard/router/routes/sessions.ts` + `sessions.test.ts`
- Modify: `apps/axctl/src/dashboard/router/table.ts` (append `...sessionRoutes` AFTER insights - order within the family matters, see declarations)
- Modify: `apps/axctl/src/dashboard/server.ts` (delete lines 656-707, 793-915)

- [ ] **Step 1: Write the failing decode tests** `router/routes/sessions.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
    decodeCompareParams,
    decodeInspectParams,
    decodeSessionsListParams,
} from "./sessions.ts";
import type { RouteInput } from "../router.ts";

const input = (urlStr: string, path: Record<string, string> = {}): RouteInput => ({
    req: new Request(urlStr),
    url: new URL(urlStr),
    path,
    body: { kind: "none" },
});

describe("decodeSessionsListParams", () => {
    test("defaults offset=0 limit=200, omits absent filters", () => {
        expect(decodeSessionsListParams(input("http://h/api/sessions"))).toEqual({
            ok: true,
            value: { offset: 0, limit: 200 },
        });
    });
    test("carries source/project when present", () => {
        const d = decodeSessionsListParams(input("http://h/api/sessions?source=claude&project=ax&offset=10"));
        expect(d).toEqual({ ok: true, value: { offset: 10, limit: 200, source: "claude", project: "ax" } });
    });
});

describe("decodeCompareParams (the inline csv split, now pure + tested)", () => {
    test("splits ids, trims, requires >= 2", () => {
        const d = decodeCompareParams(input("http://h/api/sessions/compare?ids=a,%20b&turns=1"));
        expect(d).toEqual({ ok: true, value: { ids: ["a", "b"], includeTurns: true } });
    });
    test("fewer than 2 ids → legacy 400 message", () => {
        const d = decodeCompareParams(input("http://h/api/sessions/compare?ids=a"));
        expect(d).toMatchObject({ ok: false, status: 400, body: { error: "need at least 2 session ids (ids=a,b)" } });
    });
});

describe("decodeInspectParams", () => {
    test("pagination defaults turn_offset=0 turn_limit=100", () => {
        const d = decodeInspectParams(input("http://h/api/sessions/s1/inspect", { id: "s1" }));
        expect(d).toEqual({ ok: true, value: { id: "s1", turnOffset: 0, turnLimit: 100 } });
    });
    test("missing id → 400", () => {
        const d = decodeInspectParams(input("http://h/api/sessions//inspect", { id: "" }));
        expect(d).toMatchObject({ ok: false, status: 400 });
    });
});
```

- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement** `router/routes/sessions.ts`:

```ts
import { Effect } from "effect";
import { extractSessionTimeline, SessionTimelineServiceLayer } from "../../../timeline/service.ts";
import { fetchSessionCanvas, fetchSessionOrchestration } from "../../session-canvas.ts";
import { fetchSessionCompare } from "../../session-compare.ts";
import { fetchSessionDetail } from "../../session-detail.ts";
import { fetchSessionInspect } from "../../session-inspect.ts";
import { fetchSessionSummary } from "../../session-summary.ts";
import { fetchSessionChildren, fetchSessionsList, type SessionsListOpts } from "../../sessions-list.ts";
import { csvParam, numberParam, optionalNumberParam } from "../params.ts";
import {
    decodeFail,
    decodeOk,
    jsonRoute,
    type AnyRoute,
    type Decoded,
    type RouteInput,
} from "../router.ts";

/** Legacy 404 mapping for inspect/timeline: TranscriptNotFoundError et al. */
const notFoundStatus = (err: unknown): number =>
    err instanceof Error && /not found/i.test(err.message) ? 404 : 500;

export const decodeSessionsListParams = ({ url }: RouteInput): Decoded<SessionsListOpts> => {
    const source = url.searchParams.get("source") ?? undefined;
    const project = url.searchParams.get("project") ?? undefined;
    return decodeOk({
        offset: numberParam(url, "offset", 0),
        limit: numberParam(url, "limit", 200),
        ...(source ? { source } : {}),
        ...(project ? { project } : {}),
    });
};

export interface CompareParams {
    readonly ids: ReadonlyArray<string>;
    readonly includeTurns: boolean;
}

export const decodeCompareParams = ({ url }: RouteInput): Decoded<CompareParams> => {
    const ids = csvParam(url, "ids");
    if (ids.length < 2) return decodeFail("need at least 2 session ids (ids=a,b)", 400);
    return decodeOk({ ids, includeTurns: url.searchParams.get("turns") === "1" });
};

export interface InspectParams {
    readonly id: string;
    readonly turnOffset: number;
    readonly turnLimit: number;
}

export const decodeInspectParams = ({ url, path }: RouteInput): Decoded<InspectParams> => {
    const id = path.id ?? "";
    if (!id) return decodeFail("missing session id", 400);
    return decodeOk({
        id,
        turnOffset: numberParam(url, "turn_offset", 0),
        turnLimit: numberParam(url, "turn_limit", 100),
    });
};

const requiredSessionId = ({ path }: RouteInput): Decoded<string> => {
    const id = path.id ?? "";
    return id ? decodeOk(id) : decodeFail("missing session id", 400);
};

const requiredQueryId = ({ url }: RouteInput): Decoded<string> => {
    const id = url.searchParams.get("id");
    return id ? decodeOk(id) : decodeFail("missing id", 400);
};

export const sessionRoutes: ReadonlyArray<AnyRoute> = [
    jsonRoute({
        method: "GET",
        path: "/api/session-canvas",
        decode: ({ url }) => {
            const limit = optionalNumberParam(url, "limit");
            return decodeOk(limit === undefined ? {} : { limit });
        },
        handler: (params) => fetchSessionCanvas(params),
    }),
    jsonRoute({
        method: "GET",
        path: "/api/session-summary",
        decode: requiredQueryId,
        handler: (id) => fetchSessionSummary(id),
    }),
    jsonRoute({
        method: "GET",
        path: "/api/session-orchestration",
        decode: requiredQueryId,
        handler: (id) => fetchSessionOrchestration(id),
    }),
    jsonRoute({
        method: "GET",
        path: "/api/sessions",
        decode: decodeSessionsListParams,
        handler: (opts) => fetchSessionsList(opts),
    }),
    // Static before param routes: compare must precede every /api/sessions/:id+ route.
    jsonRoute({
        method: "GET",
        path: "/api/sessions/compare",
        decode: decodeCompareParams,
        handler: ({ ids, includeTurns }) => fetchSessionCompare(ids, { includeTurns }),
    }),
    jsonRoute({
        method: "GET",
        path: "/api/sessions/:id+/children",
        decode: (input) => {
            const id = requiredSessionId(input);
            if (!id.ok) return id;
            return decodeOk({ id: id.value, limit: numberParam(input.url, "limit", 500) });
        },
        handler: ({ id, limit }) => fetchSessionChildren(id, { limit }),
    }),
    jsonRoute({
        method: "GET",
        path: "/api/sessions/:id+/inspect",
        decode: decodeInspectParams,
        handler: ({ id, turnOffset, turnLimit }) => fetchSessionInspect(id, { turnOffset, turnLimit }),
        errorStatus: notFoundStatus,
    }),
    jsonRoute({
        method: "GET",
        path: "/api/sessions/:id+/timeline",
        decode: requiredSessionId,
        handler: (id) => extractSessionTimeline(id).pipe(Effect.provide(SessionTimelineServiceLayer)),
        errorStatus: notFoundStatus,
    }),
    // Catch-all LAST within the family.
    jsonRoute({
        method: "GET",
        path: "/api/sessions/:id+",
        decode: requiredSessionId,
        handler: (id) => fetchSessionDetail(id),
    }),
];
```

- [ ] **Step 4: Append `...sessionRoutes` to `table.ts`**; delete server.ts lines 656-707 and 793-915 (the `episodeMatch`-style session branches). Remove now-unused imports (`fetchSessionDetail`, `fetchSessionCompare`, `fetchSessionInspect`, `extractSessionTimeline`, `SessionTimelineServiceLayer`, `fetchSessionChildren`, `fetchSessionsList`, `fetchSessionCanvas`, `fetchSessionOrchestration`, `fetchSessionSummary`) from server.ts.
- [ ] **Step 5: Run** `/tmp/rt.sh apps/axctl/src/dashboard`; typecheck filter empty.
- [ ] **Step 6: Commit** (files: `router/routes/sessions.ts`, `router/routes/sessions.test.ts`, `router/table.ts`, `server.ts`):

```
refactor(dashboard): migrate sessions family to the route table

list/compare/children/inspect/timeline/detail + canvas/summary/orchestration
become declarations; the inline compare csv split and inspect pagination
parsing are now pure, unit-tested decoders; not-found regex mapping is an
explicit errorStatus per route.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Task 6: Migrate the skills family

Routes #27-34: decisions, skills triage, decide-bulk, decide POST/DELETE, detail, source, open.

**Files:**
- Create: `apps/axctl/src/dashboard/router/routes/skills.ts` + `skills.test.ts`
- Modify: `apps/axctl/src/dashboard/router/table.ts` (append `...skillRoutes`)
- Modify: `apps/axctl/src/dashboard/server.ts` (delete lines 238-424 - `handleSkillDecision`, `handleSkillDetail`, `handleSkillSource`, `handleSkillOpen`, `handleSkillBulkDecision` - and the matching branches at 1002-1060)

- [ ] **Step 1: Write the failing decode tests** `router/routes/skills.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
    decodeBulkDecisionParams,
    decodeSkillDecisionParams,
    decodeSkillOpenParams,
} from "./skills.ts";
import type { RouteInput } from "../router.ts";

const input = (body: RouteInput["body"], path: Record<string, string> = { name: "tdd" }): RouteInput => ({
    req: new Request("http://h/api/skills/tdd/decide", { method: "POST" }),
    url: new URL("http://h/api/skills/tdd/decide"),
    path,
    body,
});

describe("decodeSkillDecisionParams", () => {
    test("valid decision + trimmed reason", () => {
        const d = decodeSkillDecisionParams(input({ kind: "json", value: { decision: "archive", reason: "  unused  " } }));
        expect(d).toEqual({ ok: true, value: { name: "tdd", decision: "archive", reason: "unused" } });
    });
    test("non-string / empty reason normalizes to null (legacy leniency)", () => {
        const d = decodeSkillDecisionParams(input({ kind: "json", value: { decision: "keep", reason: 7 } }));
        expect(d).toEqual({ ok: true, value: { name: "tdd", decision: "keep", reason: null } });
    });
    test("bad decision → legacy 400 message", () => {
        const d = decodeSkillDecisionParams(input({ kind: "json", value: { decision: "yolo" } }));
        expect(d).toMatchObject({ ok: false, status: 400, body: { error: "decision must be one of keep|archive|review" } });
    });
    test("invalid JSON → 400 invalid_json", () => {
        expect(decodeSkillDecisionParams(input({ kind: "invalid" }))).toMatchObject({
            ok: false, status: 400, body: { error: "invalid_json" },
        });
    });
});

describe("decodeBulkDecisionParams", () => {
    test("filters non-string names, requires at least one", () => {
        const d = decodeBulkDecisionParams(input({ kind: "json", value: { names: ["a", 3, ""], decision: "review" } }, {}));
        expect(d).toEqual({ ok: true, value: { names: ["a"], decision: "review", reason: null } });
    });
    test("empty names array → legacy 400 message", () => {
        const d = decodeBulkDecisionParams(input({ kind: "json", value: { names: [], decision: "keep" } }, {}));
        expect(d).toMatchObject({ ok: false, status: 400, body: { error: "names must be a non-empty array of skill names" } });
    });
});

describe("decodeSkillOpenParams", () => {
    test("finder/editor accepted via Schema.Literals", () => {
        const d = decodeSkillOpenParams(input({ kind: "json", value: { target: "editor" } }));
        expect(d).toEqual({ ok: true, value: { name: "tdd", target: "editor" } });
    });
    test("anything else → legacy 400 message", () => {
        const d = decodeSkillOpenParams(input({ kind: "json", value: { target: "terminal" } }));
        expect(d).toMatchObject({ ok: false, status: 400, body: { error: "target must be 'finder' or 'editor'" } });
    });
});
```

- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement** `router/routes/skills.ts`:

```ts
import { Effect, Option, Schema } from "effect";
import type { TriageDecision } from "@ax/lib/shared/dashboard-types";
import {
    clearSkillDecision,
    fetchSkillDetail,
    fetchSkillTriage,
    listSkillDecisions,
    setSkillDecision,
    setSkillDecisionsBulk,
} from "../../triage.ts";
import {
    applySkillDecisionToDisk,
    openSkillTarget,
    readSkillSource,
} from "../../skill-source.ts";
import {
    decodeFail,
    decodeOk,
    jsonRoute,
    type AnyRoute,
    type BodyResult,
    type Decoded,
    type RouteInput,
} from "../router.ts";

/** Field-level Schema decode: single source of truth for the triage enum. */
const decodeTriageDecision = Schema.decodeUnknownOption(
    Schema.Literals(["keep", "archive", "review"]),
);
const decodeOpenTarget = Schema.decodeUnknownOption(
    Schema.Literals(["finder", "editor"]),
);

const bodyRecord = (body: BodyResult): Record<string, unknown> | null => {
    if (body.kind !== "json") return null;
    return typeof body.value === "object" && body.value !== null
        ? (body.value as Record<string, unknown>)
        : {};
};

const normalizeReason = (raw: unknown): string | null =>
    typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;

const requiredName = (path: Readonly<Record<string, string>>): Decoded<string> => {
    const name = path.name ?? "";
    return name ? decodeOk(name) : decodeFail("missing skill name", 400);
};

export interface SkillDecisionParams {
    readonly name: string;
    readonly decision: TriageDecision;
    readonly reason: string | null;
}

export const decodeSkillDecisionParams = ({ path, body }: RouteInput): Decoded<SkillDecisionParams> => {
    const name = requiredName(path);
    if (!name.ok) return name;
    const record = bodyRecord(body);
    if (record === null) return decodeFail("invalid_json", 400);
    const decision = Option.getOrNull(decodeTriageDecision(record.decision));
    if (decision === null) return decodeFail("decision must be one of keep|archive|review", 400);
    return decodeOk({ name: name.value, decision, reason: normalizeReason(record.reason) });
};

export interface BulkDecisionParams {
    readonly names: ReadonlyArray<string>;
    readonly decision: TriageDecision;
    readonly reason: string | null;
}

export const decodeBulkDecisionParams = ({ body }: RouteInput): Decoded<BulkDecisionParams> => {
    const record = bodyRecord(body);
    if (record === null) return decodeFail("invalid_json", 400);
    if (!Array.isArray(record.names) || record.names.length === 0) {
        return decodeFail("names must be a non-empty array of skill names", 400);
    }
    const names = record.names.filter((n): n is string => typeof n === "string" && n.length > 0);
    if (names.length === 0) return decodeFail("no valid skill names provided", 400);
    const decision = Option.getOrNull(decodeTriageDecision(record.decision));
    if (decision === null) return decodeFail("decision must be one of keep|archive|review", 400);
    return decodeOk({ names, decision, reason: normalizeReason(record.reason) });
};

export interface SkillOpenParams {
    readonly name: string;
    readonly target: "finder" | "editor";
}

export const decodeSkillOpenParams = ({ path, body }: RouteInput): Decoded<SkillOpenParams> => {
    const name = requiredName(path);
    if (!name.ok) return name;
    const record = bodyRecord(body);
    if (record === null) return decodeFail("invalid_json", 400);
    const target = Option.getOrNull(decodeOpenTarget(record.target));
    if (target === null) return decodeFail("target must be 'finder' or 'editor'", 400);
    return decodeOk({ name: name.value, target });
};

export const skillRoutes: ReadonlyArray<AnyRoute> = [
    jsonRoute({
        method: "GET",
        path: "/api/decisions",
        decode: () => decodeOk(undefined),
        handler: () => listSkillDecisions().pipe(Effect.map((notes) => ({ decisions: notes }))),
    }),
    jsonRoute({
        method: "GET",
        path: "/api/skills",
        decode: () => decodeOk(undefined),
        handler: () => fetchSkillTriage(),
    }),
    // Static before param routes within the family (house rule).
    jsonRoute({
        method: "POST",
        path: "/api/skills/decide-bulk",
        readsBody: true,
        decode: decodeBulkDecisionParams,
        handler: ({ names, decision, reason }) => Effect.gen(function* () {
            const saved = yield* setSkillDecisionsBulk(names, decision, reason);
            // Reflect the decision onto disk for every editable skill.
            for (const skillName of names) {
                yield* applySkillDecisionToDisk(skillName, decision);
            }
            return { notes: saved };
        }),
    }),
    jsonRoute({
        method: "POST",
        path: "/api/skills/:name+/decide",
        readsBody: true,
        decode: decodeSkillDecisionParams,
        handler: ({ name, decision, reason }) => Effect.gen(function* () {
            const saved = yield* setSkillDecision(name, decision, reason);
            // `archive` disables the skill on disk; `keep`/`review` restores it.
            yield* applySkillDecisionToDisk(name, decision);
            return saved;
        }),
    }),
    jsonRoute({
        method: "DELETE",
        path: "/api/skills/:name+/decide",
        decode: ({ path }) => requiredName(path),
        handler: (name) => Effect.gen(function* () {
            yield* clearSkillDecision(name);
            // Clearing a decision restores the skill on disk.
            yield* applySkillDecisionToDisk(name, null);
            return { cleared: true, skill_name: name };
        }),
    }),
    jsonRoute({
        method: "GET", // tightened from ANY (behavioral delta 2)
        path: "/api/skills/:name+/detail",
        decode: ({ path }) => requiredName(path),
        handler: (name) => fetchSkillDetail(name),
    }),
    jsonRoute({
        method: "GET", // tightened from ANY (behavioral delta 2)
        path: "/api/skills/:name+/source",
        decode: ({ path }) => requiredName(path),
        handler: (name) => readSkillSource(name),
    }),
    jsonRoute({
        method: "POST",
        path: "/api/skills/:name+/open",
        readsBody: true,
        decode: decodeSkillOpenParams,
        handler: ({ name, target }) => openSkillTarget(name, target),
    }),
];
```

Note: the decide/bulk/clear handlers are verbatim moves of the Effect.gen bodies from server.ts 242-424 - they stay DB-coupled (they compose `triage.ts` + `skill-source.ts` effects); their decoders are the newly-pure, newly-tested part. That is the intended Phase 3 boundary.
- [ ] **Step 4: Append `...skillRoutes` to `table.ts`**; delete server.ts lines 238-424 and 1002-1060; drop the now-unused `triage.ts`/`skill-source.ts` imports from server.ts. `isTriageDecision` stays exported from `triage.ts` (other call sites may use it) but server.ts no longer imports it.
- [ ] **Step 5: Run** `/tmp/rt.sh apps/axctl/src/dashboard`; typecheck filter empty.
- [ ] **Step 6: Commit** (files: `router/routes/skills.ts`, `router/routes/skills.test.ts`, `router/table.ts`, `server.ts`):

```
refactor(dashboard): migrate skills family to the route table

decide/decide-bulk/open body validation becomes pure Schema.Literals-backed
decoders with unit tests; the disk-reflection Effect compositions move
verbatim into route handlers; detail/source tightened to GET.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Task 7: Migrate the improve-action route

Route #35: `POST /api/improve/:sig/:action`.

**Files:**
- Create: `apps/axctl/src/dashboard/router/routes/improve.ts` + `improve.test.ts`
- Modify: `apps/axctl/src/dashboard/router/table.ts` (append `...improveRoutes` - AFTER systemRoutes so static `/api/improve` wins, though patterns don't actually collide)
- Modify: `apps/axctl/src/dashboard/server.ts` (delete lines 189-236 `handleImproveAction` and branch 1061-1067)

- [ ] **Step 1: Write the failing tests** `router/routes/improve.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { decodeImproveActionParams, improveHttpStatus } from "./improve.ts";
import type { RouteInput } from "../router.ts";

const input = (path: Record<string, string>, body: RouteInput["body"]): RouteInput => ({
    req: new Request("http://h/api/improve/sig1/accept", { method: "POST" }),
    url: new URL("http://h/api/improve/sig1/accept"),
    path,
    body,
});

describe("decodeImproveActionParams", () => {
    test("accept carries force flag", () => {
        const d = decodeImproveActionParams(input({ sig: "s1", action: "accept" }, { kind: "json", value: { force: true } }));
        expect(d).toEqual({ ok: true, value: { sig: "s1", action: "accept", force: true, reason: undefined, verdict: "" } });
    });
    test("invalid JSON body is treated as empty (legacy: empty body ok)", () => {
        const d = decodeImproveActionParams(input({ sig: "s1", action: "verdict" }, { kind: "invalid" }));
        expect(d).toEqual({ ok: true, value: { sig: "s1", action: "verdict", force: false, reason: undefined, verdict: "" } });
    });
    test("unknown action → 404 (behavioral delta 4)", () => {
        const d = decodeImproveActionParams(input({ sig: "s1", action: "explode" }, { kind: "json", value: {} }));
        expect(d).toMatchObject({ ok: false, status: 404, body: { error: "unknown_improve_action" } });
    });
    test("missing sig → legacy 400 message", () => {
        const d = decodeImproveActionParams(input({ sig: "", action: "accept" }, { kind: "json", value: {} }));
        expect(d).toMatchObject({ ok: false, status: 400, body: { error: "missing proposal sig" } });
    });
});

describe("improveHttpStatus (verbatim status map from server.ts 224-228)", () => {
    test("maps every known status", () => {
        expect(improveHttpStatus("ok")).toBe(200);
        expect(improveHttpStatus("not_found")).toBe(404);
        expect(improveHttpStatus("wrong_status")).toBe(409);
        expect(improveHttpStatus("scaffold_exists")).toBe(409);
        expect(improveHttpStatus("verdict_locked")).toBe(409);
        expect(improveHttpStatus("unsupported_form")).toBe(400);
        expect(improveHttpStatus("missing_payload")).toBe(400);
        expect(improveHttpStatus("invalid_verdict")).toBe(400);
        expect(improveHttpStatus("anything_else")).toBe(500);
    });
});
```

- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement** `router/routes/improve.ts`:

```ts
/**
 * POST /api/improve/:sig/:action  (action ∈ accept | reject | verdict)
 * Shared logic lives in src/improve/actions.ts so the CLI and HTTP paths
 * agree on semantics (dynamic import preserved from the legacy handler).
 */
import { Effect, Option, Schema } from "effect";
import {
    decodeFail,
    decodeOk,
    jsonResponse,
    jsonRoute,
    type AnyRoute,
    type Decoded,
    type RouteInput,
} from "../router.ts";

const decodeAction = Schema.decodeUnknownOption(
    Schema.Literals(["accept", "reject", "verdict"]),
);

export interface ImproveActionParams {
    readonly sig: string;
    readonly action: "accept" | "reject" | "verdict";
    readonly force: boolean;
    readonly reason: string | undefined;
    readonly verdict: string;
}

export const decodeImproveActionParams = ({ path, body }: RouteInput): Decoded<ImproveActionParams> => {
    const sig = path.sig ?? "";
    if (!sig) return decodeFail("missing proposal sig", 400);
    const action = Option.getOrNull(decodeAction(path.action));
    if (action === null) return decodeFail("unknown_improve_action", 404);
    // Legacy: an unparseable/absent body is treated as {} (empty body ok).
    const record = body.kind === "json" && typeof body.value === "object" && body.value !== null
        ? (body.value as Record<string, unknown>)
        : {};
    return decodeOk({
        sig,
        action,
        force: record.force === true,
        reason: typeof record.reason === "string" ? record.reason : undefined,
        verdict: typeof record.verdict === "string" ? record.verdict : "",
    });
};

/** Verbatim status→HTTP map from the legacy handleImproveAction. */
export const improveHttpStatus = (status: string): number =>
    status === "ok" ? 200
    : status === "not_found" ? 404
    : status === "wrong_status" || status === "scaffold_exists" || status === "verdict_locked" ? 409
    : status === "unsupported_form" || status === "missing_payload" || status === "invalid_verdict" ? 400
    : 500;

interface ImproveActionResult { readonly status: string; readonly message?: string }

export const improveRoutes: ReadonlyArray<AnyRoute> = [
    jsonRoute({
        method: "POST",
        path: "/api/improve/:sig/:action",
        readsBody: true,
        decode: decodeImproveActionParams,
        handler: (p: ImproveActionParams): Effect.Effect<ImproveActionResult, unknown, never> =>
            Effect.gen(function* () {
                const actions = yield* Effect.promise(() => import("../../../improve/actions.ts"));
                if (p.action === "accept") {
                    return yield* actions.acceptProposal({ sigOrId: p.sig, force: p.force });
                }
                if (p.action === "reject") {
                    return yield* actions.rejectProposal({
                        sigOrId: p.sig,
                        ...(p.reason === undefined ? {} : { reason: p.reason }),
                    });
                }
                return yield* actions.setVerdict({ sigOrId: p.sig, verdict: p.verdict });
            }) as Effect.Effect<ImproveActionResult, unknown, never>,
        respond: (result) => jsonResponse(result, improveHttpStatus(result.status)),
    }),
];
```

(The closing cast mirrors the legacy `as Effect.Effect<{ readonly status: string; readonly message?: string }>` on server.ts line 222 - `improve/actions.ts` exposes wider inferred types - and is the only cast this route needs.)
- [ ] **Step 4: Append `...improveRoutes` to `table.ts`**; delete server.ts lines 189-236 and 1061-1067.
- [ ] **Step 5: Run** `/tmp/rt.sh apps/axctl/src/dashboard`; typecheck filter empty.
- [ ] **Step 6: Commit** (files: `router/routes/improve.ts`, `router/routes/improve.test.ts`, `router/table.ts`, `server.ts`):

```
refactor(dashboard): migrate improve-action route to the route table

:sig/:action path params + lenient body extraction become a pure decoder;
the status→HTTP map is exported and unit-tested; unknown actions now 404
instead of falling into the api catch-all.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Task 8: Raw escape hatches + kill the if-chain

Routes #7, #36, #37 (events SSE, ingest, image) move behind `rawRoute`; the legacy chain is deleted; `handleDashboardRequest` becomes dispatch + three-line epilogue.

**Files:**
- Create: `apps/axctl/src/dashboard/ingest-state.ts` (move `ServeIngestState` interface + module state, server.ts 465-486, replacing the bare `let serveIngestState` with `get`/`set` functions)
- Create: `apps/axctl/src/dashboard/router/routes/live.ts` + `live.test.ts`
- Modify: `apps/axctl/src/dashboard/router/table.ts` (append `...liveRoutes`)
- Modify: `apps/axctl/src/dashboard/server.ts` (delete lines 41-97 image block, 116-128 `formatSseEvent`/`recentIngestEventsSql`, 488-532 `handleIngestTrigger`, 557-604 events branch, 1068-1073 branches; `serveDashboard` now calls `setServeIngestState(...)` from `ingest-state.ts`)
- Modify: `apps/axctl/src/dashboard/server.test.ts` (image/SSE-helper tests move to `live.test.ts`; request-level image tests stay but import nothing new - they go through `handleDashboardRequest` which now table-routes them)

- [ ] **Step 1: Write/move the failing tests.** `router/routes/live.test.ts` takes the `imageContentType`, `formatSseEvent`, and `recentIngestEventsSql` describe-blocks verbatim from `server.test.ts` (lines 52-68, 124-134), importing from `./live.ts`. Add one new test:

```ts
test("POST /api/ingest without a booted server returns 503 ingest_unavailable", async () => {
    // ingest-state is null in tests (serveDashboard never ran)
    const { handleDashboardRequest } = await import("../../server.ts");
    const res = await handleDashboardRequest(
        new Request("http://127.0.0.1:1738/api/ingest", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "ingest_unavailable" });
});
```

The request-level `GET /api/image` tests in `server.test.ts` stay exactly as they are - they are the regression harness proving the raw route is wire-identical.

- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement.**

`ingest-state.ts` (moved verbatim from server.ts 465-486 plus accessors; the doc comment about the LONG-LIVED ManagedRuntime moves with it):

```ts
import type { Layer, ManagedRuntime } from "effect";
import type { IngestRuntimeLayer } from "../ingest/stage/runtime.ts";
import type { DurableIngestStream } from "./ingest-stream-durable.ts";

export interface ServeIngestState {
    readonly stream: DurableIngestStream | null;
    readonly runtime: ManagedRuntime.ManagedRuntime<
        Layer.Success<typeof IngestRuntimeLayer>,
        Layer.Error<typeof IngestRuntimeLayer>
    >;
}

let state: ServeIngestState | null = null;

export const setServeIngestState = (next: ServeIngestState | null): void => {
    state = next;
};
export const getServeIngestState = (): ServeIngestState | null => state;
```

`router/routes/live.ts` skeleton (bodies are verbatim moves - the ONLY changes are `serveIngestState` → `getServeIngestState()` and wrapping each in `rawRoute`):

```ts
/**
 * Raw escape hatches: routes that cannot be jsonRoutes.
 *   - GET /api/events: long-lived SSE stream (ReadableStream response).
 *   - GET /api/image: binary body + cache headers, allowlisted extensions.
 *   - POST /api/ingest: forks runIngest onto the server's long-lived
 *     ManagedRuntime via the IngestStreamBus/Durable Streams seam.
 *     DO NOT restructure the workflow here (ADR-0007/0008).
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { AppLayer } from "@ax/lib/layers";
import { IngestRuntimeLayer } from "../../../ingest/stage/runtime.ts";
import { getServeIngestState } from "../../ingest-state.ts";
import { ingestStreamName } from "../../ingest-stream.ts";
import { startIngestWorkflow } from "../../ingest-workflow.ts";
import { addIngestEventSubscriber, removeIngestEventSubscriber } from "../../telemetry.ts";
import { jsonResponse, rawRoute, type AnyRoute } from "../router.ts";

// --- moved verbatim from server.ts 41-63 ---
const IMAGE_CONTENT_TYPES: Record<string, string> = { /* move lines 47-56 verbatim */ };
export function imageContentType(path: string): string | null { /* move lines 59-63 verbatim */ }

// --- moved verbatim from server.ts 116-128 ---
export function formatSseEvent(event: string, data: unknown): string { /* move lines 116-118 verbatim */ }
export function recentIngestEventsSql(sinceIso: string, limit = 50): string { /* move lines 120-128 verbatim */ }

// --- moved verbatim from server.ts 75-97 (incl. the safety doc comment) ---
async function handleImageRequest(url: URL): Promise<Response> { /* move verbatim */ }

// --- moved verbatim from server.ts 557-603 (the /api/events branch body),
//     reshaped only from `if (...) { ... }` to a function of URL→Response ---
function handleEventsRequest(): Response { /* move the ReadableStream + interval body verbatim */ }

// --- moved verbatim from server.ts 489-532, with serveIngestState →
//     getServeIngestState(). The workflow/seam calls are untouched. ---
async function handleIngestTrigger(req: Request): Promise<Response> { /* move verbatim */ }

export const liveRoutes: ReadonlyArray<AnyRoute> = [
    rawRoute({ method: "GET", path: "/api/events", handler: () => handleEventsRequest() }),
    rawRoute({ method: "GET", path: "/api/image", handler: ({ url }) => handleImageRequest(url) }),
    rawRoute({ method: "POST", path: "/api/ingest", handler: ({ req }) => handleIngestTrigger(req) }),
];
```

(`/api/events` today has no method check; it is declared GET because the SPA's `EventSource` only GETs - covered by behavioral delta 1's blanket rule. If you find a non-GET consumer during implementation, flip it to `"ANY"` and note it in the commit.)

`server.ts` final `handleDashboardRequest`:

```ts
export async function handleDashboardRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const routed = await dispatch(routeTable, req, url);
    if (routed !== null) return routed;
    // Legacy quirk preserved: unknown /api/* answers 200 {"error":"not_found"}
    // (hosted-studio compat; flagged for an api_version bump later).
    if (url.pathname.startsWith("/api/")) return jsonResponse({ error: "not_found" });
    // Non-API GET: tiny landing pointing at the hosted studio.
    if (req.method === "GET") return serveRootLanding(url.port || "1738");
    return new Response("not found", { status: 404 });
}
```

`serveDashboard` changes only two lines: `serveIngestState = { stream, runtime };` → `setServeIngestState({ stream, runtime });` and `serveIngestState = null;` (both occurrences) → `setServeIngestState(null);` with the import from `./ingest-state.ts`.
- [ ] **Step 4: Delete everything listed in Files from server.ts; fix `server.test.ts` imports** (it now imports `imageContentType` from `./router/routes/live.ts` if any direct-unit assertions remain there, otherwise those moved to `live.test.ts`).
- [ ] **Step 5: Full verification.**
  - `/tmp/rt.sh apps/axctl/src/dashboard` → all green (router, params, system, insights, sessions, skills, improve, live, server).
  - `/tmp/rt.sh apps/axctl` → no regressions elsewhere (mcp smoke test imports nothing moved; `cli/index.ts` only imports `serveDashboard`, unchanged).
  - `bun run typecheck 2>&1 | rg "dashboard"` → empty.
  - `wc -l apps/axctl/src/dashboard/server.ts` → expect ≈250 (serve lifecycle + CORS + epilogue + landing). If meaningfully above 300, something didn't move - find it.
  - Manual smoke (optional but recommended): `bun apps/axctl/bin/axctl serve` + `curl -s localhost:1738/api/version | jq .api_version` → `1`; `curl -s -X POST localhost:1738/api/wrapped -o /dev/null -w "%{http_code}"` → `405`.
- [ ] **Step 6: Commit** (files: `ingest-state.ts`, `router/routes/live.ts`, `router/routes/live.test.ts`, `router/table.ts`, `server.ts`, `server.test.ts`):

```
refactor(dashboard): raw escape-hatch routes + delete the if-chain

SSE /api/events, binary /api/image and POST /api/ingest move behind
rawRoute (verbatim bodies; the IngestStreamBus seam is untouched);
ServeIngestState gets its own module so live routes and serve lifecycle
share it without a cycle. handleDashboardRequest is now dispatch + a
three-line epilogue; server.ts drops from 1,249 to ~250 lines.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Acceptance checklist (end state)

- [ ] `server.ts` contains zero `url.pathname ===` / `url.pathname.match(` route checks.
- [ ] Every route in the inventory table is declared exactly once in `router/routes/*.ts` and reachable through `router/table.ts`.
- [ ] All six behavioral deltas have a test; everything else is wire-identical (the pre-existing request-level tests in `server.test.ts` - CORS/PNA, image, graph-explorer-disabled - pass unmodified in their assertions).
- [ ] No new `Record<string, unknown>` in router/route files except the legacy system-family row types, `bodyRecord` in skills.ts, and the lenient improve-action body record (the dashboard-wide count, ~145 today, must not grow).
- [ ] Exactly one `Effect.provide(AppLayer)` + cast site remains for request handling (`appLayerRunner`), plus the untouched ingest ManagedRuntime path.
- [ ] `bun run typecheck` clean for `dashboard/`; full `apps/axctl` test suite green.

## Open questions for the implementer (resolve during execution, do not block)

1. `Layer.Success<typeof AppLayer>` - confirmed pattern (server.ts already uses `Layer.Success<typeof IngestRuntimeLayer>`), but if `DashboardEnv` inference fights `Effect.provide(AppLayer)` in the runner, fall back to typing the runner input as `Effect.Effect<A, unknown, any>` with the cast comment - the route declarations stay fully typed either way.
2. The improve-route handler type annotation (Task 7) - prefer the plain explicit signature if the compiler complains.
3. If `Schema.FiniteFromString` rejects inputs that legacy `Number()` accepted beyond the documented `""` case (e.g. `"0x10"`), accept the stricter behavior and extend behavioral delta 5's note in the final commit body.
