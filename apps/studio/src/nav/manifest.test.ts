import { describe, expect, test } from "bun:test";
import { router } from "../router.tsx";
import { NAV_ENTRIES, NAV_EXCLUSIONS } from "./manifest.ts";

/** Every path the router actually registers, read off the live routeTree
 *  (not hand-copied) - this is what makes the test catch route 23. */
function registeredRoutePaths(): string[] {
    const root = router.routeTree as unknown as { children?: ReadonlyArray<{ fullPath: string }> };
    return (root.children ?? []).map((r) => r.fullPath);
}

/** A route segment like `$sessionId` or `$slug` - these legitimately have no
 *  static rail entry, so they're excluded from the coverage check by pattern
 *  rather than by name (a new parameterized route needs no manifest edit). */
const isParameterized = (path: string): boolean => path.includes("$");

describe("studio nav rail route coverage (#829)", () => {
    const registered = registeredRoutePaths();

    test("sanity: the route tree still has routes to check", () => {
        expect(registered.length).toBeGreaterThan(0);
    });

    test("the rail has exactly the seven common destinations", () => {
        expect(NAV_ENTRIES.map((entry) => entry.to)).toEqual([
            "/",
            "/sessions",
            "/cost",
            "/workflow",
            "/skills",
            "/tools",
            "/improve",
        ]);
    });

    test("every non-parameterized route is either linked from the rail or explicitly excluded with a reason", () => {
        const navPaths = new Set(NAV_ENTRIES.map((e) => e.to));
        const exclusionPaths = new Set(NAV_EXCLUSIONS.map((e) => e.to));

        const missing = registered.filter(
            (path) => !isParameterized(path) && !navPaths.has(path) && !exclusionPaths.has(path),
        );

        expect(missing).toEqual([]);
    });

    test("every nav entry points at a route the router actually registers (no dead links)", () => {
        const registeredSet = new Set(registered);
        const dangling = NAV_ENTRIES.filter((e) => !registeredSet.has(e.to)).map((e) => e.to);
        expect(dangling).toEqual([]);
    });

    test("every exclusion still names a real, registered route (no stale exclusions)", () => {
        const registeredSet = new Set(registered);
        const stale = NAV_EXCLUSIONS.filter((e) => !registeredSet.has(e.to)).map((e) => e.to);
        expect(stale).toEqual([]);
    });

    test("every exclusion carries a non-trivial reason", () => {
        for (const exclusion of NAV_EXCLUSIONS) {
            expect(exclusion.reason.length).toBeGreaterThan(10);
        }
    });

    test("context exclusions name their source and graph explorer stays gated", () => {
        for (const exclusion of NAV_EXCLUSIONS) {
            if (exclusion.access === "context") {
                expect(exclusion.from, `${exclusion.to} has no contextual source`).toBeDefined();
            }
        }
        expect(NAV_EXCLUSIONS.find((entry) => entry.to === "/graph")).toMatchObject({
            access: "context",
            from: "/lab",
            capability: "graph-explorer",
        });
    });

    test("no path is both a nav entry and an exclusion", () => {
        const navPaths = new Set(NAV_ENTRIES.map((e) => e.to));
        const overlap = NAV_EXCLUSIONS.filter((e) => navPaths.has(e.to)).map((e) => e.to);
        expect(overlap).toEqual([]);
    });
});
