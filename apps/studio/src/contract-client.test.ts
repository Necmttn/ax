import { afterAll, describe, expect, test } from "bun:test";
import { ApiError } from "./api-error.ts";
import { contractVersion } from "./contract-client.ts";

/** Daemon fixture: configurable /api/version responses per scenario. */
const responses: Record<string, () => Response> = {
    "/current": () =>
        Response.json({
            version: "0.27.0",
            api_version: 1,
            capabilities: ["sessions", "skills"],
            live_ingest: true,
        }),
    // A daemon predating the live_ingest field - the hosted studio must
    // keep decoding its handshake.
    "/old": () =>
        Response.json({
            version: "0.18.0",
            api_version: 1,
            capabilities: ["sessions"],
        }),
    // A daemon NEWER than this studio build: extra fields must be ignored.
    "/future": () =>
        Response.json({
            version: "9.9.9",
            api_version: 1,
            capabilities: [],
            live_ingest: false,
            brand_new_field: { nested: true },
        }),
    "/error": () => Response.json({ error: "exploded" }, { status: 500 }),
};

const server = Bun.serve({
    port: 0,
    fetch(req) {
        const url = new URL(req.url);
        const scenario = url.pathname.split("/api/version")[0] || "/current";
        const respond = responses[scenario];
        return respond ? respond() : new Response("not found", { status: 404 });
    },
});
const base = (scenario: string): string => `http://127.0.0.1:${server.port}${scenario === "/current" ? "" : scenario}`;
afterAll(() => server.stop());

describe("contractVersion", () => {
    test("decodes a current daemon handshake", async () => {
        const v = await contractVersion(base("/current"));
        expect(v.version).toBe("0.27.0");
        expect(v.api_version).toBe(1);
        expect(v.capabilities).toContain("skills");
        expect(v.live_ingest).toBe(true);
    });

    test("tolerates an old daemon without live_ingest", async () => {
        const v = await contractVersion(base("/old"));
        expect(v.version).toBe("0.18.0");
        expect(v.live_ingest).toBeUndefined();
    });

    test("ignores unknown fields from a newer daemon", async () => {
        const v = await contractVersion(base("/future"));
        expect(v.version).toBe("9.9.9");
        expect(v.live_ingest).toBe(false);
    });

    test("maps an HTTP failure to ApiError with the status", async () => {
        expect.assertions(2);
        try {
            await contractVersion(base("/error"));
        } catch (err) {
            expect(err).toBeInstanceOf(ApiError);
            expect((err as ApiError).status).toBe(500);
        }
    });

    test("maps a network failure to ApiError with status 0", async () => {
        expect.assertions(2);
        try {
            // Nothing listens here.
            await contractVersion("http://127.0.0.1:9");
        } catch (err) {
            expect(err).toBeInstanceOf(ApiError);
            expect((err as ApiError).status).toBe(0);
        }
    });
});
