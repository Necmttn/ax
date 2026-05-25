import { Layer } from "effect";
import { AxConfigLive } from "./config.ts";
import { SurrealClientLive } from "./db.ts";
import { ProcessServiceLive } from "./process.ts";

/**
 * Composed application layer. Provides `AxConfig` (env snapshot),
 * `ProcessService` (Bun.spawn wrapper), and the `SurrealClient` (which
 * depends on AxConfig). Future services merge in here.
 */
export const AppLayer = Layer.provide(SurrealClientLive, AxConfigLive).pipe(
    Layer.merge(AxConfigLive),
    Layer.merge(ProcessServiceLive),
);
