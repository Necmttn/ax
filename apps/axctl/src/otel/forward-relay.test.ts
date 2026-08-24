import { describe, expect, test } from "bun:test";
import { relayOtlp, makeRelayLogger } from "./forward-relay.ts";
import { buildForwardConfig, type OtelForwardConfig } from "./forward-config.ts";

const DD = "https://otlp.datadoghq.com";
const cfg = (enabled = true): OtelForwardConfig => ({
    ...buildForwardConfig(
        [{ signal: "logs", url: `${DD}/v1/logs`, headers: { "dd-api-key": "secret" } }],
        "2026-08-24T00:00:00Z",
    ),
    enabled,
});

describe("relayOtlp (#1017)", () => {
    test("POSTs the body + headers to the matching signal target", async () => {
        const calls: Array<{ url: string; init: RequestInit }> = [];
        const fakeFetch = (async (url: string, init: RequestInit) => {
            calls.push({ url, init });
            return new Response("ok", { status: 200 });
        }) as unknown as typeof fetch;

        let ok: string | undefined;
        await relayOtlp(cfg(), "/v1/logs", "{\"body\":1}", { fetch: fakeFetch, onSuccess: (s) => { ok = s; } });

        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe(`${DD}/v1/logs`);
        expect(calls[0].init.method).toBe("POST");
        expect(calls[0].init.body).toBe("{\"body\":1}");
        expect((calls[0].init.headers as Record<string, string>)["dd-api-key"]).toBe("secret");
        expect((calls[0].init.headers as Record<string, string>)["content-type"]).toBe("application/json");
        expect(ok).toBe("logs");
    });

    test("skips when no target matches the signal", async () => {
        let called = false;
        const fakeFetch = (async () => { called = true; return new Response("ok"); }) as unknown as typeof fetch;
        await relayOtlp(cfg(), "/v1/metrics", "{}", { fetch: fakeFetch });
        expect(called).toBe(false);
    });

    test("skips entirely when forwarding is disabled", async () => {
        let called = false;
        const fakeFetch = (async () => { called = true; return new Response("ok"); }) as unknown as typeof fetch;
        await relayOtlp(cfg(false), "/v1/logs", "{}", { fetch: fakeFetch });
        expect(called).toBe(false);
    });

    test("a non-2xx upstream is reported via onError, never thrown", async () => {
        const fakeFetch = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
        let errSignal: string | undefined;
        await expect(relayOtlp(cfg(), "/v1/logs", "{}", {
            fetch: fakeFetch,
            onError: (s) => { errSignal = s; },
        })).resolves.toBeUndefined();
        expect(errSignal).toBe("logs");
    });

    test("a thrown fetch (upstream down) is swallowed and reported", async () => {
        const fakeFetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
        const errors: unknown[] = [];
        await expect(relayOtlp(cfg(), "/v1/logs", "{}", {
            fetch: fakeFetch,
            onError: (_s, e) => { errors.push(e); },
        })).resolves.toBeUndefined();
        expect(errors).toHaveLength(1);
    });

    test("makeRelayLogger warns once per signal", () => {
        const seen: string[] = [];
        const orig = console.warn;
        console.warn = (m?: unknown) => { seen.push(String(m)); };
        try {
            const log = makeRelayLogger();
            log("logs", new Error("down"));
            log("logs", new Error("still down"));
            log("metrics", new Error("down"));
        } finally {
            console.warn = orig;
        }
        expect(seen.filter((m) => m.includes("logs"))).toHaveLength(1);
        expect(seen.filter((m) => m.includes("metrics"))).toHaveLength(1);
    });
});
