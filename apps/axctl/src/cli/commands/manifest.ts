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

export type RuntimeManifest = Readonly<Record<string, CommandRuntime>>;
