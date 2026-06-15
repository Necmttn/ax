import { describe, expect, test } from "bun:test";
import { matchRoute } from "../router.ts";
import { systemRoutes } from "./system.ts";

describe("systemRoutes", () => {
    test("only /api/version remains in the legacy table (rest is contract-served)", () => {
        expect(systemRoutes.length).toBe(1);
        expect(matchRoute(systemRoutes, "GET", "/api/version").kind).toBe("matched");
        // Method-ANY quirk preserved: studio probes may use any method.
        expect(matchRoute(systemRoutes, "POST", "/api/version").kind).toBe("matched");
        expect(matchRoute(systemRoutes, "POST", "/api/query").kind).toBe("unmatched");
    });

    test("GET /api/version reports live_ingest=false without a streaming sidecar", async () => {
        // No serveDashboard boot in tests => no Durable Streams sidecar, the
        // same shape as the compiled binary. The studio reads this flag to
        // engage its polling fallback instead of hitting the 503.
        const matched = matchRoute(systemRoutes, "GET", "/api/version");
        if (matched.kind !== "matched") throw new Error("expected /api/version to match");
        const res = await matched.match.route.run(
            {
                req: new Request("http://h/api/version"),
                url: new URL("http://h/api/version"),
                path: {},
                body: { kind: "none" },
            },
            (() => Promise.reject(new Error("unused"))) as never,
        );
        expect(res.status).toBe(200);
        const body = await res.json() as { live_ingest: boolean; otlp_receiver: boolean; capabilities: string[] };
        expect(body.live_ingest).toBe(false);
        expect(body.otlp_receiver).toBe(true);
        expect(body.capabilities).toContain("ingest");
    });
});
