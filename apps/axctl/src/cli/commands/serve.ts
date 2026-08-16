// Extracted from cli/index.ts (Phase 2 CLI split)
//
// Studio ephemeral (wave 3, `c-daemon-studio`): `ax serve` is retired in
// favor of `ax studio` - an on-demand process that binds a port only while a
// client is connected and exits on its own afterward (dashboard/server.ts).
// There is no more always-on daemon to check on or stop, so `status`/`stop`
// (dashboard/serve-control.ts, deleted) go with it; `ax studio` itself
// prints a clean "already running" message if a race lands two invocations
// on the same port (see server.ts's pre-flight probe).
//
// `serveCommand` keeps its EXPORT NAME (not renamed to `studioCommand`)
// because `cli/index.ts` imports it by this identifier and this chunk may
// not edit that file (Ruling R34 defers the `RUNTIME_BY_COMMAND` rewiring
// pass to its own chunk after this whole band lands) - `Command.make`'s
// first argument, not the variable name, is what the CLI actually parses,
// so renaming that string alone is enough to turn `ax serve` into
// `ax studio` with zero index.ts changes. `studioCommand` is exported
// alongside it as the same object, so the deferred chunk can switch
// index.ts's import over without a behavior change.
import { DEFAULT_DASHBOARD_PORT } from "@ax/lib/dashboard-port";
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { serveDashboard } from "../../dashboard/server.ts";
import { serveMcp } from "../../mcp/server.ts";
import type { RuntimeManifest } from "./manifest.ts";

export const serveCommand = Command.make(
    "studio",
    { port: Flag.integer("port").pipe(Flag.withDefault(DEFAULT_DASHBOARD_PORT)) },
    ({ port }) => Effect.promise(() => serveDashboard([`--port=${port}`])),
).pipe(
    Command.withDescription(
        "Open the local web studio over the published snapshot - binds a port while a client is connected, exits on its own afterward",
    ),
);

/** Same object as {@link serveCommand} - see the module doc for why the CLI
 *  registration still imports it under the older name. */
export const studioCommand = serveCommand;

// Manages its own long-lived ManagedRuntime (like studio), so it is deliberately
// NOT in DB_COMMANDS - it routes through `withoutDb` and builds AppLayer itself.
export const mcpCommand = Command.make(
    "mcp",
    {},
    () => Effect.promise(() => serveMcp([])),
).pipe(Command.withDescription("Run an MCP server (stdio) exposing ax's read-only queries"));

// Unaffected by studio ephemeral: the interactive TERMINAL dashboard is a
// separate feature from the web studio, manages its own CacheRead-backed
// AppLayer scope (ported off SurrealDB by the earlier c-read-dashboard
// chunk), and was never tied to `ax serve`'s daemon lifecycle - it opens,
// runs, and closes within one invocation regardless of what this file does.
export const tuiCommand = Command.make("tui", {}, () =>
    Effect.promise(async () => {
        // Dynamic import keeps React/opentui out of the load path for
        // non-TUI commands.
        const { runTui } = await import("../../tui/index.tsx");
        await runTui();
    }),
).pipe(Command.withDescription("Open the interactive dashboard"));

export const serveRuntime: RuntimeManifest = {
    studio: "none",
    mcp: "none",
    // NOT flipped to "cache" here even though the TUI now reads via
    // CacheRead - Ruling R34 defers the whole-branch RUNTIME_BY_COMMAND
    // review to its own chunk; this file only renames the studio verb.
    tui: "db",
};
