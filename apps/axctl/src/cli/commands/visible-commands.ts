/**
 * Public command surfaces.
 *
 * `DEFAULT_COMMANDS` is the small command set shown by `ax help`.
 * The other groups stay callable by exact name and remain part of usage
 * analytics. Add a command to the default set only when it is a common entry
 * point. This list does not include internal maintenance commands.
 */
export const COMMAND_SURFACES = {
    core: [
        "install",
        "setup",
        "doctor",
        "ingest",
        "studio",
        "sessions",
        "recall",
        "skills",
        "improve",
        "cost",
        "profile",
        "share",
    ],
    advanced: [
        "signals",
        "hooks",
        "runs",
        "segment",
        "memory",
        "quota",
        "dojo",
        "contribute",
        "dispatches",
        "routing",
        "directives",
        "thinking",
        "digest",
        "team",
        "usage",
    ],
    service: ["mcp", "tui", "otel", "otlpd"],
    compatibility: ["wrapped", "retro", "roles"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type CommandSurface = keyof typeof COMMAND_SURFACES;

export const DEFAULT_COMMANDS: readonly string[] = COMMAND_SURFACES.core;

/** All public commands used by `ax usage`, including non-default surfaces. */
export const VISIBLE_COMMANDS: readonly string[] = Object.values(COMMAND_SURFACES).flat();

const defaultCommandSet = new Set<string>(DEFAULT_COMMANDS);

export const isDefaultCommand = (name: string): boolean => defaultCommandSet.has(name);
