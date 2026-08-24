/** Single source of truth for the studio nav rail.
 *
 *  #829: the rail (`instrument/shell.tsx`) hard-coded 8 entries while the
 *  router registered 22 routes - 14 of them held live data (49 top commands
 *  on /usage, 92 failures on /tools, 396 nodes on /canvas, ...) with no link
 *  to reach them. The fix here is the MECHANISM, not the icon count: every
 *  route the router registers must show up in exactly one of the two lists
 *  below, and `manifest.test.ts` walks the live `routeTree` to enforce it -
 *  a route added without a nav decision fails the test instead of going dark.
 */

export type NavGroup = "overview" | "explore" | "manage";

export interface NavEntry {
    /** Glyph shown in the collapsed rail. */
    readonly g: string;
    /** Route path - must match a `path` given to `createRoute` in router.tsx. */
    readonly to: string;
    readonly label: string;
    /** `activeOptions.exact` - only "/" needs this (every other path is a
     *  unique prefix). */
    readonly exact?: boolean;
    readonly group: NavGroup;
}

/** Seven common destinations stay in the rail. Specialized and experimental
 *  routes use contextual links recorded in NAV_EXCLUSIONS. */
export const NAV_ENTRIES: readonly NavEntry[] = [
    // overview - state of the world right now
    { g: "◢", to: "/", label: "mission control", exact: true, group: "overview" },
    { g: "≣", to: "/sessions", label: "sessions", group: "overview" },
    { g: "◧", to: "/cost", label: "cost", group: "overview" },
    { g: "◷", to: "/workflow", label: "workflow", group: "explore" },
    { g: "✦", to: "/skills", label: "skills", group: "explore" },
    { g: "⚑", to: "/tools", label: "tool failures", group: "explore" },
    { g: "⎈", to: "/improve", label: "improve", group: "manage" },
];

export interface NavExclusion {
    readonly to: string;
    readonly reason: string;
    readonly access: "context" | "deep-link" | "alias";
    readonly from?: string;
    readonly capability?: string;
}

/** Registered, non-parameterized routes deliberately left off the rail.
 *  Parameterized routes (`$sessionId`, `$slug`, ...) are excluded by
 *  `manifest.test.ts` automatically (no static nav entry makes sense for
 *  them) and do NOT need an entry here. Everything else must be listed with
 *  a reason - an unreasoned exclusion is exactly the #829 bug in a new coat. */
export const NAV_EXCLUSIONS: readonly NavExclusion[] = [
    {
        to: "/mc",
        access: "alias",
        reason:
            "duplicate alias of / - same MissionControl component, and Shell.tsx already treats /mc as an instrument-chrome route alongside /",
    },
    {
        to: "/sessions/compare",
        access: "context",
        from: "/sessions",
        reason:
            "static path but only meaningful with a pre-selected ?ids= session set; reached from within /sessions (a compare action on selected rows), not a standalone destination",
    },
    {
        to: "/usage",
        access: "context",
        from: "/",
        reason: "reached from the Mission Control secondary links",
    },
    {
        to: "/team",
        access: "context",
        from: "/",
        reason: "reached from the Mission Control secondary links",
    },
    {
        to: "/skills/graph",
        access: "context",
        from: "/skills",
        reason: "reached from the Skills page as its graph drilldown",
    },
    {
        to: "/lab",
        access: "context",
        from: "/",
        reason: "experimental surfaces are reached from Mission Control",
    },
    {
        to: "/canvas",
        access: "context",
        from: "/lab",
        reason: "reached from the Lab page as an experimental session view",
    },
    {
        to: "/graph",
        access: "context",
        from: "/lab",
        capability: "graph-explorer",
        reason: "reached from Lab only when the graph-explorer capability is enabled",
    },
    {
        to: "/lab/sigils",
        access: "context",
        from: "/lab",
        reason:
            "hidden design-iteration page - source comment on SigilGalleryRoute says explicitly 'no nav tab'; reached only via a link from /lab",
    },
    {
        to: "/narration-demo",
        access: "deep-link",
        reason:
            "prototype showcase for the Story review surface fixture (sample narration + turns), not a real data view",
    },
];
