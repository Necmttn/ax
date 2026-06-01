import { Context, Effect, Exit, Layer, Scope } from "effect";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { AppLayer } from "@ax/lib/layers";
import { App } from "./App.tsx";

/**
 * TUI entry. Acquires the SurrealClient via the application Layer (so the
 * connection is opened once and reused for every hook), boots the OpenTUI
 * CLI renderer, and tears both down cleanly on exit.
 *
 * We don't keep an Effect runtime alive for the React tree. Instead we
 * snapshot the `SurrealClient` service into a plain object once the layer
 * is built, and propagate that into hooks via React props. Each hook calls
 * `Effect.runPromise(client.query(...))` which still goes through Effect
 * for typed errors, but the lifetime is managed by us.
 */
export async function runTui(): Promise<void> {
    const scope = await Effect.runPromise(Scope.make());

    let client: SurrealClientShape;
    try {
        const context = await Effect.runPromise(
            Layer.buildWithScope(AppLayer, scope) as Effect.Effect<
                Context.Context<SurrealClient>,
                unknown
            >,
        );
        client = Context.get(context, SurrealClient);
    } catch (err) {
        await Effect.runPromise(Scope.close(scope, Exit.void));
        throw err;
    }

    const renderer = await createCliRenderer({ exitOnCtrlC: false });
    const root = createRoot(renderer);

    let cleaningUp = false;
    const cleanup = async (): Promise<void> => {
        if (cleaningUp) return;
        cleaningUp = true;
        try {
            root.unmount();
        } catch {
            /* best effort */
        }
        try {
            // Drops alt-screen, restores cursor, releases stdin handlers.
            (renderer as { destroy?: () => void }).destroy?.();
        } catch {
            /* best effort */
        }
        try {
            await Effect.runPromise(Scope.close(scope, Exit.void));
        } catch {
            /* best effort */
        }
    };

    const onQuit = (): void => {
        void cleanup().finally(() => process.exit(0));
    };

    // Belt-and-suspenders: catch signals so the terminal is restored even
    // if React throws or the user ctrl-c's outside our keyboard handler.
    const onSignal = (): void => onQuit();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    // The App component intentionally takes a plain shape (not the Service
    // tag) so it can be rendered without an Effect runtime.
    const { createElement } = await import("react");
    root.render(createElement(App, { client, onQuit }));
}
