/**
 * Tiny typed route table for the dashboard server (Insights Surface).
 *
 * No framework: patterns compile to RegExp, the table is an ordered array,
 * first match wins. Two route kinds:
 *   - jsonRoute: pure param decoder -> Effect handler -> JSON encode, with
 *     optional respond/errorStatus overrides.
 *   - rawRoute: full Request -> Response escape hatch (SSE /api/events,
 *     binary /api/image, POST /api/ingest - the IngestStreamBus seam - plus
 *     the pure responses that must never build AppLayer: /api/version and
 *     empty-q /api/recall, whose eager SurrealClient build would stall ~5s
 *     without a DB).
 *
 * The Effect runner is injectable: production passes the server-scoped
 * runtime's runner (serve-runtime.ts), so layers are built once per server
 * lifetime; router/route unit tests pass a stub so they never build AppLayer
 * (and therefore never touch SurrealDB).
 */
import { Effect } from "effect";
import type { Layer } from "effect";
import type { AppLayer } from "@ax/lib/layers";
import type { DurableIngestStream } from "../ingest-stream-durable.ts";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Everything AppLayer provides; the upper bound for jsonRoute handler envs. */
export type DashboardEnv = Layer.Success<typeof AppLayer>;

/** Runs a handler effect to a Promise. Production = ServeRuntimeHandle.runner. */
export type EffectRunner = {
    bivarianceHack<A>(effect: Effect.Effect<A, unknown, DashboardEnv>): Promise<A>;
}["bivarianceHack"];

/**
 * Server-boot context threaded into raw routes. `null` means the request is
 * being handled WITHOUT a booted server (unit tests, direct invocation);
 * `ingestStream` is null when the Durable Streams sidecar could not start
 * (the compiled binary, which can't load native lmdb). /api/version reports
 * the second case as `live_ingest: false` and POST /api/ingest 503s on both.
 */
export interface ServeContext {
    readonly ingestStream: DurableIngestStream | null;
}

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
    /** Optional so hand-built test inputs stay terse; absent reads as null. */
    readonly serve?: ServeContext | null;
}

export interface RawRouteInput extends RouteInput {
    readonly runner: EffectRunner;
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
    /** Path matches with the wrong method should behave as unmatched. */
    readonly fallthroughOnMethodMismatch?: boolean;
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
    /** Path matches with the wrong method should behave as unmatched. */
    readonly fallthroughOnMethodMismatch?: boolean;
    readonly handler: (input: RawRouteInput) => Response | Promise<Response>;
}

/** Existentially-typed route: P/A are closed over at construction. */
export interface AnyRoute {
    /** Empty array = ANY method. */
    readonly methods: ReadonlyArray<Method>;
    readonly pattern: CompiledPattern;
    readonly fallthroughOnMethodMismatch: boolean;
    readonly readsBody: boolean;
    readonly run: (input: RouteInput, runner: EffectRunner) => Promise<Response>;
}

const toMethods = (m: Method | ReadonlyArray<Method> | "ANY"): ReadonlyArray<Method> =>
    m === "ANY" ? [] : Array.isArray(m) ? m : [m as Method];

export const errorMessage = (err: unknown): string => {
    if (err instanceof Error) return err.message;
    if (typeof err === "object" && err !== null && "message" in err) {
        return String(err.message);
    }
    return String(err);
};

// ----------------------------------------------------------- request deadline
//
// Per-request DB deadline. `acquire` (db.ts) already caps the initial connect at
// 5s, but once connected a daemon that wedges (alive but not answering - the
// recurring SurrealDB failure on this box) makes `db.query()` hang FOREVER, so
// JSON handlers pile up behind a dead websocket and the whole dashboard appears
// frozen (this is what made /api/wrapped hang). A whole-request timeout bounds
// each JSON handler's lifetime: the fiber is interrupted, the client gets a fast
// 504, and handlers stop accumulating. (The orphaned WS promise can't be force-
// cancelled, but the request no longer blocks - the daemon-side watchdog is what
// reaps the wedged surreal.)
//
// Scope is deliberately JSON routes only: rawRoutes (SSE /api/events, the
// ingest stream) own their own long-lived lifecycle and must NOT be clamped.
// Default 45s sits above legit slow reads (recall full-scans 5-15s today) and
// below Bun's 60s idleTimeout. AX_SERVE_QUERY_TIMEOUT_MS overrides; `0` disables
// (e.g. tests, or a deployment that wants the old unbounded behavior).
export const SERVE_REQUEST_TIMEOUT_DEFAULT_MS = 45_000;

/** Read the request deadline per call so serve env / tests can vary it. */
const serveRequestTimeoutMs = (): number => {
    const raw = process.env.AX_SERVE_QUERY_TIMEOUT_MS;
    if (raw === undefined || raw === "") return SERVE_REQUEST_TIMEOUT_DEFAULT_MS;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : SERVE_REQUEST_TIMEOUT_DEFAULT_MS;
};

/** Sentinel raised when a JSON handler outruns the request deadline -> HTTP 504. */
export class ServeRequestTimeout {
    readonly _tag = "ServeRequestTimeout";
    constructor(readonly ms: number) {}
}

export const jsonRoute = <P, A>(def: JsonRouteDef<P, A>): AnyRoute => ({
    methods: toMethods(def.method),
    pattern: compilePattern(def.path),
    fallthroughOnMethodMismatch: def.fallthroughOnMethodMismatch === true,
    readsBody: def.readsBody === true,
    run: async (input, runner) => {
        const decoded = def.decode(input);
        if (!decoded.ok) return jsonResponse(decoded.body, decoded.status);
        const timeoutMs = serveRequestTimeoutMs();
        const handler = def.handler(decoded.value);
        // Bound the handler so a wedged daemon can't hang the request forever.
        const effect = timeoutMs > 0
            ? handler.pipe(
                Effect.timeoutOrElse({
                    duration: `${timeoutMs} millis`,
                    orElse: () => Effect.fail(new ServeRequestTimeout(timeoutMs)),
                }),
            )
            : handler;
        try {
            const value = await runner(effect);
            return def.respond ? def.respond(value) : jsonResponse(value);
        } catch (err) {
            if (err instanceof ServeRequestTimeout) {
                return jsonResponse(
                    {
                        error:
                            `request exceeded the ${err.ms}ms server query deadline; the SurrealDB daemon may be wedged ` +
                            `(check 'ax serve status' and restart the db)`,
                    },
                    504,
                );
            }
            return jsonResponse(
                { error: errorMessage(err) },
                def.errorStatus?.(err) ?? 500,
            );
        }
    },
});

export const rawRoute = (def: RawRouteDef): AnyRoute => ({
    methods: toMethods(def.method),
    pattern: compilePattern(def.path),
    fallthroughOnMethodMismatch: def.fallthroughOnMethodMismatch === true,
    readsBody: false,
    run: (input, runner) => Promise.resolve(def.handler({ ...input, runner })),
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
            if (route.fallthroughOnMethodMismatch) continue;
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
    runner: EffectRunner,
    serve: ServeContext | null = null,
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
    return route.run({ req, url, path, body, serve }, runner);
}
