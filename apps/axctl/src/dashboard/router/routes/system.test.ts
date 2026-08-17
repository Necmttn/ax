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

    test("GET /api/version cannot contradict itself about the OTLP receiver", async () => {
        // live_ingest is genuinely retired: the in-browser ingest trigger and
        // its Durable Streams sidecar are gone.
        //
        // otlp_receiver is the interesting one. It was hardcoded `false` while
        // `capabilities` in the SAME body carried "otlp", and `POST /v1/logs`
        // on that port answered 200 - so the two halves disagreed and the
        // boolean was the wrong half. It is now derived from the capability
        // list, and this asserts the two agree rather than pinning a literal.
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
        expect(body.otlp_receiver).toBe(body.capabilities.includes("otlp"));
        expect(body.capabilities).toContain("otlp");
        expect(body.otlp_receiver).toBe(true);
        expect(body.capabilities).toContain("sessions");
        // Retired alongside the live-ingest trigger (studio ephemeral, wave 3).
        expect(body.capabilities).not.toContain("ingest");
    });
});
