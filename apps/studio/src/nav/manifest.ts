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

/** Grouped (not flat) because the fixed set grew from 8 to 13 entries - past
 *  ~8 icons a flat rail stops being scannable at a glance. Groups answer
 *  "where do I look for X": overview = state of the world, explore = drill
 *  into a graph/data surface, manage = act on what you found. Order within a
 *  group is deliberate (most-used first), not alphabetical. */
export const NAV_ENTRIES: readonly NavEntry[] = [
    // overview - state of the world right now
    { g: "◢", to: "/", label: "mission control", exact: true, group: "overview" },
    { g: "≣", to: "/sessions", label: "sessions", group: "overview" },
    { g: "◧", to: "/cost", label: "cost", group: "overview" },
    { g: "▤", to: "/usage", label: "usage", group: "overview" },
    { g: "◳", to: "/team", label: "team metrics", group: "overview" },

    // explore - graph / data surfaces you drill into
    { g: "◷", to: "/workflow", label: "workflow", group: "explore" },
    { g: "✦", to: "/skills", label: "skills", group: "explore" },
    { g: "◈", to: "/skills/graph", label: "skill graph", group: "explore" },
    { g: "◫", to: "/graph", label: "graph explorer", group: "explore" },
    { g: "▦", to: "/canvas", label: "canvas", group: "explore" },
    { g: "⚑", to: "/tools", label: "tool failures", group: "explore" },

    // manage - act on what you found
    { g: "⎈", to: "/improve", label: "improve", group: "manage" },
    { g: "⚙", to: "/lab", label: "lab", group: "manage" },
];

export interface NavExclusion {
    readonly to: string;
    readonly reason: string;
}

/** Registered, non-parameterized routes deliberately left off the rail.
 *  Parameterized routes (`$sessionId`, `$slug`, ...) are excluded by
 *  `manifest.test.ts` automatically (no static nav entry makes sense for
 *  them) and do NOT need an entry here. Everything else must be listed with
 *  a reason - an unreasoned exclusion is exactly the #829 bug in a new coat. */
export const NAV_EXCLUSIONS: readonly NavExclusion[] = [
    {
        to: "/mc",
        reason:
            "duplicate alias of / - same MissionControl component, and Shell.tsx already treats /mc as an instrument-chrome route alongside /",
    },
    {
        to: "/sessions/compare",
        reason:
            "static path but only meaningful with a pre-selected ?ids= session set; reached from within /sessions (a compare action on selected rows), not a standalone destination",
    },
    {
        to: "/lab/sigils",
        reason:
            "hidden design-iteration page - source comment on SigilGalleryRoute says explicitly 'no nav tab'; reached only via a link from /lab",
    },
    {
        to: "/narration-demo",
        reason:
            "prototype showcase for the Story review surface fixture (sample narration + turns), not a real data view",
    },
];
