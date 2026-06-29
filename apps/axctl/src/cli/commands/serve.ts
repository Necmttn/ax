// Extracted from cli/index.ts (Phase 2 CLI split)
import { DEFAULT_DASHBOARD_PORT } from "@ax/lib/dashboard-port";
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { serveStatus, serveStop } from "../../dashboard/serve-control.ts";
import { serveDashboard } from "../../dashboard/server.ts";
import { serveMcp } from "../../mcp/server.ts";
import type { RuntimeManifest } from "./manifest.ts";

// status/stop are deliberately flag-free: they resolve the port from the
// pidfile the daemon writes on startup (falling back to the default port),
// so they find the instance wherever it was started.
const serveStatusCommand = Command.make("status", {}, () =>
    Effect.promise(async () => {
        process.exitCode = await serveStatus();
    }),
).pipe(Command.withDescription("Show whether the local daemon is running, its pid, and its URLs"));

const serveStopCommand = Command.make("stop", {}, () =>
    Effect.promise(async () => {
        process.exitCode = await serveStop();
    }),
).pipe(Command.withDescription("Stop the running local daemon (SIGTERM to the port's listener)"));

export const serveCommand = Command.make(
    "serve",
    {
        port: Flag.integer("port").pipe(Flag.withDefault(DEFAULT_DASHBOARD_PORT)),
        managedDb: Flag.boolean("managed-db").pipe(
            Flag.withDefault(false),
            Flag.withDescription(
                "Spawn and supervise the bundled surreal binary as a child process before serving. " +
                "Resolves surreal as a sibling of the bun execPath (used by the macOS background helper).",
            ),
        ),
        ingestEvery: Flag.string("ingest-every").pipe(
            Flag.optional,
            Flag.withDescription(
                "Run the ingest pipeline on this interval (e.g. '2m', '30s'). " +
                "Requires a running DB. Off by default.",
            ),
        ),
    },
    ({ port, managedDb, ingestEvery }) => {
        const args: string[] = [`--port=${port}`];
        if (managedDb) args.push("--managed-db");
        if (ingestEvery._tag === "Some") args.push(`--ingest-every=${ingestEvery.value}`);
        return Effect.promise(() => serveDashboard(args));
    },
).pipe(
    Command.withDescription("Serve the live web dashboard locally (status/stop manage a running daemon)"),
    Command.withSubcommands([serveStatusCommand, serveStopCommand]),
);

// Manages its own long-lived ManagedRuntime (like serve), so it is deliberately
// NOT in DB_COMMANDS - it routes through `withoutDb` and builds AppLayer itself.
export const mcpCommand = Command.make(
    "mcp",
    {},
    () => Effect.promise(() => serveMcp([])),
).pipe(Command.withDescription("Run an MCP server (stdio) exposing ax's read-only queries"));

export const tuiCommand = Command.make("tui", {}, () =>
    Effect.promise(async () => {
        // TUI manages its own AppLayer scope so the SurrealDB connection
        // outlives the React tree. Dynamic import keeps React/opentui out
        // of the load path for non-TUI commands.
        const { runTui } = await import("../../tui/index.tsx");
        await runTui();
    }),
).pipe(Command.withDescription("Open the interactive dashboard"));

export const serveRuntime: RuntimeManifest = {
    serve: "none",
    mcp: "none",
    tui: "db",
};
