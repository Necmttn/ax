// Extracted from cli/index.ts (Phase 2 CLI split)
import { DEFAULT_DASHBOARD_PORT } from "@ax/lib/dashboard-port";
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { serveDashboard } from "../../dashboard/server.ts";
import { serveMcp } from "../../mcp/server.ts";
import type { RuntimeManifest } from "./manifest.ts";

export const serveCommand = Command.make(
    "serve",
    { port: Flag.integer("port").pipe(Flag.withDefault(DEFAULT_DASHBOARD_PORT)) },
    ({ port }) => Effect.promise(() => serveDashboard([`--port=${port}`])),
).pipe(Command.withDescription("Serve the live web dashboard locally"));

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
