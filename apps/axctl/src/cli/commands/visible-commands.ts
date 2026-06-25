/**
 * Canonical list of visible top-level ax subcommands - used by `ax usage` to
 * compute the "never used" surface.  Keep in sync with the non-hidden entries
 * in `registeredCommands` in cli/index.ts.  Commands hidden via their family
 * RuntimeManifest (hidden: true) are intentionally excluded here; dev-only
 * commands (dogfood, AX_DEV=1) are also excluded.
 */
export const VISIBLE_COMMANDS: readonly string[] = [
    "ingest",
    "sessions",
    "improve",
    "wrapped",
    "retro",
    "recall",
    "skills",
    "signals",
    "roles",
    "hooks",
    "serve",
    "mcp",
    "tui",
    "share",
    "install",
    "setup",
    "cost",
    "otel",
    "memory",
    "quota",
    "dojo",
    "profile",
    "dispatches",
    "routing",
    "directives",
    "thinking",
    "digest",
    "team",
    "usage",
];
