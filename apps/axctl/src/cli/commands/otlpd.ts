import { DEFAULT_DASHBOARD_PORT } from "@ax/lib/dashboard-port";
import { Console, Effect, FileSystem, Path, PlatformError } from "effect";
import { Command } from "effect/unstable/cli";
import { isAddrInUse } from "../../dashboard/host-guard.ts";
import {
    OtlpSpoolServerError,
    startOtlpSpoolServer,
    type StartOtlpSpoolServerOptions,
} from "../../otel/spool-server.ts";
import type { RuntimeManifest } from "./manifest.ts";

/**
 * One-line, no-stack-trace message for an otlpd port collision - mirrors
 * `ax studio`'s `formatStudioPortBusy` (cli/banner.ts), but names
 * `ax studio` specifically: its contract still ALSO registers the /v1/*
 * OTLP endpoints (dashboard/contract/otel.ts, unchanged by studio ephemeral -
 * removing that duplication is a separate cutover this chunk did not take
 * on), so it's the likely current owner if it happened to be running on this
 * port when otlpd started.
 */
export function formatOtlpdPortBusy(port: number): string {
    return [
        `[ax] otlpd: port ${port} is already in use.`,
        "  ax studio may already own it - it runs its own OTLP receiver on this port until the otlpd cutover",
        `  see who holds it  lsof -nP -iTCP:${port} -sTCP:LISTEN`,
    ].join("\n");
}

/**
 * Run the receiver until interrupted. A port collision (EADDRINUSE) is
 * reported as a clean one-line message + exit code 1 instead of an
 * `axctl error:` stack dump - the common cause is `ax serve` already
 * holding the port, not a genuine crash.
 */
export const runOtlpd = (
    opts: StartOtlpSpoolServerOptions = {},
): Effect.Effect<
    void,
    OtlpSpoolServerError | PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
> =>
    Effect.acquireUseRelease(
        startOtlpSpoolServer(opts),
        (server) => Console.log(`ax otlpd listening on ${server.url}`).pipe(
            Effect.andThen(Effect.never),
        ),
        (server) => Effect.promise(() => server.stop()),
    ).pipe(
        Effect.catchTag("OtlpSpoolServerError", (error) =>
            isAddrInUse(error.cause)
                ? Effect.sync(() => {
                    console.error(formatOtlpdPortBusy(opts.port ?? DEFAULT_DASHBOARD_PORT));
                    process.exitCode = 1;
                })
                : Effect.fail(error),
        ),
    );

export const otlpdCommand = Command.make("otlpd", {}, () => runOtlpd()).pipe(
    Command.withDescription("Receive OTLP JSON and append it to the local spool"),
);

export const otlpdRuntime: RuntimeManifest = {
    otlpd: "none",
};
