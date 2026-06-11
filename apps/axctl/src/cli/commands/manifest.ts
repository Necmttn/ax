/**
 * How a top-level axctl command must be routed by main() in cli/index.ts.
 * Every command-family module exports a RuntimeManifest covering exactly the
 * top-level names it registers; index.ts spreads them into RUNTIME_BY_COMMAND
 * and derives DB_COMMANDS. effect-cli.test.ts enforces exhaustiveness against
 * rootCommand, so an undeclared new command fails CI instead of dying at
 * runtime on the no-DB Proxy.
 */
export type CommandRuntime =
    /** handlers reach SurrealDB - route through withDb (AppLayer) */
    | "db"
    /** ingest pipeline - route through withIngest (IngestRuntimeLayer + trace transports) */
    | "ingest"
    /** must never touch the DB - route through withoutDb (Proxy SurrealClient that throws) */
    | "none";

/**
 * Routing for one subcommand of a db-conditional family: either a static
 * runtime, or a per-invocation resolver over the raw argv (args[0] is the
 * family name) for subcommands whose DB usage depends on flags.
 */
export type SubcommandRuntime =
    | CommandRuntime
    | ((args: ReadonlyArray<string>) => CommandRuntime);

/**
 * Conditional routing for a family whose subcommands split between runtimes
 * (e.g. `classifiers eval` is pure compute while `classifiers graph` reads
 * the DB). The family declares an exhaustive per-subcommand table here so
 * dispatch never hard-codes subcommand names; effect-cli.test.ts enforces the
 * table against the registered subcommands in both directions, so a new
 * subcommand added without a routing declaration fails CI.
 */
export interface DbConditionalRuntime {
    readonly kind: "db-conditional";
    /** Runtime for the bare family command, `--help`, or an unknown subcommand. */
    readonly fallback: CommandRuntime;
    /** Exhaustive per-subcommand routing, keyed by subcommand name (argv[1]). */
    readonly subcommands: Readonly<Record<string, SubcommandRuntime>>;
}

/** A family's routing declaration: static runtime or per-subcommand conditional. */
export type RuntimeDeclaration = CommandRuntime | DbConditionalRuntime;

/**
 * Per-command metadata beyond routing. Visibility policy (#173): a hidden
 * command is omitted from `--help`, shell completions, and "did you mean?"
 * while staying fully invokable by exact name (agents, plists, and docs use
 * the names). Read-only insight surfaces MUST stay visible - a hidden command
 * is invisible to agents discovering the tool via `--help`, so it never gets
 * used (blind-dogfood finding). Hide only mutating / maintenance / plumbing
 * verbs.
 */
export interface CommandMeta {
    readonly runtime: RuntimeDeclaration;
    /** Omit the command from `--help` / completions (still callable by name). */
    readonly hidden: boolean;
}

/**
 * One manifest entry: a bare routing declaration (the command is visible) or
 * routing wrapped with metadata (`{ runtime, hidden }`). Families fully own
 * their commands' metadata here; cli/index.ts assembles the root command via
 * a uniform loop over these entries (issue #248) - no per-command
 * `withHidden` calls at the assembly site.
 */
export type ManifestEntry = RuntimeDeclaration | CommandMeta;

export type RuntimeManifest = Readonly<Record<string, ManifestEntry>>;

/** Discriminate `CommandMeta` from a bare `DbConditionalRuntime` declaration. */
const isCommandMeta = (entry: ManifestEntry): entry is CommandMeta =>
    typeof entry !== "string" && !("kind" in entry);

/** The routing declaration of an entry, unwrapping `CommandMeta` if present. */
export const entryRuntime = (entry: ManifestEntry): RuntimeDeclaration =>
    isCommandMeta(entry) ? entry.runtime : entry;

/** Whether the entry's command is hidden from `--help` (bare entries are visible). */
export const entryHidden = (entry: ManifestEntry): boolean =>
    isCommandMeta(entry) ? entry.hidden : false;

/**
 * Resolve a manifest entry to the concrete runtime for one invocation. Static
 * declarations resolve to themselves; db-conditional ones look up argv[1] in
 * the family's subcommand table (falling back for bare/--help/unknown).
 */
export const resolveRuntime = (
    entry: ManifestEntry,
    args: ReadonlyArray<string>,
): CommandRuntime => {
    const declaration = entryRuntime(entry);
    if (typeof declaration === "string") return declaration;
    const sub = declaration.subcommands[args[1] ?? ""];
    if (sub === undefined) return declaration.fallback;
    return typeof sub === "function" ? sub(args) : sub;
};
