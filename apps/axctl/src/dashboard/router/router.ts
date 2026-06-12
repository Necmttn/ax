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
import type { Effect, Layer } from "effect";
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

export const jsonRoute = <P, A>(def: JsonRouteDef<P, A>): AnyRoute => ({
    methods: toMethods(def.method),
    pattern: compilePattern(def.path),
    fallthroughOnMethodMismatch: def.fallthroughOnMethodMismatch === true,
    readsBody: def.readsBody === true,
    run: async (input, runner) => {
        const decoded = def.decode(input);
        if (!decoded.ok) return jsonResponse(decoded.body, decoded.status);
        try {
            const value = await runner(def.handler(decoded.value));
            return def.respond ? def.respond(value) : jsonResponse(value);
        } catch (err) {
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
