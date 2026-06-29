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
        const p = compilePattern("/api/a.b+c/[x]");
        expect("/api/a.b+c/[x]".match(p.regex)).not.toBeNull();
        expect("/api/abbc/x".match(p.regex)).toBeNull();
        expect("/api/aZbbbc/x".match(p.regex)).toBeNull();
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

    test("routes can opt into wrong-method fallthrough", async () => {
        const fallthroughTable: ReadonlyArray<AnyRoute> = [
            {
                ...jsonRoute({
                    method: "GET",
                    path: "/api/legacy-get",
                    decode: () => decodeOk(undefined),
                    handler: () => Effect.succeed({ ok: true }),
                }),
                fallthroughOnMethodMismatch: true,
            },
        ];

        expect(matchRoute(fallthroughTable, "POST", "/api/legacy-get").kind).toBe("unmatched");
        await expect(dispatch(
            fallthroughTable,
            post("/api/legacy-get"),
            new URL("http://h/api/legacy-get"),
            testRunner,
        )).resolves.toBeNull();
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
        const failure = { message: "session not found" };
        const table = [jsonRoute({
            method: "GET",
            path: "/api/boom",
            decode: () => decodeOk(undefined),
            handler: () => Effect.fail(failure),
            errorStatus: (err) =>
                typeof err === "object"
                    && err !== null
                    && "message" in err
                    && /not found/i.test(String(err.message))
                    ? 404
                    : 500,
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

describe("request deadline (AX_SERVE_QUERY_TIMEOUT_MS)", () => {
    const slowTable = (ms: number): ReadonlyArray<AnyRoute> => [
        jsonRoute({
            method: "GET",
            path: "/api/slow",
            decode: () => decodeOk(undefined),
            // A handler that outlives any tight deadline (mirrors a wedged db.query).
            handler: () => Effect.sleep(`${ms} millis`).pipe(Effect.as({ ok: true })),
        }),
    ];

    test("a handler that outruns the deadline returns 504, not a hang", async () => {
        const prev = process.env.AX_SERVE_QUERY_TIMEOUT_MS;
        process.env.AX_SERVE_QUERY_TIMEOUT_MS = "20"; // 20ms deadline
        try {
            const res = await dispatch(
                slowTable(5_000), // handler would take 5s
                get("/api/slow"),
                new URL("http://h/api/slow"),
                testRunner,
            );
            expect(res?.status).toBe(504);
            const body = (await res?.json()) as { error?: string };
            expect(String(body?.error)).toContain("server query deadline");
        } finally {
            if (prev === undefined) delete process.env.AX_SERVE_QUERY_TIMEOUT_MS;
            else process.env.AX_SERVE_QUERY_TIMEOUT_MS = prev;
        }
    });

    test("a fast handler completes normally under the deadline", async () => {
        const prev = process.env.AX_SERVE_QUERY_TIMEOUT_MS;
        process.env.AX_SERVE_QUERY_TIMEOUT_MS = "5000";
        try {
            const res = await dispatch(
                slowTable(1), // ~immediate
                get("/api/slow"),
                new URL("http://h/api/slow"),
                testRunner,
            );
            expect(res?.status).toBe(200);
            expect(await res?.json()).toEqual({ ok: true });
        } finally {
            if (prev === undefined) delete process.env.AX_SERVE_QUERY_TIMEOUT_MS;
            else process.env.AX_SERVE_QUERY_TIMEOUT_MS = prev;
        }
    });

    test("AX_SERVE_QUERY_TIMEOUT_MS=0 disables the deadline (unbounded)", async () => {
        const prev = process.env.AX_SERVE_QUERY_TIMEOUT_MS;
        process.env.AX_SERVE_QUERY_TIMEOUT_MS = "0";
        try {
            const res = await dispatch(
                slowTable(30), // would 504 under a tight deadline; here it must complete
                get("/api/slow"),
                new URL("http://h/api/slow"),
                testRunner,
            );
            expect(res?.status).toBe(200);
        } finally {
            if (prev === undefined) delete process.env.AX_SERVE_QUERY_TIMEOUT_MS;
            else process.env.AX_SERVE_QUERY_TIMEOUT_MS = prev;
        }
    });
});
