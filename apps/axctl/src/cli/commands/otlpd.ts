import { Console, Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { startOtlpSpoolServer } from "../../otel/spool-server.ts";
import type { RuntimeManifest } from "./manifest.ts";

export const otlpdCommand = Command.make("otlpd", {}, () =>
    Effect.acquireUseRelease(
        startOtlpSpoolServer(),
        (server) => Console.log(`ax otlpd listening on ${server.url}`).pipe(
            Effect.andThen(Effect.never),
        ),
        (server) => Effect.promise(() => server.stop()),
    ),
).pipe(Command.withDescription("Receive OTLP JSON and append it to the local spool"));

export const otlpdRuntime: RuntimeManifest = {
    otlpd: "none",
};
