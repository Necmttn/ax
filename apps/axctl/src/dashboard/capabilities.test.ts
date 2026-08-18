/**
 * Regression coverage for #834: three routes the studio advertised (or that
 * *looked* registered) turned out to be unreachable in practice - an
 * env-gated experiment (`graph-explorer`) linked unconditionally from the
 * Lab page, a fully-retired endpoint (`graph-health`) that still answered
 * with a plausible-looking JSON body, and a route (`session-orchestration`)
 * whose own frontend caller was never mounted. `/api/version`'s capability
 * list is what the studio uses for feature detection, so this file pins the
 * invariant end to end: every advertised capability resolves to a route that
 * is actually live, and the one CONDITIONAL capability (`graph-explorer`)
 * only appears in the list exactly when the route behind it is functional -
 * never advertised-but-dead, never live-but-unadvertised.
 */
import { describe, expect, test } from "bun:test";
import { baseApiCapabilities, dashboardApiCapabilities, isGraphExplorerEnabled } from "./capabilities.ts";
import { isContractRequest } from "./contract/web-handler.ts";
import { matchRoute } from "./router/router.ts";
import { routeTable } from "./router/table.ts";

/** One concrete (method, path) known to be served by each base capability -
 *  taken from the inline comment already documenting it in capabilities.ts. */
const CAPABILITY_PROBE: Record<(typeof baseApiCapabilities)[number], { method: string; path: string }> = {
    "skills": { method: "GET", path: "/api/skills" },
    "decisions": { method: "GET", path: "/api/decisions" },
    "workflow": { method: "GET", path: "/api/workflow" },
    "sessions": { method: "GET", path: "/api/sessions" },
    "episodes": { method: "GET", path: "/api/episodes/abc" },
    "projects": { method: "GET", path: "/api/projects/abc" },
    "skill-graph": { method: "GET", path: "/api/skill-graph" },
    "recall": { method: "GET", path: "/api/recall" },
    "tools": { method: "GET", path: "/api/tool-failures" },
    "wrapped": { method: "GET", path: "/api/wrapped" },
    "improve": { method: "GET", path: "/api/improve" },
    "next-actions": { method: "GET", path: "/api/next-actions" },
    "improve-analyze": { method: "GET", path: "/api/improve/analyze-brief" },
    "wrapped-generate": { method: "GET", path: "/api/wrapped/generate-brief" },
    "improve-impact": { method: "GET", path: "/api/improve/abc/impact" },
    "events": { method: "GET", path: "/api/events" },
    "image": { method: "GET", path: "/api/image" },
    "otlp": { method: "POST", path: "/v1/metrics" },
};

/** Is (method, path) actually routed somewhere - contract OR legacy table?
 *  Mirrors the real dispatch order in server.ts's handleDashboardRequest. */
function isLive(method: string, path: string): boolean {
    if (isContractRequest(method, path)) return true;
    return matchRoute(routeTable, method, path).kind === "matched";
}

describe("capability list <-> live route set agreement (#834)", () => {
    test("every base (always-advertised) capability resolves to a live route", () => {
        for (const capability of baseApiCapabilities) {
            const probe = CAPABILITY_PROBE[capability];
            expect(probe, `no probe registered for capability "${capability}" - add one above`).toBeDefined();
            expect(
                isLive(probe.method, probe.path),
                `capability "${capability}" advertises ${probe.method} ${probe.path}, but nothing routes it`,
            ).toBe(true);
        }
    });

    test("graph-explorer capability is advertised iff the flag that gates its route is on", () => {
        const off = dashboardApiCapabilities({});
        const on = dashboardApiCapabilities({ AX_ENABLE_GRAPH_EXPLORER: "1" });
        expect(isGraphExplorerEnabled({})).toBe(false);
        expect(off).not.toContain("graph-explorer");
        expect(isGraphExplorerEnabled({ AX_ENABLE_GRAPH_EXPLORER: "1" })).toBe(true);
        expect(on).toContain("graph-explorer");
        // graph-explorer is a legacy (non-contract) route by design - it lives
        // outside the contract until it graduates or dies.
        expect(isContractRequest("GET", "/api/graph-explorer")).toBe(false);
        expect(matchRoute(routeTable, "GET", "/api/graph-explorer").kind).toBe("matched");
    });

    test("graph-health is neither routed nor advertised - fully retired, not a live capability", () => {
        // Studio ephemeral (wave 3) retired this endpoint on purpose: it would
        // mean re-opening a dependency (an admin health scan) that doesn't
        // belong on a process that reads a published snapshot and exits (see
        // contract/system.ts's module doc). Confirm it stays that way on both
        // sides: no route answers it, and no capability claims it.
        expect(isContractRequest("GET", "/api/graph-health")).toBe(false);
        expect(matchRoute(routeTable, "GET", "/api/graph-health").kind).toBe("unmatched");
        for (const capability of dashboardApiCapabilities({ AX_ENABLE_GRAPH_EXPLORER: "1" })) {
            expect(capability).not.toBe("graph-health");
        }
    });

    test("session-orchestration is contract-routed (covered by the coarse 'sessions' capability)", () => {
        // Unlike graph-health, this route IS live end to end (verified against
        // a real handler in sessions.test.ts / 834-probe evidence) - #834's
        // report of an "empty body" came from probing it without the required
        // `id` query param, which every id-keyed contract route does (see
        // session-summary, same schema). It is not itself broken or dead; it
        // just has no live frontend caller yet (apps/studio's OrchestrationPanel
        // is now wired into the session canvas - see routes/canvas.tsx).
        expect(isContractRequest("GET", "/api/session-orchestration")).toBe(true);
    });
});
